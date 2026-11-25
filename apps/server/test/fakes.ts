import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { App, AppDeps } from '../src/app.js';
import { Browser, makeApp, ORIGIN } from './helpers.js';

export const ENDPOINTS = {
  xApi: 'https://x-api.test',
  xAuthorize: 'https://x.test/i/oauth2/authorize',
  instagramAuthorize: 'https://ig.test/oauth/authorize',
  instagramOauth: 'https://ig-oauth.test',
  instagramGraph: 'https://ig-graph.test',
};

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  json?: Record<string, unknown>;
  form?: Record<string, string>;
  files?: Record<string, { name: string; type: string; bytes: number }>;
}

/**
 * Stand-ins for X and Instagram: enough of each API to connect an account
 * and publish, recording every call, with switches to make them misbehave.
 */
export class FakeNetworks {
  calls: Call[] = [];
  /** code -> PKCE challenge the authorize step was given, so the token step can check the verifier. */
  xChallenges = new Map<string, string>();
  xUser = { id: '1001', name: 'Nik', username: 'nik_x', profile_image_url: 'https://pbs.test/a.jpg' };
  igUser = { user_id: '2002', username: 'nik_ig', name: 'Nik IG', account_type: 'BUSINESS' };
  xAccess = 'x-access-1';
  xRefresh = 'x-refresh-1';
  /** Responses to give instead of the normal one, first match wins and is used once. */
  overrides: { match: (c: Call) => boolean; respond: () => Response | Promise<Response> }[] = [];
  igContainers = new Map<string, Record<string, string>>();
  private n = 0;

  failOnce(match: (c: Call) => boolean, status: number, body: unknown) {
    this.overrides.push({ match, respond: () => Response.json(body, { status }) });
  }
  dropOnce(match: (c: Call) => boolean) {
    this.overrides.push({
      match,
      respond: () => {
        throw new TypeError('fetch failed: socket hang up');
      },
    });
  }
  to(path: string, method?: string) {
    return this.calls.filter((c) => c.url.pathname === path && (!method || c.method === method));
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers) };
    const body = init?.body;
    if (typeof body === 'string') call.json = JSON.parse(body);
    else if (body instanceof URLSearchParams) call.form = Object.fromEntries(body);
    else if (body instanceof FormData) {
      call.form = {};
      call.files = {};
      for (const [k, v] of body) {
        if (typeof v === 'string') call.form[k] = v;
        else call.files[k] = { name: (v as File).name, type: v.type, bytes: v.size };
      }
    }
    this.calls.push(call);
    const i = this.overrides.findIndex((o) => o.match(call));
    if (i >= 0) return (this.overrides.splice(i, 1)[0] as (typeof this.overrides)[number]).respond();
    return this.route(call);
  }) as typeof fetch;

  private route(c: Call): Response {
    const { url } = c;
    const p = url.pathname;
    if (url.origin === ENDPOINTS.xApi) {
      const bearer = c.headers.get('authorization');
      if (p === '/2/oauth2/token') {
        const basic = Buffer.from('x-client:x-secret').toString('base64');
        if (bearer !== `Basic ${basic}`) return Response.json({ error: 'invalid_client' }, { status: 401 });
        if (c.form?.grant_type === 'authorization_code') {
          const challenge = this.xChallenges.get(c.form.code ?? '');
          const given = createHash('sha256')
            .update(c.form.code_verifier ?? '')
            .digest('base64url');
          if (!challenge || challenge !== given) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        } else if (c.form?.grant_type === 'refresh_token') {
          if (c.form.refresh_token !== this.xRefresh) {
            return Response.json(
              { error: 'invalid_grant', error_description: 'Value passed for the token was invalid.' },
              { status: 400 },
            );
          }
          this.n++;
          this.xAccess = `x-access-r${this.n}`;
          this.xRefresh = `x-refresh-r${this.n}`;
        }
        return Response.json({
          token_type: 'bearer',
          expires_in: 7200,
          access_token: this.xAccess,
          refresh_token: this.xRefresh,
          scope: 'tweet.read tweet.write users.read media.write offline.access',
        });
      }
      if (bearer !== `Bearer ${this.xAccess}`)
        return Response.json({ title: 'Unauthorized', detail: 'Unauthorized', status: 401 }, { status: 401 });
      if (p === '/2/users/me') return Response.json({ data: this.xUser });
      if (p === '/2/media/upload') return Response.json({ data: { id: `m${++this.n}`, media_key: `3_${this.n}` } });
      if (p === '/2/media/metadata') return Response.json({ data: { id: c.json?.id } });
      if (p === '/2/tweets')
        return Response.json({ data: { id: `t${++this.n}`, text: c.json?.text } }, { status: 201 });
    }
    if (url.origin === ENDPOINTS.instagramOauth && p === '/oauth/access_token') {
      if (c.form?.client_secret !== 'ig-secret' || c.form?.code !== 'ig-code') {
        return Response.json(
          { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' },
          { status: 400 },
        );
      }
      return Response.json({
        data: [{ access_token: 'ig-short', user_id: this.igUser.user_id, permissions: 'instagram_business_basic' }],
      });
    }
    if (url.origin === ENDPOINTS.instagramGraph) {
      const q = url.searchParams;
      if (p === '/access_token') {
        if (q.get('access_token') !== 'ig-short' || q.get('client_secret') !== 'ig-secret')
          return this.igError(190, 'Invalid token', 400);
        return Response.json({ access_token: 'ig-long-1', token_type: 'bearer', expires_in: 60 * 86400 });
      }
      if (p === '/refresh_access_token')
        return Response.json({ access_token: 'ig-long-2', token_type: 'bearer', expires_in: 60 * 86400 });
      const token = c.headers.get('authorization');
      if (token !== 'Bearer ig-long-1' && token !== 'Bearer ig-long-2')
        return this.igError(190, 'Error validating access token', 401);
      if (p === '/me') return Response.json(this.igUser);
      if (p === `/${this.igUser.user_id}/media`) {
        const id = `c${++this.n}`;
        this.igContainers.set(id, c.form ?? {});
        return Response.json({ id });
      }
      if (p === `/${this.igUser.user_id}/media_publish`) {
        if (!this.igContainers.has(c.form?.creation_id ?? '')) return this.igError(100, 'Unknown container', 400);
        return Response.json({ id: `ig${++this.n}` });
      }
      const id = p.slice(1);
      if (this.igContainers.has(id)) return Response.json({ status_code: 'FINISHED', id });
      if (id.startsWith('ig')) return Response.json({ permalink: `https://www.instagram.com/p/${id}/`, id });
    }
    return Response.json({ error: `fake network has no route for ${c.method} ${url}` }, { status: 404 });
  }

  private igError(code: number, message: string, status: number) {
    return Response.json({ error: { message, type: 'OAuthException', code, fbtrace_id: 'x' } }, { status });
  }
}

export interface World {
  app: App;
  net: FakeNetworks;
  admin: Browser;
  clock: { now: Date; advance(ms: number): void };
}

export async function makeWorld(env: Record<string, string> = {}, deps: AppDeps = {}): Promise<World> {
  const net = new FakeNetworks();
  const clock = {
    now: new Date('2026-12-01T09:00:00Z'),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const app = await makeApp(
    { BMM_PUBLIC_MEDIA_URL: 'https://media.example.com', ...env },
    {
      fetch: net.fetch,
      endpoints: ENDPOINTS,
      pollIntervalMs: 1,
      now: () => clock.now,
      lookup: async (host) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']),
      ...deps,
    },
  );
  const admin = new Browser(app);
  const res = await admin.post('/api/v1/auth/setup', { username: 'admin', password: 'correct horse battery' });
  if (res.statusCode !== 201) throw new Error(res.body);
  return { app, net, admin, clock };
}

export async function setApps(w: World) {
  const a = await w.admin.request('PUT', '/api/v1/networks/x/app', { clientId: 'x-client', clientSecret: 'x-secret' });
  const b = await w.admin.request('PUT', '/api/v1/networks/instagram/app', {
    clientId: 'ig-client',
    clientSecret: 'ig-secret',
  });
  if (a.statusCode !== 204 || b.statusCode !== 204) throw new Error(a.body + b.body);
}

export async function newProfile(w: World, name = 'Nik') {
  const res = await w.admin.post('/api/v1/profiles', { name, timezone: 'Europe/Belgrade' });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json() as { id: string };
}

/** Walks the browser through connecting an X account, as the redirects would. */
export async function connectX(w: World, profileId: string, browser = w.admin) {
  const start = await browser.get(`/api/v1/profiles/${profileId}/connect/x`);
  const to = new URL(start.headers.location as string);
  const state = to.searchParams.get('state') as string;
  const code = `x-code-${state.slice(0, 6)}`;
  w.net.xChallenges.set(code, to.searchParams.get('code_challenge') as string);
  const back = await browser.get(`/api/v1/oauth/x/callback?state=${state}&code=${code}`);
  return { authorize: to, state, code, location: back.headers.location as string };
}

export async function connectInstagram(w: World, profileId: string) {
  const start = await w.admin.get(`/api/v1/profiles/${profileId}/connect/instagram`);
  const to = new URL(start.headers.location as string);
  const back = await w.admin.get(
    `/api/v1/oauth/instagram/callback?state=${to.searchParams.get('state')}&code=ig-code%23_`,
  );
  return { authorize: to, location: back.headers.location as string };
}

export async function accountsOf(w: World, profileId: string) {
  const res = await w.admin.get(`/api/v1/accounts?profileId=${profileId}`);
  return res.json().items as { id: string; network: string; username: string; status: string }[];
}

export function image(width: number, height: number, format: 'png' | 'jpeg' | 'webp' = 'png'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3a7' } })
    [format]()
    .toBuffer();
}

export async function addImage(w: World, profileId: string, width = 1080, height = 1080, alt = 'A green square') {
  const data = await image(width, height);
  const res = await w.admin.post('/api/v1/media/import', {
    profileId,
    dataBase64: data.toString('base64'),
    filename: `pic-${width}x${height}.png`,
    alt,
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json() as { id: string; width: number; height: number };
}

export { ORIGIN };
