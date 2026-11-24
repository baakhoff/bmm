import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { registerAuth, SESSION_COOKIE } from './auth.js';
import { type Config, loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { openDb } from './db/client.js';
import { HttpError } from './lib/errors.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { oidcRoutes } from './routes/oidc.js';
import { systemRoutes } from './routes/system.js';
import { tokenRoutes } from './routes/tokens.js';
import { UpdateChecker } from './updates.js';

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
export const VERSION: string = process.env.BMM_VERSION || JSON.parse(readFileSync(pkgPath, 'utf8')).version;

export type App = FastifyInstance & { ctx: AppContext };

export interface AppDeps {
  /** Replaced in tests so nothing leaves the machine. */
  fetch?: typeof fetch;
}

export async function buildApp(config: Config = loadConfig(), deps: AppDeps = {}): Promise<App> {
  const dbHandle = await openDb(config.databaseUrl);
  const ctx: AppContext = {
    config,
    db: dbHandle.db,
    dbHandle,
    version: VERSION,
    updates: new UpdateChecker(VERSION, config.updateCheck, deps.fetch ?? fetch),
  };

  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const message = err.validation
        .map((v) => `${v.instancePath.replace(/^\//, '') || 'request'}: ${v.message}`)
        .join('; ');
      return reply.code(400).send({ error: { code: 'validation_failed', message } });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response did not match its schema');
      return reply.code(500).send({ error: { code: 'internal', message: 'Internal error' } });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 429 ? 'rate_limited' : 'bad_request';
      return reply.code(status).send({ error: { code, message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'BMM API',
        version: VERSION,
        description:
          'Everything the BMM web UI does goes through this API, so anything a person can click a program can call. Authenticate with an API token: `Authorization: Bearer bmm_...`.',
        license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
      },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', description: 'An API token created under Settings, API tokens' },
          session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE, description: 'The browser session' },
        },
      },
      tags: [
        { name: 'auth', description: 'Signing in and the current identity' },
        { name: 'tokens', description: 'API tokens for scripts and agents' },
        { name: 'audit', description: 'The record of every change' },
        { name: 'system', description: 'Health' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
  });

  registerAuth(app, ctx);

  app.get('/healthz', { schema: { tags: ['system'], summary: 'Liveness' } }, async () => ({ status: 'ok' }));
  app.get(
    '/readyz',
    { schema: { tags: ['system'], summary: 'Readiness: the database answers' } },
    async (_req, reply) => {
      try {
        await dbHandle.ping();
        return { status: 'ok' };
      } catch {
        return reply.code(503).send({ status: 'database unavailable' });
      }
    },
  );

  await app.register(
    async (api) => {
      await api.register(authRoutes(ctx));
      await api.register(oidcRoutes(ctx));
      await api.register(tokenRoutes(ctx));
      await api.register(auditRoutes(ctx));
      await api.register(systemRoutes(ctx));
      api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: '/api/v1' },
  );

  const webDir = config.webDir ? resolve(config.webDir) : undefined;
  const hasWeb = webDir !== undefined && existsSync(resolve(webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, maxAge: '1h', immutable: false });
  }
  app.setNotFoundHandler((req, reply) => {
    // Client-side routes (/login, /settings, ...) all load the same page.
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/')) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.addHook('onClose', async () => {
    await dbHandle.close();
  });

  return Object.assign(app, { ctx }) as unknown as App;
}
