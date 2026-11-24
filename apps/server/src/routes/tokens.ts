import {
  type ApiToken,
  ApiTokenSchema,
  CreateApiTokenRequestSchema,
  CreatedApiTokenSchema,
  ErrorSchema,
  hasScope,
  type Scope,
} from '@bmm/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth, TOKEN_PREFIX } from '../auth.js';
import type { AppContext } from '../context.js';
import { apiTokens } from '../db/schema.js';
import { randomToken, sha256, uuidv7 } from '../lib/crypto.js';
import { forbidden, notFound } from '../lib/errors.js';

function toToken(t: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes as Scope[],
    profileIds: t.profileIds ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

export function tokenRoutes(ctx: AppContext) {
  return async (root: FastifyInstance) => {
    const app = root.withTypeProvider<ZodTypeProvider>();
    const tags = ['tokens'];
    const security: Record<string, string[]>[] = [{ bearer: [] }, { session: [] }];

    app.get(
      '/tokens',
      {
        preHandler: requireAuth('tokens:read'),
        schema: {
          tags,
          security,
          summary: 'List API tokens',
          description: 'Active tokens only. Secrets are never returned; the prefix is there to recognise a token by.',
          response: { 200: z.object({ items: z.array(ApiTokenSchema) }), 401: ErrorSchema, 403: ErrorSchema },
        },
      },
      async (req) => {
        const rows = await ctx.db
          .select()
          .from(apiTokens)
          .where(
            and(eq(apiTokens.userId, (req.auth as NonNullable<typeof req.auth>).user.id), isNull(apiTokens.revokedAt)),
          )
          .orderBy(desc(apiTokens.id));
        return { items: rows.map(toToken) };
      },
    );

    app.post(
      '/tokens',
      {
        preHandler: requireAuth('tokens:write'),
        schema: {
          tags,
          security,
          summary: 'Create an API token',
          description:
            'The secret is in the response and is shown this once. A token can only grant scopes and profiles its creator holds, so a limited token cannot mint a stronger one.',
          body: CreateApiTokenRequestSchema,
          response: { 201: CreatedApiTokenSchema, 401: ErrorSchema, 403: ErrorSchema },
        },
      },
      async (req, reply) => {
        const a = req.auth as NonNullable<typeof req.auth>;
        const missing = req.body.scopes.filter((s) => !hasScope(a.scopes, s));
        if (missing.length) throw forbidden(`Cannot grant scopes the caller lacks: ${missing.join(', ')}`);
        let profileIds = req.body.profileIds ?? null;
        if (a.profileIds) {
          if (!profileIds) profileIds = a.profileIds;
          else if (profileIds.some((p) => !a.profileIds?.includes(p))) {
            throw forbidden('Cannot grant profiles the caller is not limited to');
          }
        }
        const secret = TOKEN_PREFIX + randomToken();
        const [row] = await ctx.db
          .insert(apiTokens)
          .values({
            id: uuidv7(),
            userId: a.user.id,
            name: req.body.name,
            prefix: secret.slice(0, TOKEN_PREFIX.length + 6),
            tokenHash: sha256(secret),
            scopes: [...new Set(req.body.scopes)],
            profileIds,
            expiresAt: req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86_400_000) : null,
          })
          .returning();
        if (!row) throw new Error('insert returned nothing');
        await audit(ctx, req, {
          action: 'token.created',
          targetType: 'token',
          targetId: row.id,
          metadata: { name: row.name, scopes: row.scopes, profileIds: row.profileIds, expiresAt: row.expiresAt },
        });
        return reply.code(201).send({ ...toToken(row), token: secret });
      },
    );

    app.delete(
      '/tokens/:id',
      {
        preHandler: requireAuth('tokens:write'),
        schema: {
          tags,
          security,
          summary: 'Revoke an API token',
          description: 'Takes effect on the next request made with it.',
          params: z.object({ id: z.string() }),
          response: { 204: z.null(), 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
        },
      },
      async (req, reply) => {
        const a = req.auth as NonNullable<typeof req.auth>;
        const [row] = await ctx.db
          .update(apiTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiTokens.id, req.params.id), eq(apiTokens.userId, a.user.id), isNull(apiTokens.revokedAt)))
          .returning();
        if (!row) throw notFound('No such token');
        await audit(ctx, req, {
          action: 'token.revoked',
          targetType: 'token',
          targetId: row.id,
          metadata: { name: row.name },
        });
        return reply.code(204).send(null);
      },
    );
  };
}
