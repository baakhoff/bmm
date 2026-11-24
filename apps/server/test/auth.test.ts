import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ADMIN, Browser, makeApp, setUp, withToken } from './helpers.js';

let app: App;
afterEach(async () => {
  await app?.close();
});

describe('first-run setup', () => {
  beforeEach(async () => {
    app = await makeApp();
  });

  it('reports setup needed, creates the admin once, and signs them in', async () => {
    const b = new Browser(app);
    expect((await b.get('/api/v1/auth/status')).json()).toMatchObject({
      setupRequired: true,
      passwordLoginEnabled: true,
    });
    expect((await b.get('/api/v1/auth/me')).statusCode).toBe(401);

    const created = await b.post('/api/v1/auth/setup', ADMIN);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ username: 'admin', hasPassword: true, oidcLinked: false });
    expect(created.body).not.toContain('scrypt');

    const me = await b.get('/api/v1/auth/me');
    expect(me.json()).toMatchObject({ via: 'session', scopes: ['admin'], user: { username: 'admin' } });
    expect((await b.get('/api/v1/auth/status')).json().setupRequired).toBe(false);

    const again = await new Browser(app).post('/api/v1/auth/setup', {
      username: 'intruder',
      password: 'another long password',
    });
    expect(again.statusCode).toBe(409);
  });

  it('rejects a weak password with a readable error', async () => {
    const res = await new Browser(app).post('/api/v1/auth/setup', { username: 'admin', password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.message).toContain('password');
  });

  it('sets the session cookie HttpOnly and SameSite=Lax', async () => {
    const res = await new Browser(app).post('/api/v1/auth/setup', ADMIN);
    const cookie = res.cookies.find((c) => c.name === 'bmm_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  });
});

describe('setup token', () => {
  it('is required when configured', async () => {
    app = await makeApp({ BMM_SETUP_TOKEN: 'let-me-in' });
    const b = new Browser(app);
    expect((await b.post('/api/v1/auth/setup', ADMIN)).statusCode).toBe(403);
    expect((await b.post('/api/v1/auth/setup', { ...ADMIN, setupToken: 'nope' })).statusCode).toBe(403);
    expect((await b.post('/api/v1/auth/setup', { ...ADMIN, setupToken: 'let-me-in' })).statusCode).toBe(201);
  });
});

describe('password sign-in', () => {
  beforeEach(async () => {
    app = await makeApp();
    await setUp(app);
  });

  it('signs in case-insensitively, and out again', async () => {
    const b = new Browser(app);
    const res = await b.post('/api/v1/auth/login', { username: 'ADMIN', password: ADMIN.password });
    expect(res.statusCode).toBe(200);
    expect((await b.get('/api/v1/auth/me')).statusCode).toBe(200);
    const stolen = b.cookies.get('bmm_session') as string;
    expect((await b.post('/api/v1/auth/logout')).statusCode).toBe(204);
    expect((await b.get('/api/v1/auth/me')).statusCode).toBe(401);
    // The server forgot the session; replaying the old cookie does nothing.
    const replay = new Browser(app);
    replay.cookies.set('bmm_session', stolen);
    expect((await replay.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const b = new Browser(app);
    const wrong = await b.post('/api/v1/auth/login', { username: 'admin', password: 'not the password' });
    const unknown = await b.post('/api/v1/auth/login', { username: 'nobody', password: 'not the password' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('rate-limits guessing', async () => {
    const b = new Browser(app);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await b.post('/api/v1/auth/login', { username: 'admin', password: `guess number ${i}` })).statusCode;
    }
    expect(last).toBe(429);
  });

  it('refuses a state-changing request from another origin', async () => {
    const b = await loginBrowser();
    const res = await b.request(
      'POST',
      '/api/v1/tokens',
      { name: 'x', scopes: ['admin'] },
      { origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
    const fetchMeta = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: `bmm_session=${b.cookies.get('bmm_session')}`, 'sec-fetch-site': 'cross-site' },
    });
    expect(fetchMeta.statusCode).toBe(403);
  });

  it('changes the password, needing the current one, and drops other sessions', async () => {
    const a = await loginBrowser();
    const other = await loginBrowser();
    expect((await a.post('/api/v1/auth/password', { newPassword: 'a brand new password' })).statusCode).toBe(400);
    expect(
      (await a.post('/api/v1/auth/password', { currentPassword: 'wrong', newPassword: 'a brand new password' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await a.post('/api/v1/auth/password', { currentPassword: ADMIN.password, newPassword: 'a brand new password' }))
        .statusCode,
    ).toBe(204);
    expect((await a.get('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await other.get('/api/v1/auth/me')).statusCode).toBe(401);
    const fresh = new Browser(app);
    expect((await fresh.post('/api/v1/auth/login', ADMIN)).statusCode).toBe(401);
    expect(
      (await fresh.post('/api/v1/auth/login', { username: 'admin', password: 'a brand new password' })).statusCode,
    ).toBe(200);
  });

  async function loginBrowser() {
    const b = new Browser(app);
    await b.post('/api/v1/auth/login', ADMIN);
    return b;
  }
});

describe('API tokens', () => {
  let b: Browser;
  beforeEach(async () => {
    app = await makeApp();
    b = await setUp(app);
  });

  it('creates a token whose secret is shown once and stored only as a hash', async () => {
    const res = await b.post('/api/v1/tokens', {
      name: 'agent',
      scopes: ['posts:read', 'audit:read'],
      expiresInDays: 30,
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.token).toMatch(/^bmm_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.token.slice(0, 10));
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const list = (await b.get('/api/v1/tokens')).json();
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.token);

    const rows = await app.ctx.db.query.apiTokens.findMany();
    expect(JSON.stringify(rows)).not.toContain(created.token);

    const me = await withToken(app, created.token)('GET', '/api/v1/auth/me');
    expect(me.json()).toMatchObject({ via: 'token', scopes: ['posts:read', 'audit:read'] });
  });

  it('enforces scopes', async () => {
    const { token } = (await b.post('/api/v1/tokens', { name: 'reader', scopes: ['audit:read'] })).json();
    const call = withToken(app, token);
    expect((await call('GET', '/api/v1/audit')).statusCode).toBe(200);
    const denied = await call('GET', '/api/v1/tokens');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain('tokens:read');
  });

  it('does not let a limited token mint a stronger one', async () => {
    const { token } = (
      await b.post('/api/v1/tokens', { name: 'minter', scopes: ['tokens:write', 'posts:read'] })
    ).json();
    const call = withToken(app, token);
    expect((await call('POST', '/api/v1/tokens', { name: 'esc', scopes: ['admin'] })).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/tokens', { name: 'esc', scopes: ['posts:write'] })).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/tokens', { name: 'same', scopes: ['posts:read'] })).statusCode).toBe(201);
  });

  it('keeps a profile-limited token from widening its profiles', async () => {
    const { token } = (
      await b.post('/api/v1/tokens', {
        name: 'one-persona',
        scopes: ['tokens:write', 'posts:read'],
        profileIds: ['p1'],
      })
    ).json();
    const call = withToken(app, token);
    expect(
      (await call('POST', '/api/v1/tokens', { name: 'wider', scopes: ['posts:read'], profileIds: ['p1', 'p2'] }))
        .statusCode,
    ).toBe(403);
    const inherited = await call('POST', '/api/v1/tokens', { name: 'child', scopes: ['posts:read'] });
    expect(inherited.json().profileIds).toEqual(['p1']);
  });

  it('stops working the moment it is revoked', async () => {
    const created = (await b.post('/api/v1/tokens', { name: 'short-lived', scopes: ['admin'] })).json();
    const call = withToken(app, created.token);
    expect((await call('GET', '/api/v1/auth/me')).statusCode).toBe(200);
    expect((await b.delete(`/api/v1/tokens/${created.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/api/v1/auth/me')).statusCode).toBe(401);
    expect((await b.delete(`/api/v1/tokens/${created.id}`)).statusCode).toBe(404);
    expect((await b.get('/api/v1/tokens')).json().items).toHaveLength(0);
  });

  it('rejects an expired token', async () => {
    const created = (await b.post('/api/v1/tokens', { name: 'old', scopes: ['admin'], expiresInDays: 1 })).json();
    const { apiTokens } = await import('../src/db/schema.js');
    await app.ctx.db.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await withToken(app, created.token)('GET', '/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('judges a request with a bad token on the token, ignoring any cookie', async () => {
    const res = await b.request('GET', '/api/v1/auth/me', undefined, { authorization: 'Bearer bmm_not-a-real-token' });
    expect(res.statusCode).toBe(401);
  });

  it('keeps session-only actions away from tokens', async () => {
    const { token } = (await b.post('/api/v1/tokens', { name: 'admin-token', scopes: ['admin'] })).json();
    const res = await withToken(app, token)('POST', '/api/v1/auth/password', { newPassword: 'taken over by a token' });
    expect(res.statusCode).toBe(403);
  });
});

describe('audit log', () => {
  it('records who did what, newest first, and pages', async () => {
    app = await makeApp();
    const b = await setUp(app);
    await new Browser(app).post('/api/v1/auth/login', { username: 'admin', password: 'wrong password!' });
    const created = (await b.post('/api/v1/tokens', { name: 'agent', scopes: ['admin'] })).json();
    await withToken(app, created.token)('POST', '/api/v1/tokens', { name: 'made-by-agent', scopes: ['posts:read'] });

    const all = (await b.get('/api/v1/audit')).json();
    expect(all.items.map((i: { action: string }) => i.action)).toEqual([
      'token.created',
      'token.created',
      'auth.login_failed',
      'auth.setup',
    ]);
    expect(all.items[0]).toMatchObject({ actorType: 'token', actorLabel: 'agent', targetType: 'token' });
    expect(all.items[1]).toMatchObject({ actorType: 'user', actorLabel: 'admin' });
    expect(all.items[2]).toMatchObject({ actorType: 'anonymous', metadata: { username: 'admin' } });
    expect(JSON.stringify(all)).not.toContain(created.token);
    expect(JSON.stringify(all)).not.toContain('wrong password!');

    const p1 = (await b.get('/api/v1/audit?limit=3')).json();
    expect(p1.items).toHaveLength(3);
    const p2 = (await b.get(`/api/v1/audit?limit=3&before=${p1.nextBefore}`)).json();
    expect(p2.items.map((i: { action: string }) => i.action)).toEqual(['auth.setup']);
    expect(p2.nextBefore).toBeNull();

    const filtered = (await b.get('/api/v1/audit?action=auth.setup')).json();
    expect(filtered.items).toHaveLength(1);
  });
});

describe('configuration', () => {
  it('refuses combinations that would lock everyone out', () => {
    expect(() => loadConfig({ BMM_PASSWORD_LOGIN: 'false' })).toThrow(/OIDC/);
    expect(() => loadConfig({ BMM_OIDC_ISSUER: 'https://id.example' })).toThrow(/both/);
    expect(() => loadConfig({ BMM_OIDC_ISSUER: 'https://id.example', BMM_OIDC_CLIENT_ID: 'x' })).toThrow(
      /BMM_PUBLIC_URL/,
    );
  });
});

describe('system endpoints', () => {
  it('serves health, readiness and an OpenAPI document covering the routes', async () => {
    app = await makeApp();
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    const spec = (await app.inject('/api/v1/openapi.json')).json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/api/v1/auth/login', '/api/v1/tokens', '/api/v1/tokens/{id}', '/api/v1/audit']),
    );
    expect(spec.paths['/api/v1/tokens'].post.requestBody).toBeDefined();
    expect((await app.inject('/api/v1/nope')).json().error.code).toBe('not_found');
  });
});
