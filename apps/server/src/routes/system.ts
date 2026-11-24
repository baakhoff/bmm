import { ErrorSchema, SystemVersionSchema } from '@bmm/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth } from '../auth.js';
import type { AppContext } from '../context.js';

export function systemRoutes(ctx: AppContext) {
  return async (root: FastifyInstance) => {
    const app = root.withTypeProvider<ZodTypeProvider>();
    app.get(
      '/system/version',
      {
        preHandler: requireAuth(),
        schema: {
          tags: ['system'],
          security: [{ bearer: [] }, { session: [] }],
          summary: 'The running version, and whether a newer release exists',
          description:
            '`updateAvailable` is null when unknown: the check is turned off, GitHub could not be reached, or this is a build from main rather than a release.',
          response: { 200: SystemVersionSchema, 401: ErrorSchema },
        },
      },
      async () => ctx.updates.get(),
    );
  };
}
