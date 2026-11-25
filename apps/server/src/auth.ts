import type { Scope } from '@bmm/shared';
import { hasScope } from '@bmm/shared';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { apiTokens, sessions, users } from './db/schema.js';
import { randomToken, sha256, uuidv7 } from './lib/crypto.js';
import { forbidden, unauthorized } from './lib/errors.js';

export const SESSION_COOKIE = 'bmm_session';
export const TOKEN_PREFIX = 'bmm_';
const TOUCH_INTERVAL_MS = 60_000;

export type UserRow = typeof users.$inferSelect;

export interface AuthInfo {
  user: UserRow;
  via: 'session' | 'token';
  scopes: string[];
  sessionId?: string;
  tokenId?: string;
  tokenName?: string;
  /** null: every profile. */
  profileIds: string[] | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

function isSecure(ctx: AppContext, req: FastifyRequest): boolean {
  return ctx.config.publicUrl ? ctx.config.publicUrl.protocol === 'https:' : req.protocol === 'https';
}

export async function startSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, userId: string) {
  const secret = randomToken();
  const expiresAt = new Date(Date.now() + ctx.config.sessionTtlMs);
  const id = uuidv7();
  await ctx.db.insert(sessions).values({
    id,
    userId,
    tokenHash: sha256(secret),
    expiresAt,
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
  });
  // Opportunistic clean-up; there is no scheduler yet and this is cheap.
  await ctx.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  reply.setCookie(SESSION_COOKIE, secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(ctx, req),
    path: '/',
    expires: expiresAt,
  });
  return id;
}

export async function endSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply) {
  if (req.auth?.sessionId) await ctx.db.delete(sessions).where(eq(sessions.id, req.auth.sessionId));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

async function resolveAuth(ctx: AppContext, req: FastifyRequest): Promise<AuthInfo | null> {
  const header = req.headers.authorization;
  if (header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    const secret = m?.[1];
    // A request that presents a token is judged on that token alone; it never
    // falls back to a cookie that happens to ride along.
    if (!secret?.startsWith(TOKEN_PREFIX)) throw unauthorized('Malformed API token');
    const now = new Date();
    const [row] = await ctx.db
      .select({ token: apiTokens, user: users })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(
        and(
          eq(apiTokens.tokenHash, sha256(secret)),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
        ),
      )
      .limit(1);
    if (!row) throw unauthorized('Unknown, revoked or expired API token');
    if (!row.token.lastUsedAt || now.getTime() - row.token.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await ctx.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.token.id));
    }
    return {
      user: row.user,
      via: 'token',
      scopes: row.token.scopes,
      tokenId: row.token.id,
      tokenName: row.token.name,
      profileIds: row.token.profileIds ?? null,
    };
  }
  const cookie = req.cookies[SESSION_COOKIE];
  if (!cookie) return null;
  const now = new Date();
  const [row] = await ctx.db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(cookie)), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await ctx.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id));
  }
  return { user: row.user, via: 'session', scopes: ['admin'], sessionId: row.session.id, profileIds: null };
}

/**
 * A browser attaches the session cookie to requests another site triggers.
 * SameSite=Lax already stops cross-site POSTs; this is the second lock: a
 * state-changing request carrying an Origin must carry ours.
 */
function checkOrigin(ctx: AppContext, req: FastifyRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw forbidden('Cross-site request refused');
    return;
  }
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw forbidden('Cross-site request refused');
  }
  const allowed = new Set<string>([req.host]);
  if (ctx.config.publicUrl) allowed.add(ctx.config.publicUrl.host);
  if (!allowed.has(host)) throw forbidden('Cross-site request refused');
}

export function registerAuth(app: FastifyInstance, ctx: AppContext) {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') && !/^\/mcp(\/|\?|$)/.test(req.url)) return;
    req.auth = await resolveAuth(ctx, req);
    // Token callers are not browsers acting on ambient credentials. Everything
    // else is checked, signed in or not, which also covers login and setup.
    if (req.auth?.via !== 'token') checkOrigin(ctx, req);
  });
}

/** preHandler: the caller must be signed in and, if given, hold the scope. */
export function requireAuth(scope?: Scope) {
  return async (req: FastifyRequest) => {
    if (!req.auth) throw unauthorized();
    if (scope && !hasScope(req.auth.scopes, scope)) {
      throw forbidden(`This API token lacks the "${scope}" scope`);
    }
  };
}

/** preHandler: only a signed-in person, never an API token. */
export function requireSession() {
  return async (req: FastifyRequest) => {
    if (!req.auth) throw unauthorized();
    if (req.auth.via !== 'session') throw forbidden('This needs a signed-in session, not an API token');
  };
}
