import type { LightMyRequestResponse } from 'fastify';
import { type App, type AppDeps, buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const ORIGIN = 'http://bmm.test';

export async function makeApp(env: Record<string, string> = {}, deps: AppDeps = {}): Promise<App> {
  const app = await buildApp(
    loadConfig({
      DATABASE_URL: 'pglite://memory',
      BMM_LOG_LEVEL: 'silent',
      BMM_PUBLIC_URL: ORIGIN,
      BMM_UPDATE_CHECK: 'false',
      ...env,
    }),
    deps,
  );
  await app.ready();
  return app;
}

/** A browser stand-in: keeps cookies and sends our Origin on writes. */
export class Browser {
  cookies = new Map<string, string>();
  constructor(private readonly app: App) {}

  async request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      payload: body as object | undefined,
      headers: {
        host: 'bmm.test',
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
        ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
    });
    this.absorb(res);
    return res;
  }
  get = (url: string) => this.request('GET', url);
  post = (url: string, body?: unknown) => this.request('POST', url, body ?? {});
  delete = (url: string) => this.request('DELETE', url);

  private absorb(res: LightMyRequestResponse) {
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
  }
}

export function withToken(app: App, token: string) {
  return (method: string, url: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      payload: body as object | undefined,
      headers: { authorization: `Bearer ${token}` },
    });
}

export const ADMIN = { username: 'Admin', password: 'correct horse battery' };

export async function setUp(app: App): Promise<Browser> {
  const b = new Browser(app);
  const res = await b.post('/api/v1/auth/setup', ADMIN);
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  return b;
}
