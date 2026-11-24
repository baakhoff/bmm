import type { SystemVersion } from '@bmm/shared';

const RELEASES_URL = 'https://api.github.com/repos/baakhoff/bmm/releases/latest';
const FRESH_MS = 6 * 3_600_000;
const RETRY_MS = 15 * 60_000;

type Triple = [number, number, number];

/** `1.2.3` or `v1.2.3`. Pre-releases and build names (`edge`, `dev`) are not releases. */
export function parseRelease(v: string): Triple | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: Triple, current: Triple): boolean {
  for (let i = 0; i < 3; i++) {
    const a = candidate[i] as number;
    const b = current[i] as number;
    if (a !== b) return a > b;
  }
  return false;
}

/**
 * Tells the admin when a newer release exists. It asks GitHub's public API
 * for the latest release and sends nothing about this instance beyond the
 * request itself. Checked lazily when someone looks, cached for hours, and
 * never in the way: any failure just means "unknown".
 */
export class UpdateChecker {
  private latest: { version: string; url: string } | null = null;
  private checkedAt: Date | null = null;
  private lastAttempt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly current: string,
    private readonly enabled: boolean,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<SystemVersion> {
    if (this.enabled) {
      const age = this.now() - (this.checkedAt?.getTime() ?? 0);
      const sinceAttempt = this.now() - this.lastAttempt;
      if (age > FRESH_MS && sinceAttempt > RETRY_MS) {
        this.inFlight ??= this.refresh().finally(() => {
          this.inFlight = null;
        });
        await this.inFlight;
      }
    }
    const mine = parseRelease(this.current);
    const theirs = this.latest ? parseRelease(this.latest.version) : null;
    return {
      version: this.current,
      checkEnabled: this.enabled,
      latestVersion: this.latest?.version ?? null,
      updateAvailable: mine && theirs ? isNewer(theirs, mine) : null,
      releaseUrl: this.latest?.url ?? null,
      checkedAt: this.checkedAt?.toISOString() ?? null,
    };
  }

  private async refresh(): Promise<void> {
    this.lastAttempt = this.now();
    try {
      const res = await this.fetchImpl(RELEASES_URL, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'bmm-update-check' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
      if (typeof body.tag_name !== 'string' || !parseRelease(body.tag_name)) return;
      this.latest = {
        version: body.tag_name.replace(/^v/, ''),
        // Only ever link to the project's own releases, whatever the response says.
        url: `https://github.com/baakhoff/bmm/releases/tag/${encodeURIComponent(body.tag_name)}`,
      };
      this.checkedAt = new Date(this.now());
    } catch {
      // Offline, rate-limited or blocked by a network policy: stay "unknown".
    }
  }
}
