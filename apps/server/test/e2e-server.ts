// A complete BMM with stand-in networks, for trying the web UI by hand or
// driving it from a browser test:  pnpm tsx test/e2e-server.ts
// Nothing leaves the machine; "connecting" an account approves instantly.
import { createServer } from 'node:http';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryStorage } from '../src/lib/storage.js';
import { ENDPOINTS, FakeNetworks } from './fakes.js';

const port = Number(process.env.PORT ?? 3920);
const consentPort = port + 1;
const base = `http://127.0.0.1:${port}`;
const net = new FakeNetworks();

// Plays the networks' consent screens: approves and sends the browser back.
createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${consentPort}`);
  const back = new URL(url.searchParams.get('redirect_uri') ?? base);
  back.searchParams.set('state', url.searchParams.get('state') ?? '');
  if (url.pathname.startsWith('/x')) {
    const code = `x-code-${Date.now()}`;
    net.xChallenges.set(code, url.searchParams.get('code_challenge') ?? '');
    back.searchParams.set('code', code);
  } else {
    back.searchParams.set('code', 'ig-code');
  }
  res.writeHead(302, { location: back.toString() }).end();
}).listen(consentPort, '127.0.0.1');

const app = await buildApp(
  loadConfig({
    DATABASE_URL: 'pglite://memory',
    BMM_HOST: '127.0.0.1',
    BMM_PORT: String(port),
    BMM_PUBLIC_URL: base,
    BMM_PUBLIC_MEDIA_URL: process.env.NO_PUBLIC_MEDIA ? '' : 'https://media.example.com',
    BMM_SECRET_KEY: 'e2e',
    BMM_UPDATE_CHECK: 'false',
    BMM_WEB_DIR: '../web/dist',
    BMM_LOG_LEVEL: 'warn',
  }),
  {
    fetch: net.fetch,
    storage: new MemoryStorage(),
    pollIntervalMs: 50,
    endpoints: {
      ...ENDPOINTS,
      xAuthorize: `http://127.0.0.1:${consentPort}/x/authorize`,
      instagramAuthorize: `http://127.0.0.1:${consentPort}/ig/authorize`,
    },
  },
);
await app.listen({ host: '127.0.0.1', port });
console.log(`BMM with stand-in networks at ${base}. X app: x-client / x-secret. Instagram app: ig-client / ig-secret.`);
