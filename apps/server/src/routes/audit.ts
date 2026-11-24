import { AuditPageSchema, AuditQuerySchema, ErrorSchema } from '@bmm/shared';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth } from '../auth.js';
import type { AppContext } from '../context.js';
import { auditLog } from '../db/schema.js';

export function auditRoutes(ctx: AppContext) {
  return async (root: FastifyInstance) => {
    const app = root.withTypeProvider<ZodTypeProvider>();
    app.get(
      '/audit',
      {
        preHandler: requireAuth('audit:read'),
        schema: {
          tags: ['audit'],
          security: [{ bearer: [] }, { session: [] }],
          summary: 'Read the audit log, newest first',
          description: 'Page backwards by passing the last `nextBefore` as `before`.',
          querystring: AuditQuerySchema,
          response: { 200: AuditPageSchema, 401: ErrorSchema, 403: ErrorSchema },
        },
      },
      async (req) => {
        const { limit, before, action } = req.query;
        const rows = await ctx.db
          .select()
          .from(auditLog)
          .where(and(before ? lt(auditLog.id, before) : undefined, action ? eq(auditLog.action, action) : undefined))
          .orderBy(desc(auditLog.id))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        return {
          items: page.map((r) => ({
            id: r.id,
            at: r.at.toISOString(),
            actorType: r.actorType,
            actorId: r.actorId,
            actorLabel: r.actorLabel,
            action: r.action,
            targetType: r.targetType,
            targetId: r.targetId,
            ip: r.ip,
            metadata: r.metadata,
          })),
          nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
        };
      },
    );
  };
}
