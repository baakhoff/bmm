import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { xWeightedLength } from '../src/connectors/x.js';
import { isPublicAddress } from '../src/lib/safe-fetch.js';
import {
  accountsOf,
  addImage,
  connectInstagram,
  connectX,
  image,
  makeWorld,
  newProfile,
  setApps,
  type World,
} from './fakes.js';
import { Browser, withToken } from './helpers.js';

let w: World;
afterEach(async () => {
  await w?.app.close();
});

async function token(scopes: string[], profileIds?: string[]) {
  const res = await w.admin.post('/api/v1/tokens', { name: `t-${scopes.join('+')}`, scopes, profileIds });
  return withToken(w.app, res.json().token);
}

describe('profiles', () => {
  beforeEach(async () => {
    w = await makeWorld();
  });

  it('creates, changes, lists and deletes', async () => {
    const p = await newProfile(w, 'Studio');
    expect((await w.admin.get(`/api/v1/profiles/${p.id}`)).json()).toMatchObject({
      name: 'Studio',
      timezone: 'Europe/Belgrade',
      accountCount: 0,
    });
    const changed = await w.admin.request('PATCH', `/api/v1/profiles/${p.id}`, { name: 'Studio 2', color: '#aa3300' });
    expect(changed.json()).toMatchObject({ name: 'Studio 2', color: '#aa3300', timezone: 'Europe/Belgrade' });
    expect((await w.admin.post('/api/v1/profiles', { name: 'x', timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await w.admin.get('/api/v1/profiles')).json().items).toHaveLength(1);
    expect((await w.admin.delete(`/api/v1/profiles/${p.id}`)).statusCode).toBe(204);
    expect((await w.admin.get(`/api/v1/profiles/${p.id}`)).statusCode).toBe(404);
  });

  it('hides every other profile from a profile-limited token', async () => {
    const mine = await newProfile(w, 'Mine');
    const other = await newProfile(w, 'Other');
    const call = await token(
      ['profiles:read', 'profiles:write', 'posts:read', 'posts:write', 'media:write', 'accounts:read'],
      [mine.id],
    );
    expect((await call('GET', '/api/v1/profiles')).json().items.map((p: { name: string }) => p.name)).toEqual(['Mine']);
    expect((await call('GET', `/api/v1/profiles/${other.id}`)).statusCode).toBe(404);
    expect((await call('PATCH', `/api/v1/profiles/${other.id}`, { name: 'taken' })).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/accounts?profileId=${other.id}`)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/posts?profileId=${other.id}`)).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/posts', { profileId: other.id, text: 'hi' })).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/media/import', { profileId: other.id, dataBase64: 'AAAA' })).statusCode).toBe(
      404,
    );
    expect((await call('POST', '/api/v1/profiles', { name: 'New' })).statusCode).toBe(403);
    expect((await call('PATCH', `/api/v1/profiles/${mine.id}`, { notes: 'ok' })).statusCode).toBe(200);
  });

  it('enforces scopes on the new resources', async () => {
    const p = await newProfile(w);
    const reader = await token(['profiles:read', 'posts:read']);
    expect((await reader('GET', '/api/v1/profiles')).statusCode).toBe(200);
    expect((await reader('POST', '/api/v1/profiles', { name: 'x' })).statusCode).toBe(403);
    expect((await reader('POST', '/api/v1/posts', { profileId: p.id, text: 'hi' })).statusCode).toBe(403);
    expect((await reader('GET', `/api/v1/media?profileId=${p.id}`)).statusCode).toBe(403);
    expect((await reader('GET', '/api/v1/networks')).statusCode).toBe(403);
  });
});

describe('network apps and connecting accounts', () => {
  beforeEach(async () => {
    w = await makeWorld();
  });

  it('keeps the developer app secret encrypted and never returns it', async () => {
    await setApps(w);
    const status = (await w.admin.get('/api/v1/networks')).json();
    expect(status.apps.find((a: { network: string }) => a.network === 'x')).toMatchObject({
      configured: true,
      clientId: 'x-client',
      redirectUri: 'http://bmm.test/api/v1/oauth/x/callback',
    });
    expect(JSON.stringify(status)).not.toContain('x-secret');
    const rows = await w.app.ctx.db.query.networkApps.findMany();
    expect(JSON.stringify(rows)).not.toContain('x-secret');
    const writer = await token(['accounts:write', 'accounts:read']);
    expect((await writer('PUT', '/api/v1/networks/x/app', { clientId: 'evil', clientSecret: 'evil' })).statusCode).toBe(
      403,
    );
  });

  it('connects an X account through the redirect, with PKCE, and stores its tokens encrypted', async () => {
    await setApps(w);
    const p = await newProfile(w);
    const { authorize, location } = await connectX(w, p.id);
    expect(authorize.origin + authorize.pathname).toBe('https://x.test/i/oauth2/authorize');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://bmm.test/api/v1/oauth/x/callback');
    expect(authorize.searchParams.get('scope')).toContain('media.write');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location).toBe(`/profiles/${p.id}?connected=%40nik_x`);
    expect(await accountsOf(w, p.id)).toMatchObject([{ network: 'x', username: 'nik_x', status: 'active' }]);
    const rows = await w.app.ctx.db.query.accounts.findMany();
    expect(JSON.stringify(rows)).not.toContain('x-access-1');
    expect(JSON.stringify(rows)).not.toContain('x-refresh-1');
    expect(JSON.stringify((await w.admin.get('/api/v1/accounts')).json())).not.toContain('x-access');
    expect((await w.admin.get(`/api/v1/profiles/${p.id}`)).json().accountCount).toBe(1);
  });

  it('connects an Instagram account and trades the short token for the long one', async () => {
    await setApps(w);
    const p = await newProfile(w);
    const { authorize, location } = await connectInstagram(w, p.id);
    expect(authorize.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_content_publish');
    expect(location).toBe(`/profiles/${p.id}?connected=%40nik_ig`);
    // "#_" that Instagram appends to the code was stripped before the exchange.
    expect(w.net.to('/oauth/access_token')[0]?.form?.code).toBe('ig-code');
    expect(w.net.to('/access_token')).toHaveLength(1);
    expect(await accountsOf(w, p.id)).toMatchObject([{ network: 'instagram', username: 'nik_ig' }]);
  });

  it('refuses one network account in two profiles, a replayed state, and a callback in another browser', async () => {
    await setApps(w);
    const a = await newProfile(w, 'A');
    const b = await newProfile(w, 'B');
    const first = await connectX(w, a.id);
    expect((await connectX(w, b.id)).location).toContain('already%20connected%20to%20another%20profile');
    expect(await accountsOf(w, b.id)).toHaveLength(0);

    const replay = await w.admin.get(`/api/v1/oauth/x/callback?state=${first.state}&code=${first.code}`);
    expect(replay.headers.location).toContain('expired%20or%20was%20already%20used');

    const start = await w.admin.get(`/api/v1/profiles/${b.id}/connect/x`);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const stranger = await new Browser(w.app).get(`/api/v1/oauth/x/callback?state=${state}&code=whatever`);
    expect(stranger.headers.location).toContain('connect_error=Sign%20in');
  });

  it('says what is missing when no developer app is configured', async () => {
    const p = await newProfile(w);
    const res = await w.admin.get(`/api/v1/profiles/${p.id}/connect/x`);
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location as string)).toContain('No developer app is configured for x');
  });

  it('will not start a connection for an API token', async () => {
    await setApps(w);
    const p = await newProfile(w);
    const call = await token(['admin']);
    expect((await call('GET', `/api/v1/profiles/${p.id}/connect/x`)).statusCode).toBe(403);
  });
});

describe('media', () => {
  beforeEach(async () => {
    w = await makeWorld();
  });

  it('accepts a multipart upload and reads the real type and size from the bytes', async () => {
    const p = await newProfile(w);
    const data = await image(640, 480, 'jpeg');
    const boundary = 'xBMMx';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="profileId"\r\n\r\n${p.id}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="alt"\r\n\r\nA test card\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../etc/lying.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await w.admin.request('POST', '/api/v1/media', body, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    });
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m).toMatchObject({
      mime: 'image/jpeg',
      width: 640,
      height: 480,
      alt: 'A test card',
      filename: 'lying.png',
      bytes: data.length,
    });
    const content = await w.admin.get(m.contentUrl);
    expect(content.headers['content-type']).toBe('image/jpeg');
    expect(content.rawPayload.equals(data)).toBe(true);
    expect((await new Browser(w.app).get(m.contentUrl)).statusCode).toBe(401);
  });

  it('refuses what is not an image', async () => {
    const p = await newProfile(w);
    const res = await w.admin.post('/api/v1/media/import', {
      profileId: p.id,
      dataBase64: Buffer.from('<svg onload=alert(1)>').toString('base64'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('JPEG, PNG or WebP');
    expect((await w.admin.post('/api/v1/media/import', { profileId: p.id })).statusCode).toBe(400);
  });

  it('imports from a public URL and refuses addresses inside a private network', async () => {
    const p = await newProfile(w);
    const png = await image(800, 800);
    w.net.overrides.push({
      match: (c) => c.url.host === 'cdn.example.org',
      respond: () => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } }),
    });
    const ok = await w.admin.post('/api/v1/media/import', {
      profileId: p.id,
      url: 'https://cdn.example.org/photos/launch.png',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ filename: 'launch.png', width: 800 });

    const before = w.net.calls.length;
    for (const url of [
      'http://internal.example/secret.png',
      'http://127.0.0.1:3000/x.png',
      'http://[::1]/x.png',
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
    ]) {
      const res = await w.admin.post('/api/v1/media/import', { profileId: p.id, url });
      expect(res.statusCode, url).toBe(400);
    }
    expect(w.net.calls.length).toBe(before);

    // A public address that redirects inward is stopped at the redirect.
    w.net.overrides.push({
      match: (c) => c.url.host === 'sneaky.example.org',
      respond: () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/admin' } }),
    });
    const sneaky = await w.admin.post('/api/v1/media/import', {
      profileId: p.id,
      url: 'https://sneaky.example.org/a.png',
    });
    expect(sneaky.statusCode).toBe(400);
    expect(w.net.calls.filter((c) => c.url.host === '10.0.0.5')).toHaveLength(0);
  });

  it('knows which addresses are private', () => {
    for (const ip of [
      '10.1.2.3',
      '192.168.68.1',
      '172.20.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '0.0.0.0',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8'])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('serves the public JPEG only for a valid, unexpired signature', async () => {
    const p = await newProfile(w);
    const m = await addImage(w, p.id);
    const { publicJpegUrl } = await import('../src/services/media.js');
    const url = new URL(publicJpegUrl(w.app.ctx, m.id) as string);
    expect(url.origin).toBe('https://media.example.com');
    const good = await w.app.inject(url.pathname);
    expect(good.statusCode).toBe(200);
    expect(good.headers['content-type']).toBe('image/jpeg');
    expect(good.rawPayload.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    const parts = url.pathname.split('/');
    const tampered = [...parts.slice(0, 4), String(Number(parts[4]) + 9999), parts[5]].join('/');
    expect((await w.app.inject(tampered)).statusCode).toBe(404);
    expect((await w.app.inject(url.pathname.replace(m.id, '00000000-0000-7000-8000-000000000000'))).statusCode).toBe(
      404,
    );
    w.clock.advance(3 * 3_600_000);
    expect((await w.app.inject(url.pathname)).statusCode).toBe(404);
  });
});

describe('validation', () => {
  it('counts the way X does', () => {
    expect(xWeightedLength('hello')).toBe(5);
    expect(xWeightedLength('see https://example.com/a/very/long/path/that/goes/on?and=on')).toBe(4 + 23);
    expect(xWeightedLength('日本語')).toBe(6);
    expect(xWeightedLength('👍')).toBe(2);
  });

  it('reports per account what each network would refuse', async () => {
    w = await makeWorld({ BMM_PUBLIC_MEDIA_URL: '' });
    await setApps(w);
    const p = await newProfile(w);
    await connectX(w, p.id);
    await connectInstagram(w, p.id);
    const [x, ig] = await accountsOf(w, p.id);
    const wide = await addImage(w, p.id, 2000, 500);
    const check = async (body: object) =>
      (await w.admin.post('/api/v1/posts/validate', { profileId: p.id, ...body })).json();

    const none = await check({ text: 'hi' });
    expect(none.ok).toBe(false);
    expect(none.issues[0].code).toBe('no_targets');

    const textOnly = await check({ text: 'hello', targets: [{ accountId: x?.id }, { accountId: ig?.id }] });
    expect(textOnly.issues.map((i: { code: string; network: string }) => `${i.network}:${i.code}`)).toEqual([
      'instagram:instagram_needs_image',
    ]);

    const withImage = await check({
      text: 'x'.repeat(300),
      mediaIds: [wide.id],
      targets: [{ accountId: x?.id }, { accountId: ig?.id, text: `${'#tag '.repeat(31)}` }],
    });
    const codes = withImage.issues.map((i: { code: string; level: string }) => `${i.level}:${i.code}`);
    expect(codes).toEqual([
      'warning:x_long',
      'error:instagram_hashtags',
      'error:instagram_aspect_ratio',
      'error:instagram_public_media_missing',
    ]);
    expect(withImage.issues.find((i: { code: string }) => i.code === 'instagram_aspect_ratio').message).toContain(
      '2000×500',
    );

    expect((await check({ text: '', targets: [{ accountId: x?.id }] })).issues[0].code).toBe('x_empty');
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => addImage(w, p.id, 100, 100)));
    expect(
      (await check({ text: 'a', mediaIds: five.map((m) => m.id), targets: [{ accountId: x?.id }] })).issues[0].code,
    ).toBe('x_too_many_images');
    expect((await check({ text: 'read https://example.com', targets: [{ accountId: x?.id }] })).issues).toMatchObject([
      { level: 'warning', code: 'x_link_cost' },
    ]);

    // Scheduling a post with errors is refused, with the reasons; a draft is not.
    const refused = await w.admin.post('/api/v1/posts', {
      profileId: p.id,
      text: 'hello',
      targets: [{ accountId: ig?.id }],
      action: 'publish',
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toContain('add at least one image');
    const draft = await w.admin.post('/api/v1/posts', {
      profileId: p.id,
      text: 'hello',
      targets: [{ accountId: ig?.id }],
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().status).toBe('draft');
  });

  it('rejects accounts and media from another profile', async () => {
    w = await makeWorld();
    await setApps(w);
    const a = await newProfile(w, 'A');
    const b = await newProfile(w, 'B');
    await connectX(w, a.id);
    const [x] = await accountsOf(w, a.id);
    const m = await addImage(w, a.id);
    const res = await w.admin.post('/api/v1/posts', { profileId: b.id, text: 'hi', targets: [{ accountId: x?.id }] });
    expect(res.statusCode).toBe(400);
    expect((await w.admin.post('/api/v1/posts', { profileId: b.id, text: 'hi', mediaIds: [m.id] })).statusCode).toBe(
      400,
    );
  });
});
