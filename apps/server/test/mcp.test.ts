import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountsOf, connectInstagram, connectX, image, makeWorld, newProfile, setApps, type World } from './fakes.js';

let w: World;
let base: string;
const clients: Client[] = [];

beforeEach(async () => {
  w = await makeWorld();
  await setApps(w);
  await w.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = w.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await w?.app.close();
});

async function connect(scopes: string[], profileIds?: string[]) {
  const res = await w.admin.post('/api/v1/tokens', { name: 'agent', scopes, profileIds });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${res.json().token}` } },
    }),
  );
  clients.push(client);
  return client;
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON of many shapes
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
  if (res.isError) return { isError: true, text };
  return JSON.parse(text);
}

describe('MCP server', () => {
  it('refuses a caller without an API token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it('describes itself: instructions, and tools marked read-only or destructive', async () => {
    const client = await connect(['admin']);
    expect(client.getInstructions()).toContain('validate_post');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'whoami',
        'list_profiles',
        'create_profile',
        'list_accounts',
        'import_media',
        'validate_post',
        'create_post',
        'update_post',
        'get_post',
        'list_posts',
        'retry_post',
        'delete_post',
        'list_audit_log',
      ]),
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_post?.annotations?.readOnlyHint).toBe(true);
    expect(byName.create_post?.annotations?.readOnlyHint).toBe(false);
    expect(byName.delete_profile?.annotations?.destructiveHint).toBe(true);
    for (const t of tools) expect(t.description?.length ?? 0, t.name).toBeGreaterThan(40);
    expect(JSON.stringify(byName.create_post?.inputSchema)).toContain('scheduledAt');
  });

  it('lets an agent take a post from nothing to published', async () => {
    const p = await newProfile(w, 'Agent persona');
    await connectX(w, p.id);
    await connectInstagram(w, p.id);
    const agent = await connect([
      'profiles:read',
      'accounts:read',
      'media:read',
      'media:write',
      'posts:read',
      'posts:write',
    ]);

    expect(await call(agent, 'whoami')).toMatchObject({
      username: 'admin',
      via: 'token',
      tokenName: 'agent',
      profileIds: null,
    });
    const profiles = await call(agent, 'list_profiles');
    expect(profiles.items).toMatchObject([
      { id: p.id, name: 'Agent persona', timezone: 'Europe/Belgrade', accountCount: 2 },
    ]);
    const accounts = (await call(agent, 'list_accounts', { profileId: p.id })).items;
    const targets = accounts.map((a: { id: string }) => ({ accountId: a.id }));

    // The check tells the agent what is wrong before anything is sent.
    const bad = await call(agent, 'validate_post', { profileId: p.id, text: 'Hello from an agent', targets });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]).toMatchObject({ level: 'error', code: 'instagram_needs_image', network: 'instagram' });
    const refused = await call(agent, 'create_post', {
      profileId: p.id,
      text: 'Hello from an agent',
      targets,
      action: 'publish',
    });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('add at least one image');

    const media = await call(agent, 'import_media', {
      profileId: p.id,
      dataBase64: (await image(1080, 1080, 'jpeg')).toString('base64'),
      filename: 'hello.jpg',
      alt: 'A green square',
    });
    expect(media).toMatchObject({ width: 1080, mime: 'image/jpeg' });
    const good = await call(agent, 'validate_post', {
      profileId: p.id,
      text: 'Hello from an agent',
      mediaIds: [media.id],
      targets,
    });
    expect(good).toEqual({ ok: true, issues: [] });

    const post = await call(agent, 'create_post', {
      profileId: p.id,
      text: 'Hello from an agent',
      mediaIds: [media.id],
      targets,
      action: 'publish',
    });
    expect(post).toMatchObject({ status: 'scheduled', createdBy: 'token:agent' });
    await w.app.ctx.scheduler.tick();
    const done = await call(agent, 'get_post', { postId: post.id });
    expect(done.status).toBe('published');
    expect(done.targets.map((t: { externalUrl: string }) => t.externalUrl)).toEqual([
      expect.stringContaining('https://x.com/nik_x/status/'),
      expect.stringContaining('https://www.instagram.com/p/'),
    ]);
    expect((await call(agent, 'list_posts', { status: 'published' })).items).toHaveLength(1);

    // The audit log names the token, not just "someone".
    const audit = (await w.admin.get('/api/v1/audit?action=post.publish_requested')).json();
    expect(audit.items[0]).toMatchObject({ actorType: 'token', actorLabel: 'agent' });
  });

  it('holds an agent to its token: scopes, and its own profile only', async () => {
    const mine = await newProfile(w, 'Mine');
    const other = await newProfile(w, 'Other');
    await connectX(w, other.id);
    const [theirs] = await accountsOf(w, other.id);
    const agent = await connect(
      ['profiles:read', 'profiles:write', 'accounts:read', 'posts:read', 'posts:write', 'audit:read'],
      [mine.id],
    );

    expect((await call(agent, 'list_profiles')).items.map((p: { name: string }) => p.name)).toEqual(['Mine']);
    expect(await call(agent, 'get_profile', { profileId: other.id })).toMatchObject({
      isError: true,
      text: 'not_found: No such profile',
    });
    expect((await call(agent, 'list_accounts')).items).toHaveLength(0);
    expect(
      (
        await call(agent, 'create_post', {
          profileId: other.id,
          text: 'hijack',
          targets: [{ accountId: theirs?.id }],
          action: 'publish',
        })
      ).text,
    ).toContain('not_found');
    expect(
      (
        await call(agent, 'create_post', {
          profileId: mine.id,
          text: 'hijack',
          targets: [{ accountId: theirs?.id }],
          action: 'publish',
        })
      ).text,
    ).toContain('does not exist in this profile');
    expect((await call(agent, 'delete_profile', { profileId: other.id })).text).toContain('not_found');
    expect((await call(agent, 'create_profile', { name: 'Escape' })).text).toContain('forbidden');
    expect(
      (await call(agent, 'import_media', { profileId: mine.id, url: 'https://example.com/a.png' })).text,
    ).toContain('media:write');
    expect((await call(agent, 'list_audit_log')).text).toContain('profile-limited');
    expect(w.net.to('/2/tweets')).toHaveLength(0);

    // Bad input comes back as a readable tool error, not a crash.
    const bad = await call(agent, 'create_post', {
      profileId: mine.id,
      text: 'x',
      action: 'schedule',
      scheduledAt: 'tomorrow morning',
    });
    expect(bad.isError).toBe(true);
  });

  it('stops answering the moment the token is revoked', async () => {
    const agent = await connect(['admin']);
    expect((await call(agent, 'whoami')).username).toBe('admin');
    const { items } = (await w.admin.get('/api/v1/tokens')).json();
    await w.admin.delete(`/api/v1/tokens/${items[0].id}`);
    await expect(agent.callTool({ name: 'whoami', arguments: {} })).rejects.toThrow();
  });
});
