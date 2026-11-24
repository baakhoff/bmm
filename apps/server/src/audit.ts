import type { FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { auditLog } from './db/schema.js';
import { uuidv7 } from './lib/crypto.js';

export interface AuditEvent {
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  /** Overrides the actor taken from the request, e.g. for a failed login. */
  actor?: { type: 'user' | 'token' | 'system' | 'anonymous'; id?: string | null; label?: string | null };
}

/**
 * Records who did what. Every state change goes through here, whether a
 * person clicked it or an agent called it, so the log answers "what did that
 * token do" without guessing.
 */
export async function audit(ctx: AppContext, req: FastifyRequest | null, event: AuditEvent): Promise<void> {
  const auth = req?.auth;
  const actor =
    event.actor ??
    (auth
      ? auth.via === 'token'
        ? { type: 'token' as const, id: auth.tokenId, label: auth.tokenName }
        : { type: 'user' as const, id: auth.user.id, label: auth.user.username }
      : { type: req ? ('anonymous' as const) : ('system' as const), id: null, label: null });
  await ctx.db.insert(auditLog).values({
    id: uuidv7(),
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    ip: req?.ip ?? null,
    metadata: event.metadata ?? {},
  });
}
