import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { ADMIN, Browser, makeApp, setUp } from './helpers.js';

/**
 * A minimal identity provider: discovery, keys and a token endpoint that
 * checks PKCE. `identity` is whoever "signs in" next.
 */
let idp: FastifyInstance;
let issuer: string;
let identity: { sub: string; email?: string; email_verified?: boolean; preferred_username?: string };
const challenges = new Map<string, { challenge: string; nonce: string }>();

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = Fastify();
  idp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  idp.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  }));
  idp.get('/jwks', async () => ({ keys: [jwk] }));
  idp.post('/token', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const pending = challenges.get(body.code ?? '');
    const verifier = createHash('sha256')
      .update(body.code_verifier ?? '')
      .digest('base64url');
    if (!pending || verifier !== pending.challenge || body.client_secret !== 'shh') {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    const idToken = await new SignJWT({ ...identity, nonce: pending.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('bmm')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return { access_token: 'at', token_type: 'Bearer', id_token: idToken };
  });
  await idp.listen({ port: 0, host: '127.0.0.1' });
  const addr = idp.server.address();
  issuer = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await idp.close();
});

let app: App;
afterEach(async () => {
  await app?.close();
  challenges.clear();
});

const oidcEnv = (extra: Record<string, string> = {}) => ({
  BMM_OIDC_ISSUER: issuer,
  BMM_OIDC_CLIENT_ID: 'bmm',
  BMM_OIDC_CLIENT_SECRET: 'shh',
  BMM_OIDC_NAME: 'Pocket ID',
  ...extra,
});

/** Walks the browser through the provider and back, as a redirect chain would. */
async function signInAtProvider(b: Browser, startPath = '/api/v1/auth/oidc/start') {
  const start = await b.get(startPath);
  expect(start.statusCode).toBe(302);
  const auth = new URL(start.headers.location as string);
  expect(auth.origin).toBe(issuer);
  expect(auth.searchParams.get('redirect_uri')).toBe('http://bmm.test/api/v1/auth/oidc/callback');
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  const code = `code-${challenges.size}`;
  challenges.set(code, {
    challenge: auth.searchParams.get('code_challenge') as string,
    nonce: auth.searchParams.get('nonce') as string,
  });
  const state = auth.searchParams.get('state') as string;
  const cb = await b.get(`/api/v1/auth/oidc/callback?code=${code}&state=${state}`);
  expect(cb.statusCode).toBe(302);
  return { location: cb.headers.location as string, state, code };
}

describe('OIDC sign-in', () => {
  it('makes the first person through SSO the admin on a fresh instance', async () => {
    app = await makeApp(oidcEnv());
    identity = { sub: 'u-1', email: 'Nik@Example.com', email_verified: true, preferred_username: 'nik' };
    const b = new Browser(app);
    expect((await b.get('/api/v1/auth/status')).json().oidc).toEqual({ enabled: true, name: 'Pocket ID' });
    expect((await signInAtProvider(b)).location).toBe('/');
    expect((await b.get('/api/v1/auth/me')).json().user).toMatchObject({
      username: 'nik',
      email: 'nik@example.com',
      hasPassword: false,
      oidcLinked: true,
    });
    // Same identity again: signs in, creates nobody new.
    const again = new Browser(app);
    expect((await signInAtProvider(again)).location).toBe('/');
    expect(await app.ctx.db.query.users.findMany()).toHaveLength(1);
  });

  it('turns away a different identity once the admin exists', async () => {
    app = await makeApp(oidcEnv());
    identity = { sub: 'u-1', email: 'nik@example.com', email_verified: true };
    await signInAtProvider(new Browser(app));
    identity = { sub: 'u-2', email: 'someone@example.com', email_verified: true };
    const b = new Browser(app);
    expect((await signInAtProvider(b)).location).toBe('/login?error=oidc_not_linked');
    expect((await b.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('does not hand a password-created admin to whoever can sign in at the provider', async () => {
    app = await makeApp(oidcEnv());
    await setUp(app);
    identity = { sub: 'u-9', email: 'anyone@example.com', email_verified: true };
    expect((await signInAtProvider(new Browser(app))).location).toBe('/login?error=oidc_not_linked');
  });

  it('links from Settings while signed in, then SSO works and can be unlinked', async () => {
    app = await makeApp(oidcEnv());
    const b = await setUp(app);
    identity = { sub: 'u-1', email: 'nik@example.com', email_verified: true };
    expect((await signInAtProvider(b, '/api/v1/auth/oidc/link')).location).toBe('/settings?linked=1');
    expect((await b.get('/api/v1/auth/me')).json().user.oidcLinked).toBe(true);

    const sso = new Browser(app);
    expect((await signInAtProvider(sso)).location).toBe('/');
    expect((await sso.get('/api/v1/auth/me')).statusCode).toBe(200);

    expect((await b.delete('/api/v1/auth/oidc/link')).statusCode).toBe(204);
    expect((await signInAtProvider(new Browser(app))).location).toBe('/login?error=oidc_not_linked');
  });

  it('will not complete a link started by one browser in another', async () => {
    app = await makeApp(oidcEnv());
    const admin = await setUp(app);
    identity = { sub: 'attacker', email: 'attacker@example.com', email_verified: true };
    const start = await admin.get('/api/v1/auth/oidc/link');
    const auth = new URL(start.headers.location as string);
    challenges.set('c', {
      challenge: auth.searchParams.get('code_challenge') as string,
      nonce: auth.searchParams.get('nonce') as string,
    });
    const stranger = new Browser(app);
    const cb = await stranger.get(`/api/v1/auth/oidc/callback?code=c&state=${auth.searchParams.get('state')}`);
    expect(cb.headers.location).toBe('/settings?error=oidc_link_session');
    expect((await admin.get('/api/v1/auth/me')).json().user.oidcLinked).toBe(false);
  });

  it('auto-links only the identity the operator named', async () => {
    app = await makeApp(oidcEnv({ BMM_OIDC_ALLOWED_EMAIL: 'nik@example.com' }));
    await setUp(app);
    identity = { sub: 'u-3', email: 'nik@example.com', email_verified: false };
    expect((await signInAtProvider(new Browser(app))).location).toBe('/login?error=oidc_not_linked');
    identity = { sub: 'u-4', email: 'other@example.com', email_verified: true };
    expect((await signInAtProvider(new Browser(app))).location).toBe('/login?error=oidc_not_linked');
    identity = { sub: 'u-1', email: 'nik@example.com', email_verified: true };
    expect((await signInAtProvider(new Browser(app))).location).toBe('/');
  });

  it('accepts each state once and rejects unknown ones', async () => {
    app = await makeApp(oidcEnv());
    identity = { sub: 'u-1' };
    const b = new Browser(app);
    const { state, code } = await signInAtProvider(b);
    const replay = await new Browser(app).get(`/api/v1/auth/oidc/callback?code=${code}&state=${state}`);
    expect(replay.headers.location).toBe('/login?error=oidc_state');
    const forged = await new Browser(app).get('/api/v1/auth/oidc/callback?code=x&state=made-up');
    expect(forged.headers.location).toBe('/login?error=oidc_state');
  });

  it('works with password sign-in switched off, and then refuses passwords', async () => {
    app = await makeApp(oidcEnv({ BMM_PASSWORD_LOGIN: 'false' }));
    const b = new Browser(app);
    expect((await b.post('/api/v1/auth/setup', ADMIN)).statusCode).toBe(403);
    identity = { sub: 'u-1', preferred_username: 'nik' };
    expect((await signInAtProvider(b)).location).toBe('/');
    expect((await new Browser(app).post('/api/v1/auth/login', ADMIN)).statusCode).toBe(403);
    expect((await b.delete('/api/v1/auth/oidc/link')).statusCode).toBe(400);
  });

  it('respects the setup token on a fresh instance', async () => {
    app = await makeApp(oidcEnv({ BMM_SETUP_TOKEN: 't', BMM_OIDC_ALLOWED_SUBJECT: 'u-1' }));
    identity = { sub: 'u-2' };
    expect((await signInAtProvider(new Browser(app))).location).toBe('/login?error=oidc_setup_token');
    identity = { sub: 'u-1' };
    expect((await signInAtProvider(new Browser(app))).location).toBe('/');
  });

  it('answers 404 when OIDC is not configured', async () => {
    app = await makeApp();
    expect((await new Browser(app).get('/api/v1/auth/oidc/start')).statusCode).toBe(404);
  });
});
