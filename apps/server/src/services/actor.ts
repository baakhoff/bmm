import { hasScope, type Scope } from '@bmm/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AuthInfo } from '../auth.js';
import type { AppContext } from '../context.js';
import { profiles } from '../db/schema.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

/** Whoever is asking: a signed-in person or an API token, from HTTP or MCP. */
export interface Actor {
  auth: AuthInfo;
  ip: string | null;
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.auth) throw unauthorized();
  return { auth: req.auth, ip: req.ip };
}

export function need(actor: Actor, scope: Scope): void {
  if (!hasScope(actor.auth.scopes, scope)) throw forbidden(`This API token lacks the "${scope}" scope`);
}

export function label(actor: Actor): string {
  return actor.auth.via === 'token' ? `token:${actor.auth.tokenName}` : actor.auth.user.username;
}

/** Can this caller touch this profile at all? A profile-limited token sees only its own. */
export function mayUseProfile(actor: Actor, profileId: string): boolean {
  return actor.auth.profileIds === null || actor.auth.profileIds.includes(profileId);
}

/**
 * Loads a profile the caller may use. A profile outside a token's limit is
 * reported as missing, not forbidden: the token should not learn it exists.
 */
export async function useProfile(ctx: AppContext, actor: Actor, profileId: string) {
  if (!mayUseProfile(actor, profileId)) throw notFound('No such profile');
  const [row] = await ctx.db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.userId, actor.auth.user.id)))
    .limit(1);
  if (!row) throw notFound('No such profile');
  return row;
}
