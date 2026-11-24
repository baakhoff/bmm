import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { isNewer, parseRelease, UpdateChecker } from '../src/updates.js';
import { Browser, makeApp, setUp } from './helpers.js';

function github(tag: string | null, counter = { calls: 0 }) {
  const impl = (async (url: string | URL | Request) => {
    counter.calls++;
    expect(String(url)).toBe('https://api.github.com/repos/baakhoff/bmm/releases/latest');
    if (tag === null) return new Response('rate limited', { status: 403 });
    return Response.json({ tag_name: tag, html_url: 'https://evil.example/phish' });
  }) as typeof fetch;
  return Object.assign(impl, { counter });
}

describe('version comparison', () => {
  it('reads releases and nothing else', () => {
    expect(parseRelease('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseRelease('0.10.0')).toEqual([0, 10, 0]);
    for (const v of ['edge', 'dev', '1.2', '1.2.3-rc.1', 'sha-abc1234']) expect(parseRelease(v)).toBeNull();
  });
  it('orders numerically, not as text', () => {
    expect(isNewer([0, 10, 0], [0, 9, 9])).toBe(true);
    expect(isNewer([1, 0, 0], [0, 99, 99])).toBe(true);
    expect(isNewer([0, 1, 0], [0, 1, 0])).toBe(false);
    expect(isNewer([0, 1, 0], [0, 1, 1])).toBe(false);
  });
});

describe('update checker', () => {
  it('reports a newer release and links only to the project itself', async () => {
    const info = await new UpdateChecker('0.1.0', true, github('v0.2.0')).get();
    expect(info).toMatchObject({ version: '0.1.0', latestVersion: '0.2.0', updateAvailable: true });
    expect(info.releaseUrl).toBe('https://github.com/baakhoff/bmm/releases/tag/v0.2.0');
  });

  it('says no update when current, and unknown for a build from main', async () => {
    expect((await new UpdateChecker('0.2.0', true, github('v0.2.0')).get()).updateAvailable).toBe(false);
    expect((await new UpdateChecker('edge', true, github('v0.2.0')).get()).updateAvailable).toBeNull();
  });

  it('stays unknown, without throwing, when GitHub refuses or the network is down', async () => {
    expect((await new UpdateChecker('0.1.0', true, github(null)).get()).updateAvailable).toBeNull();
    const down = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    expect(await new UpdateChecker('0.1.0', true, down).get()).toMatchObject({
      updateAvailable: null,
      checkedAt: null,
    });
  });

  it('caches for hours, retries a failure only after a pause, and never calls out when turned off', async () => {
    let now = 1_000_000_000_000;
    const ok = github('v0.2.0');
    const checker = new UpdateChecker('0.1.0', true, ok, () => now);
    await Promise.all([checker.get(), checker.get(), checker.get()]);
    await checker.get();
    expect(ok.counter.calls).toBe(1);
    now += 7 * 3_600_000;
    await checker.get();
    expect(ok.counter.calls).toBe(2);

    const failing = github(null);
    const flaky = new UpdateChecker('0.1.0', true, failing, () => now);
    await flaky.get();
    await flaky.get();
    expect(failing.counter.calls).toBe(1);
    now += 16 * 60_000;
    await flaky.get();
    expect(failing.counter.calls).toBe(2);

    const off = github('v9.9.9');
    expect(await new UpdateChecker('0.1.0', false, off).get()).toMatchObject({
      checkEnabled: false,
      updateAvailable: null,
    });
    expect(off.counter.calls).toBe(0);
  });
});

describe('GET /system/version', () => {
  let app: App;
  afterEach(async () => {
    await app?.close();
  });

  it('needs sign-in and serves what the checker knows', async () => {
    app = await makeApp({ BMM_UPDATE_CHECK: 'true' }, { fetch: github('v99.0.0') });
    expect((await new Browser(app).get('/api/v1/system/version')).statusCode).toBe(401);
    const b = await setUp(app);
    const res = await b.get('/api/v1/system/version');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ checkEnabled: true, latestVersion: '99.0.0', updateAvailable: true });
  });
});
