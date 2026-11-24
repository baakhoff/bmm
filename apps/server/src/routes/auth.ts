import {
  AuthStatusSchema,
  ChangePasswordRequestSchema,
  ErrorSchema,
  LoginRequestSchema,
  MeSchema,
  SetupRequestSchema,
  type User,
  UserSchema,
} from '@bmm/shared';
import { and, count, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import { endSession, requireAuth, requireSession, startSession, type UserRow } from '../auth.js';
import type { AppContext } from '../context.js';
import { sessions, users } from '../db/schema.js';
import { DUMMY_HASH, hashPassword, safeEqual, uuidv7, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';

export function toUser(u: UserRow): User {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    hasPassword: Boolean(u.passwordHash),
    oidcLinked: Boolean(u.oidcSubject),
    createdAt: u.createdAt.toISOString(),
  };
}

export async function userCount(ctx: AppContext): Promise<number> {
  const [row] = await ctx.db.select({ n: count() }).from(users);
  return row?.n ?? 0;
}

export function authRoutes(ctx: AppContext) {
  return async (root: FastifyInstance) => {
    const app = root.withTypeProvider<ZodTypeProvider>();
    const tags = ['auth'];

    app.get(
      '/auth/status',
      {
        schema: {
          tags,
          summary: 'What the sign-in screen needs to know',
          description: 'Public. Says whether the first admin still has to be created and which sign-in methods are on.',
          response: { 200: AuthStatusSchema },
        },
      },
      async () => ({
        setupRequired: (await userCount(ctx)) === 0,
        setupTokenRequired: Boolean(ctx.config.setupToken),
        passwordLoginEnabled: ctx.config.passwordLogin,
        oidc: { enabled: Boolean(ctx.config.oidc), name: ctx.config.oidc?.name ?? 'SSO' },
        version: ctx.version,
      }),
    );

    app.post(
      '/auth/setup',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
          tags,
          summary: 'Create the admin on a fresh instance',
          description: 'Works once, while no user exists. Signs the new admin in.',
          body: SetupRequestSchema,
          response: { 201: UserSchema, 403: ErrorSchema, 409: ErrorSchema },
        },
      },
      async (req, reply) => {
        if (!ctx.config.passwordLogin)
          throw forbidden('Password sign-in is off; create the admin by signing in with SSO');
        if (ctx.config.setupToken && !safeEqual(req.body.setupToken ?? '', ctx.config.setupToken)) {
          throw forbidden('Wrong setup token');
        }
        if ((await userCount(ctx)) > 0) throw conflict('This instance is already set up');
        const id = uuidv7();
        const passwordHash = await hashPassword(req.body.password);
        // The unique index on username cannot stop a second, differently named
        // admin, so the insert itself re-checks that the table is still empty.
        const inserted = await ctx.db.transaction(async (tx) => {
          const [row] = await tx.select({ n: count() }).from(users);
          if ((row?.n ?? 0) > 0) return null;
          const [u] = await tx
            .insert(users)
            .values({ id, username: req.body.username.toLowerCase(), email: req.body.email ?? null, passwordHash })
            .returning();
          return u ?? null;
        });
        if (!inserted) throw conflict('This instance is already set up');
        await startSession(ctx, req, reply, inserted.id);
        await audit(ctx, req, {
          action: 'auth.setup',
          targetType: 'user',
          targetId: inserted.id,
          actor: { type: 'user', id: inserted.id, label: inserted.username },
        });
        return reply.code(201).send(toUser(inserted));
      },
    );

    app.post(
      '/auth/login',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
          tags,
          summary: 'Sign in with username and password',
          body: LoginRequestSchema,
          response: { 200: UserSchema, 401: ErrorSchema, 403: ErrorSchema },
        },
      },
      async (req, reply) => {
        if (!ctx.config.passwordLogin) throw forbidden('Password sign-in is off on this instance');
        const username = req.body.username.toLowerCase();
        const [user] = await ctx.db.select().from(users).where(eq(users.username, username)).limit(1);
        const ok = await verifyPassword(req.body.password, user?.passwordHash ?? DUMMY_HASH);
        if (!user?.passwordHash || !ok) {
          await audit(ctx, req, {
            action: 'auth.login_failed',
            metadata: { username, method: 'password' },
            actor: { type: 'anonymous' },
          });
          throw unauthorized('Wrong username or password');
        }
        await startSession(ctx, req, reply, user.id);
        await audit(ctx, req, {
          action: 'auth.login',
          metadata: { method: 'password' },
          actor: { type: 'user', id: user.id, label: user.username },
        });
        return toUser(user);
      },
    );

    app.post(
      '/auth/logout',
      { schema: { tags, summary: 'End the current session', response: { 204: z.null() } } },
      async (req, reply) => {
        if (req.auth?.via === 'session') {
          await audit(ctx, req, { action: 'auth.logout' });
          await endSession(ctx, req, reply);
        }
        return reply.code(204).send(null);
      },
    );

    app.get(
      '/auth/me',
      {
        preHandler: requireAuth(),
        schema: {
          tags,
          summary: 'Who is calling, and with which scopes',
          description:
            'Works with a session and with an API token. An agent should call this first to learn what it may do.',
          security: [{ bearer: [] }, { session: [] }],
          response: { 200: MeSchema, 401: ErrorSchema },
        },
      },
      async (req) => {
        const a = req.auth as NonNullable<typeof req.auth>;
        return { user: toUser(a.user), via: a.via, scopes: a.scopes };
      },
    );

    app.post(
      '/auth/password',
      {
        preHandler: requireSession(),
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
          tags,
          summary: 'Set or change the password',
          description: 'Needs the current password if one is set. Signs out every other session.',
          security: [{ session: [] }],
          body: ChangePasswordRequestSchema,
          response: { 204: z.null(), 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema },
        },
      },
      async (req, reply) => {
        const a = req.auth as NonNullable<typeof req.auth>;
        if (a.user.passwordHash) {
          if (!req.body.currentPassword) throw badRequest('Current password is required');
          if (!(await verifyPassword(req.body.currentPassword, a.user.passwordHash))) {
            await audit(ctx, req, { action: 'auth.password_change_failed' });
            throw forbidden('Current password is wrong');
          }
        }
        await ctx.db
          .update(users)
          .set({ passwordHash: await hashPassword(req.body.newPassword), updatedAt: new Date() })
          .where(eq(users.id, a.user.id));
        await ctx.db
          .delete(sessions)
          .where(and(eq(sessions.userId, a.user.id), ne(sessions.id, a.sessionId as string)));
        await audit(ctx, req, { action: 'auth.password_changed' });
        return reply.code(204).send(null);
      },
    );
  };
}
