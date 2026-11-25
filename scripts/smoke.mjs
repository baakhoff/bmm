// End-to-end check against a running, freshly started BMM:
//   node scripts/smoke.mjs http://localhost:3000
// Creates the admin, signs in, mints a token and uses it. Exits non-zero on
// the first surprise. CI runs it against Postgres and against the image.
const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
let cookie = '';

async function call(method, path, { body, token, expect = 200 } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : cookie ? { cookie } : {}),
      ...(method !== 'GET' && !token ? { origin: base } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const set = res.headers.getSetCookie?.().find((c) => c.startsWith('bmm_session='));
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  if (res.status !== expect) {
    throw new Error(`${method} ${path}: expected ${expect}, got ${res.status}: ${text.slice(0, 300)}`);
  }
  const type = res.headers.get('content-type') ?? '';
  return type.includes('json') ? JSON.parse(text) : text;
}

async function waitUntilReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/readyz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${base}/readyz did not answer within 60s`);
}

function check(cond, what) {
  if (!cond) throw new Error(`check failed: ${what}`);
  console.log(`ok  ${what}`);
}

await waitUntilReady();
const status = await call('GET', '/api/v1/auth/status');
check(status.setupRequired === true, 'fresh instance asks for setup');

await call('POST', '/api/v1/auth/setup', { body: { username: 'smoke', password: 'smoke test password' }, expect: 201 });
const me = await call('GET', '/api/v1/auth/me');
check(me.via === 'session' && me.user.username === 'smoke', 'setup signs the admin in');

const created = await call('POST', '/api/v1/tokens', { body: { name: 'smoke', scopes: ['audit:read'] }, expect: 201 });
check(created.token.startsWith('bmm_'), 'token is created');

const viaToken = await call('GET', '/api/v1/auth/me', { token: created.token });
check(viaToken.via === 'token' && viaToken.scopes.join() === 'audit:read', 'token authenticates with its scopes');
await call('GET', '/api/v1/tokens', { token: created.token, expect: 403 });
check(true, 'token is refused outside its scopes');

const audit = await call('GET', '/api/v1/audit', { token: created.token });
check(
  audit.items.some((e) => e.action === 'token.created') && audit.items.some((e) => e.action === 'auth.setup'),
  'audit log recorded setup and token creation',
);

await call('POST', '/api/v1/auth/logout', { expect: 204 });
await call('GET', '/api/v1/auth/me', { expect: 401 });
await call('POST', '/api/v1/auth/login', { body: { username: 'smoke', password: 'smoke test password' } });
check((await call('GET', '/api/v1/auth/me')).via === 'session', 'password sign-in works after sign-out');

// A 2x2 PNG: decoding it proves the native image library works on this architecture.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWOQj3KUj3JkgFAAE94C6Vcb8PwAAAAASUVORK5CYII=';
const profile = await call('POST', '/api/v1/profiles', { body: { name: 'Smoke' }, expect: 201 });
const media = await call('POST', '/api/v1/media/import', {
  body: { profileId: profile.id, dataBase64: png, filename: 'dot.png', alt: 'A dot' },
  expect: 201,
});
check(media.width === 2 && media.mime === 'image/png', 'an image is read and stored');
const draft = await call('POST', '/api/v1/posts', {
  body: { profileId: profile.id, text: 'smoke', mediaIds: [media.id] },
  expect: 201,
});
check(draft.status === 'draft' && draft.media.length === 1, 'a draft post is saved with its image');
const networks = await call('GET', '/api/v1/networks');
check(
  networks.apps.length === 2 && networks.apps.every((a) => a.configured === false),
  'networks report as not yet set up',
);

const admin = await call('POST', '/api/v1/tokens', { body: { name: 'smoke-mcp', scopes: ['admin'] }, expect: 201 });
const mcp = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${admin.token}`,
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'list_profiles', arguments: {} },
  }),
});
const mcpBody = await mcp.json();
check(
  mcp.status === 200 && mcpBody.result?.structuredContent?.items?.[0]?.name === 'Smoke',
  'the MCP server answers a tool call',
);

const spec = await call('GET', '/api/v1/openapi.json');
check(Boolean(spec.paths['/api/v1/tokens']), 'OpenAPI document is served');

if (process.argv.includes('--web')) {
  const html = await call('GET', '/login');
  check(typeof html === 'string' && html.includes('<div id="root">'), 'web UI is served on client-side routes');
}
console.log('smoke test passed');
