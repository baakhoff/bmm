import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
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
import { buildConnectors } from './connectors/index.js';
import { DEFAULT_ENDPOINTS, type NetDeps } from './connectors/types.js';
import type { AppContext } from './context.js';
import { openDb } from './db/client.js';
import { HttpError } from './lib/errors.js';
import { SecretBox } from './lib/secretbox.js';
import { LocalStorage, type Storage } from './lib/storage.js';
import { registerMcp } from './mcp.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { contentRoutes } from './routes/content.js';
import { oidcRoutes } from './routes/oidc.js';
import { systemRoutes } from './routes/system.js';
import { tokenRoutes } from './routes/tokens.js';
import { MAX_UPLOAD_BYTES, publicJpeg } from './services/media.js';
import { Scheduler } from './services/scheduler.js';
import { UpdateChecker } from './updates.js';

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
export const VERSION: string = process.env.BMM_VERSION || JSON.parse(readFileSync(pkgPath, 'utf8')).version;

export type App = FastifyInstance & { ctx: AppContext };

export interface AppDeps {
  /** Replaced in tests so nothing leaves the machine. */
  fetch?: typeof fetch;
  endpoints?: Partial<NetDeps['endpoints']>;
  pollIntervalMs?: number;
  storage?: Storage;
  now?: () => Date;
  lookup?: (host: string) => Promise<string[]>;
}

export async function buildApp(config: Config = loadConfig(), deps: AppDeps = {}): Promise<App> {
  const dbHandle = await openDb(config.databaseUrl);
  const net: NetDeps = {
    fetch: deps.fetch ?? fetch,
    endpoints: { ...DEFAULT_ENDPOINTS, ...deps.endpoints },
    pollIntervalMs: deps.pollIntervalMs ?? 2000,
    now: deps.now ?? (() => new Date()),
  };
  const ctx = {
    config,
    db: dbHandle.db,
    dbHandle,
    version: VERSION,
    updates: new UpdateChecker(VERSION, config.updateCheck, deps.fetch ?? fetch),
    secrets: SecretBox.open(config.secretKey, config.dataDir),
    storage: deps.storage ?? new LocalStorage(resolve(config.dataDir, 'media')),
    net,
    connectors: buildConnectors(net),
    now: deps.now ?? (() => new Date()),
    lookup: deps.lookup ?? (async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address)),
    log: console as unknown as AppContext['log'],
  } as AppContext;
  ctx.scheduler = new Scheduler(ctx);

  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  ctx.log = app.log as unknown as AppContext['log'];
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
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });
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
        { name: 'profiles', description: 'Personas: the owners of accounts, media and posts' },
        { name: 'accounts', description: 'Networks and the accounts connected to a profile' },
        { name: 'media', description: 'Images to attach to posts' },
        { name: 'posts', description: 'Drafting, checking, scheduling and publishing' },
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
      await api.register(contentRoutes(ctx));
      api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: '/api/v1' },
  );

  // The one path meant to be reachable from the internet: signed, expiring
  // links to single images, for networks that download media by URL.
  app.get('/public/media/:id/:exp/:sig', { schema: { hide: true } }, async (req, reply) => {
    const p = req.params as { id: string; exp: string; sig: string };
    const jpeg = await publicJpeg(ctx, p.id, p.exp, p.sig.replace(/\.jpg$/, ''));
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=3600').send(jpeg);
  });

  registerMcp(app, ctx);

  const webDir = config.webDir ? resolve(config.webDir) : undefined;
  const hasWeb = webDir !== undefined && existsSync(resolve(webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, maxAge: '1h', immutable: false });
  }
  app.setNotFoundHandler((req, reply) => {
    // Client-side routes (/login, /settings, ...) all load the same page.
    if (hasWeb && req.method === 'GET' && !/^\/(api|assets|public|mcp)(\/|$)/.test(req.url)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  if (config.scheduler) ctx.scheduler.start();
  app.addHook('onClose', async () => {
    await ctx.scheduler.stop();
    await dbHandle.close();
  });

  return Object.assign(app, { ctx }) as unknown as App;
}
