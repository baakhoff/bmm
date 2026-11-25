import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountsOf,
  addImage,
  connectInstagram,
  connectX,
  makeWorld,
  newProfile,
  setApps,
  type World,
} from './fakes.js';

let w: World;
let profileId: string;
let x: string;
let ig: string;

beforeEach(async () => {
  w = await makeWorld();
  await setApps(w);
  profileId = (await newProfile(w)).id;
  await connectX(w, profileId);
  await connectInstagram(w, profileId);
  const accounts = await accountsOf(w, profileId);
  x = accounts.find((a) => a.network === 'x')?.id as string;
  ig = accounts.find((a) => a.network === 'instagram')?.id as string;
  w.net.calls.length = 0;
});
afterEach(async () => {
  await w?.app.close();
});

const tick = () => w.app.ctx.scheduler.tick();
const post = async (id: string) => (await w.admin.get(`/api/v1/posts/${id}`)).json();
const create = async (body: object) => {
  const res = await w.admin.post('/api/v1/posts', { profileId, ...body });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
const target = (p: { targets: { network: string }[] }, network: string) =>
  p.targets.find((t) => t.network === network) as unknown as {
    status: string;
    error: string | null;
    externalUrl: string | null;
    attempts: number;
  };

describe('publishing', () => {
  it('publishes one post to X and Instagram, each with its own text, and records the links', async () => {
    const m = await addImage(w, profileId, 1080, 1350, 'Launch poster');
    const created = await create({
      text: 'We are live. Full story on the site.',
      mediaIds: [m.id],
      targets: [{ accountId: x, text: 'We are live.' }, { accountId: ig }],
      action: 'publish',
    });
    expect(created.status).toBe('scheduled');
    expect(created.createdBy).toBe('admin');
    expect(await tick()).toBe(2);

    const done = await post(created.id);
    expect(done.status).toBe('published');
    expect(target(done, 'x')).toMatchObject({ status: 'published', attempts: 1, error: null });
    expect(target(done, 'x').externalUrl).toMatch(/^https:\/\/x\.com\/nik_x\/status\/t\d+$/);
    expect(target(done, 'instagram').externalUrl).toMatch(/^https:\/\/www\.instagram\.com\/p\/ig\d+\/$/);

    // X got the image as a file, the alt text, then the post with that media and the X-specific text.
    const upload = w.net.to('/2/media/upload')[0];
    expect(upload?.files?.media).toMatchObject({ type: 'image/png' });
    expect(upload?.form?.media_category).toBe('tweet_image');
    expect(w.net.to('/2/media/metadata')[0]?.json).toMatchObject({ metadata: { alt_text: { text: 'Launch poster' } } });
    const tweet = w.net.to('/2/tweets')[0];
    expect(tweet?.json).toMatchObject({
      text: 'We are live.',
      media: { media_ids: [expect.stringMatching(/^m\d+$/)] },
    });

    // Instagram got a public link to the image, and that link really serves a JPEG without signing in.
    const container = w.net.to('/2002/media')[0];
    expect(container?.form).toMatchObject({
      caption: 'We are live. Full story on the site.',
      alt_text: 'Launch poster',
    });
    const link = new URL(container?.form?.image_url as string);
    expect(link.origin).toBe('https://media.example.com');
    const fetched = await w.app.inject(link.pathname);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/jpeg');
    expect(w.net.to('/2002/media_publish')).toHaveLength(1);

    // Nothing is sent twice.
    expect(await tick()).toBe(0);
    expect(w.net.to('/2/tweets')).toHaveLength(1);

    const audit = (await w.admin.get('/api/v1/audit?action=post.published')).json();
    expect(audit.items).toHaveLength(2);
    expect(audit.items[0]).toMatchObject({ actorType: 'system', targetId: created.id });
  });

  it('publishes several images to Instagram as a carousel', async () => {
    const a = await addImage(w, profileId, 1080, 1080);
    const b = await addImage(w, profileId, 1080, 1080);
    const created = await create({
      text: 'Two views',
      mediaIds: [a.id, b.id],
      targets: [{ accountId: ig }],
      action: 'publish',
    });
    await tick();
    expect((await post(created.id)).status).toBe('published');
    const containers = w.net.to('/2002/media').map((c) => c.form);
    expect(containers).toHaveLength(3);
    expect(containers[0]).toMatchObject({ is_carousel_item: 'true' });
    expect(containers[2]).toMatchObject({
      media_type: 'CAROUSEL',
      caption: 'Two views',
      children: `c${containers[2]?.children?.slice(1)}`,
    });
    expect(containers[2]?.children?.split(',')).toHaveLength(2);
  });

  it('waits for the scheduled time', async () => {
    const created = await create({
      text: 'Good morning',
      targets: [{ accountId: x }],
      action: 'schedule',
      scheduledAt: '2026-12-01T12:00:00+01:00',
    });
    expect(created.status).toBe('scheduled');
    expect(await tick()).toBe(0);
    w.clock.advance(119 * 60_000);
    expect(await tick()).toBe(0);
    w.clock.advance(2 * 60_000);
    expect(await tick()).toBe(1);
    expect((await post(created.id)).status).toBe('published');
  });

  it('refuses a schedule time in the past or without a time', async () => {
    const past = await w.admin.post('/api/v1/posts', {
      profileId,
      text: 'late',
      targets: [{ accountId: x }],
      action: 'schedule',
      scheduledAt: '2026-11-30T09:00:00Z',
    });
    expect(past.statusCode).toBe(400);
    const none = await w.admin.post('/api/v1/posts', {
      profileId,
      text: 'when',
      targets: [{ accountId: x }],
      action: 'schedule',
    });
    expect(none.statusCode).toBe(400);
    const naive = await w.admin.post('/api/v1/posts', {
      profileId,
      text: 'when',
      targets: [{ accountId: x }],
      action: 'schedule',
      scheduledAt: '2026-12-02 09:00',
    });
    expect(naive.statusCode).toBe(400);
  });

  it('retries when the network says "not now", after a pause', async () => {
    w.net.failOnce((c) => c.url.pathname === '/2/tweets', 429, {
      title: 'Too Many Requests',
      detail: 'Too Many Requests',
    });
    const created = await create({ text: 'Patience', targets: [{ accountId: x }], action: 'publish' });
    await tick();
    let p = await post(created.id);
    expect(p.status).toBe('publishing');
    expect(target(p, 'x')).toMatchObject({ status: 'retrying', attempts: 1 });
    expect(target(p, 'x').error).toContain('429');
    expect(await tick()).toBe(0);
    w.clock.advance(61_000);
    expect(await tick()).toBe(1);
    p = await post(created.id);
    expect(p.status).toBe('published');
    expect(target(p, 'x')).toMatchObject({ status: 'published', attempts: 2, error: null });
  });

  it('gives up after four attempts', async () => {
    for (let i = 0; i < 4; i++)
      w.net.failOnce((c) => c.url.pathname === '/2/tweets', 503, { title: 'Service Unavailable' });
    const created = await create({ text: 'Stubborn', targets: [{ accountId: x }], action: 'publish' });
    for (let i = 0; i < 6; i++) {
      await tick();
      w.clock.advance(16 * 60_000);
    }
    const p = await post(created.id);
    expect(p.status).toBe('failed');
    expect(target(p, 'x')).toMatchObject({ status: 'failed', attempts: 4 });
    expect(w.net.to('/2/tweets')).toHaveLength(4);
  });

  it('never resends when it cannot know whether the post went out', async () => {
    w.net.dropOnce((c) => c.url.pathname === '/2/tweets');
    const created = await create({ text: 'Schrödinger', targets: [{ accountId: x }], action: 'publish' });
    await tick();
    const p = await post(created.id);
    expect(p.status).toBe('failed');
    expect(target(p, 'x').error).toContain('may or may not have been published');
    w.clock.advance(3_600_000);
    expect(await tick()).toBe(0);
    expect(w.net.to('/2/tweets')).toHaveLength(1);
  });

  it('marks the account when access was revoked, and reports a partly published post', async () => {
    const m = await addImage(w, profileId);
    w.net.failOnce((c) => c.url.pathname === '/2/media/upload', 401, { title: 'Unauthorized', detail: 'Unauthorized' });
    const created = await create({
      text: 'Half',
      mediaIds: [m.id],
      targets: [{ accountId: x }, { accountId: ig }],
      action: 'publish',
    });
    await tick();
    const p = await post(created.id);
    expect(p.status).toBe('partial');
    expect(target(p, 'x')).toMatchObject({ status: 'failed' });
    expect(target(p, 'x').error).toContain('Connect the account again');
    expect(target(p, 'instagram').status).toBe('published');
    expect((await accountsOf(w, profileId)).find((a) => a.network === 'x')?.status).toBe('needs_reauth');

    // Validation now says so, before anyone schedules onto the broken account.
    const check = (
      await w.admin.post('/api/v1/posts/validate', { profileId, text: 'next', targets: [{ accountId: x }] })
    ).json();
    expect(check.issues[0]).toMatchObject({ level: 'error', code: 'needs_reauth' });

    // Reconnecting heals it, and a retry sends only what failed.
    await connectX(w, profileId);
    expect((await accountsOf(w, profileId)).find((a) => a.network === 'x')?.status).toBe('active');
    w.net.calls.length = 0;
    expect((await w.admin.post(`/api/v1/posts/${created.id}/retry`)).statusCode).toBe(200);
    await tick();
    expect((await post(created.id)).status).toBe('published');
    expect(w.net.to('/2/tweets')).toHaveLength(1);
    expect(w.net.to('/2002/media_publish')).toHaveLength(0);
  });

  it('explains an Instagram failure in words, and does not retry a refusal', async () => {
    const m = await addImage(w, profileId);
    w.net.failOnce((c) => c.url.pathname === '/2002/media' && c.method === 'POST', 400, {
      error: {
        message: 'Only photo or video can be accepted as media type.',
        type: 'OAuthException',
        code: 9004,
        error_user_msg: 'The image could not be downloaded.',
      },
    });
    const created = await create({ text: 'Nope', mediaIds: [m.id], targets: [{ accountId: ig }], action: 'publish' });
    await tick();
    const p = await post(created.id);
    expect(p.status).toBe('failed');
    expect(target(p, 'instagram').error).toBe('Instagram answered 400: The image could not be downloaded.');
    expect((await w.admin.post(`/api/v1/posts/${created.id}/retry`)).json().status).toBe('scheduled');
  });

  it('renews an expired X token before publishing and keeps the rotated refresh token', async () => {
    w.clock.advance(3 * 3_600_000);
    const first = await create({ text: 'After a nap', targets: [{ accountId: x }], action: 'publish' });
    await tick();
    expect((await post(first.id)).status).toBe('published');
    const refreshes = () => w.net.to('/2/oauth2/token').filter((c) => c.form?.grant_type === 'refresh_token');
    expect(refreshes()).toHaveLength(1);
    expect(refreshes()[0]?.form?.refresh_token).toBe('x-refresh-1');
    expect(w.net.to('/2/tweets')[0]?.headers.get('authorization')).toBe('Bearer x-access-r1');

    // Within the new token's life there is no second refresh.
    const second = await create({ text: 'Again', targets: [{ accountId: x }], action: 'publish' });
    await tick();
    expect((await post(second.id)).status).toBe('published');
    expect(refreshes()).toHaveLength(1);

    // Later, the rotated refresh token is the one used.
    w.clock.advance(3 * 3_600_000);
    await create({ text: 'Third', targets: [{ accountId: x }], action: 'publish' });
    await tick();
    expect(refreshes()[1]?.form?.refresh_token).toBe('x-refresh-r1');
  });

  it('asks for a reconnect when the refresh token was revoked', async () => {
    w.net.xRefresh = 'revoked-elsewhere';
    w.clock.advance(3 * 3_600_000);
    const created = await create({ text: 'Locked out', targets: [{ accountId: x }], action: 'publish' });
    await tick();
    expect(target(await post(created.id), 'x').error).toContain('Connect the account again');
    expect((await accountsOf(w, profileId)).find((a) => a.network === 'x')?.status).toBe('needs_reauth');
    expect(w.net.to('/2/tweets')).toHaveLength(0);
  });

  it('fails a claim left behind by a process that died, without resending', async () => {
    const created = await create({ text: 'Orphan', targets: [{ accountId: x }], action: 'publish' });
    const { postTargets, posts } = await import('../src/db/schema.js');
    await w.app.ctx.db.update(postTargets).set({ status: 'publishing', claimedAt: w.clock.now, attempts: 1 });
    await w.app.ctx.db.update(posts).set({ status: 'publishing' });
    w.clock.advance(5 * 60_000);
    await tick();
    expect((await post(created.id)).status).toBe('publishing');
    w.clock.advance(11 * 60_000);
    await tick();
    const p = await post(created.id);
    expect(p.status).toBe('failed');
    expect(target(p, 'x').error).toContain('BMM stopped while publishing');
    expect(w.net.to('/2/tweets')).toHaveLength(0);
  });
});

describe('editing posts', () => {
  it('changes a draft, schedules it, moves it, unschedules it, and locks it once published', async () => {
    const m = await addImage(w, profileId);
    const draft = await create({ text: 'v1', targets: [{ accountId: x }] });
    const edit = (body: object) => w.admin.request('PATCH', `/api/v1/posts/${draft.id}`, body);

    let res = await edit({ text: 'v2', mediaIds: [m.id], targets: [{ accountId: x }, { accountId: ig }] });
    expect(res.json()).toMatchObject({ text: 'v2', status: 'draft' });
    expect(res.json().media).toHaveLength(1);
    expect(res.json().targets).toHaveLength(2);

    expect((await edit({ action: 'schedule' })).statusCode).toBe(400);
    res = await edit({ action: 'schedule', scheduledAt: '2026-12-05T10:00:00Z' });
    expect(res.json()).toMatchObject({ status: 'scheduled', scheduledAt: '2026-12-05T10:00:00.000Z' });
    res = await edit({ scheduledAt: '2026-12-06T10:00:00Z' });
    expect(res.json()).toMatchObject({ status: 'scheduled', scheduledAt: '2026-12-06T10:00:00.000Z' });
    expect((await w.admin.delete(`/api/v1/media/${m.id}`)).statusCode).toBe(409);

    res = await edit({ action: 'draft' });
    expect(res.json().status).toBe('draft');
    w.clock.advance(30 * 86_400_000);
    expect(await tick()).toBe(0);

    // An edit that would break a network's rules cannot be scheduled.
    res = await edit({ mediaIds: [], action: 'publish' });
    expect(res.statusCode).toBe(422);
    expect((await post(draft.id)).media).toHaveLength(1);

    res = await edit({ action: 'publish' });
    expect(res.statusCode).toBe(200);
    await tick();
    expect((await post(draft.id)).status).toBe('published');
    expect((await edit({ text: 'too late' })).statusCode).toBe(409);
    expect((await w.admin.post(`/api/v1/posts/${draft.id}/retry`)).statusCode).toBe(409);

    expect((await w.admin.delete(`/api/v1/posts/${draft.id}`)).statusCode).toBe(204);
    expect((await w.admin.delete(`/api/v1/media/${m.id}`)).statusCode).toBe(204);
  });

  it('lists with filters and pages', async () => {
    for (let i = 0; i < 3; i++) await create({ text: `draft ${i}`, targets: [{ accountId: x }] });
    await create({ text: 'out', targets: [{ accountId: x }], action: 'publish' });
    await tick();
    const all = (await w.admin.get(`/api/v1/posts?profileId=${profileId}&limit=3`)).json();
    expect(all.items.map((p: { text: string }) => p.text)).toEqual(['out', 'draft 2', 'draft 1']);
    const next = (await w.admin.get(`/api/v1/posts?limit=3&before=${all.nextBefore}`)).json();
    expect(next.items.map((p: { text: string }) => p.text)).toEqual(['draft 0']);
    expect(next.nextBefore).toBeNull();
    expect((await w.admin.get('/api/v1/posts?status=published')).json().items).toHaveLength(1);
  });

  it('takes a disconnected account off its posts and deletes a profile with everything in it', async () => {
    const m = await addImage(w, profileId);
    const created = await create({ text: 'both', mediaIds: [m.id], targets: [{ accountId: x }, { accountId: ig }] });
    expect((await w.admin.delete(`/api/v1/accounts/${x}`)).statusCode).toBe(204);
    expect((await post(created.id)).targets).toHaveLength(1);
    expect((await w.admin.delete(`/api/v1/profiles/${profileId}`)).statusCode).toBe(204);
    expect((await w.admin.get(`/api/v1/posts/${created.id}`)).statusCode).toBe(404);
    expect(await w.app.ctx.db.query.media.findMany()).toHaveLength(0);
    await expect(w.app.ctx.storage.get(m.id)).rejects.toThrow();
  });
});
