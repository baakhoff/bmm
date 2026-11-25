import { and, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { auditAs } from '../audit.js';
import { ConnectorError, type PublishMedia } from '../connectors/types.js';
import type { AppContext } from '../context.js';
import { accounts, media, postMedia, posts, postTargets } from '../db/schema.js';
import { publicJpegUrl } from './media.js';
import { appCreds } from './networks.js';

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const STALE_CLAIM_MS = 15 * 60_000;

type TargetRow = typeof postTargets.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;

/**
 * Publishes what is due. The work list is the database itself: a target row
 * is claimed with a conditional update, so two processes never publish the
 * same thing, and a restart loses nothing.
 */
export class Scheduler {
  private running: Promise<number> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.ctx.log.error({ err }, 'scheduler tick failed'));
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Wakes the scheduler now, for "publish" requests that should not wait for the next interval. */
  kick(): void {
    if (!this.ctx.config.scheduler) return;
    this.tick().catch((err) => this.ctx.log.error({ err }, 'scheduler tick failed'));
  }

  /** One pass. Returns how many targets were attempted. Overlapping calls share one pass. */
  tick(): Promise<number> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<number> {
    const { ctx } = this;
    const now = ctx.now();
    await this.failStaleClaims(now);
    const due = await ctx.db
      .select({ t: postTargets })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(
        and(
          inArray(posts.status, ['scheduled', 'publishing']),
          lte(posts.scheduledAt, now),
          or(
            eq(postTargets.status, 'pending'),
            and(
              eq(postTargets.status, 'retrying'),
              or(isNull(postTargets.nextAttemptAt), lte(postTargets.nextAttemptAt, now)),
            ),
          ),
        ),
      )
      .orderBy(posts.scheduledAt, postTargets.postId, postTargets.position)
      .limit(50);
    let attempted = 0;
    for (const { t } of due) {
      const [claimed] = await ctx.db
        .update(postTargets)
        .set({ status: 'publishing', claimedAt: ctx.now(), attempts: t.attempts + 1 })
        .where(and(eq(postTargets.id, t.id), inArray(postTargets.status, ['pending', 'retrying'])))
        .returning();
      if (!claimed) continue;
      await ctx.db.update(posts).set({ status: 'publishing', updatedAt: ctx.now() }).where(eq(posts.id, t.postId));
      attempted++;
      await this.publish(claimed);
      await this.settle(t.postId);
    }
    return attempted;
  }

  /**
   * A target left "publishing" by a process that died. Whether the post went
   * out is unknown, so it is failed with that said, never silently resent.
   */
  private async failStaleClaims(now: Date): Promise<void> {
    const stale = await this.ctx.db
      .update(postTargets)
      .set({
        status: 'failed',
        error:
          'BMM stopped while publishing this. It may or may not have been published; check the account before retrying.',
      })
      .where(
        and(eq(postTargets.status, 'publishing'), lt(postTargets.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS))),
      )
      .returning();
    for (const postId of new Set(stale.map((s) => s.postId))) await this.settle(postId);
  }

  private async accessToken(account: AccountRow): Promise<string> {
    const { ctx } = this;
    const connector = ctx.connectors[account.network];
    const access = ctx.secrets.decrypt(account.accessTokenEnc);
    if (
      !connector.needsRefresh({ expiresAt: account.tokenExpiresAt, refreshedAt: account.tokenRefreshedAt }, ctx.now())
    ) {
      return access;
    }
    const app = await appCreds(ctx, account.network);
    const fresh = await connector.refresh(app, {
      accessToken: access,
      refreshToken: account.refreshTokenEnc ? ctx.secrets.decrypt(account.refreshTokenEnc) : null,
    });
    // Saved before use: X's refresh tokens work once, so losing the new one locks the account out.
    await ctx.db
      .update(accounts)
      .set({
        accessTokenEnc: ctx.secrets.encrypt(fresh.accessToken),
        refreshTokenEnc: fresh.refreshToken ? ctx.secrets.encrypt(fresh.refreshToken) : account.refreshTokenEnc,
        tokenExpiresAt: fresh.expiresAt,
        tokenRefreshedAt: ctx.now(),
        updatedAt: ctx.now(),
      })
      .where(eq(accounts.id, account.id));
    return fresh.accessToken;
  }

  private async publish(target: TargetRow): Promise<void> {
    const { ctx } = this;
    const [post] = await ctx.db.select().from(posts).where(eq(posts.id, target.postId)).limit(1);
    const [account] = await ctx.db.select().from(accounts).where(eq(accounts.id, target.accountId)).limit(1);
    if (!post || !account) return;
    const meta = { postId: post.id, network: account.network, username: account.username, attempt: target.attempts };
    try {
      if (account.status === 'needs_reauth') {
        throw new ConnectorError('reauth', `@${account.username} has to be connected again before it can publish.`);
      }
      const rows = await ctx.db
        .select({ m: media })
        .from(postMedia)
        .innerJoin(media, eq(media.id, postMedia.mediaId))
        .where(eq(postMedia.postId, post.id))
        .orderBy(postMedia.position);
      const items: PublishMedia[] = rows.map(({ m }) => ({
        mime: m.mime,
        width: m.width,
        height: m.height,
        bytes: m.bytes,
        alt: m.alt,
        filename: m.filename,
        load: () => ctx.storage.get(m.id),
        publicJpegUrl: publicJpegUrl(ctx, m.id),
      }));
      const accessToken = await this.accessToken(account);
      const result = await ctx.connectors[account.network].publish({
        accessToken,
        account: { externalId: account.externalId, username: account.username },
        text: target.text ?? post.text,
        media: items,
      });
      await ctx.db
        .update(postTargets)
        .set({
          status: 'published',
          externalId: result.externalId,
          externalUrl: result.url,
          error: null,
          publishedAt: ctx.now(),
        })
        .where(eq(postTargets.id, target.id));
      await auditAs(ctx, null, {
        action: 'post.published',
        targetType: 'post',
        targetId: post.id,
        metadata: { ...meta, url: result.url },
      });
    } catch (err) {
      const known = err instanceof ConnectorError;
      const message = known ? err.message : 'BMM hit an internal error while publishing. See the server log.';
      if (!known) ctx.log.error({ err, ...meta }, 'publish failed unexpectedly');
      if (known && err.kind === 'reauth') {
        await ctx.db
          .update(accounts)
          .set({ status: 'needs_reauth', updatedAt: ctx.now() })
          .where(eq(accounts.id, account.id));
      }
      if (known && err.kind === 'retryable' && target.attempts < MAX_ATTEMPTS) {
        const wait = BACKOFF_MS[target.attempts - 1] ?? (BACKOFF_MS.at(-1) as number);
        await ctx.db
          .update(postTargets)
          .set({ status: 'retrying', error: message, nextAttemptAt: new Date(ctx.now().getTime() + wait) })
          .where(eq(postTargets.id, target.id));
        await auditAs(ctx, null, {
          action: 'post.retry_scheduled',
          targetType: 'post',
          targetId: post.id,
          metadata: { ...meta, error: message },
        });
      } else {
        await ctx.db.update(postTargets).set({ status: 'failed', error: message }).where(eq(postTargets.id, target.id));
        await auditAs(ctx, null, {
          action: 'post.failed',
          targetType: 'post',
          targetId: post.id,
          metadata: { ...meta, error: message },
        });
      }
    }
  }

  /** The post's status is a summary of its targets'. */
  private async settle(postId: string): Promise<void> {
    const targets = await this.ctx.db
      .select({ status: postTargets.status })
      .from(postTargets)
      .where(eq(postTargets.postId, postId));
    const states = targets.map((t) => t.status);
    const open = states.some((s) => s === 'pending' || s === 'publishing' || s === 'retrying');
    const done = states.filter((s) => s === 'published').length;
    const status = open ? 'publishing' : done === states.length ? 'published' : done > 0 ? 'partial' : 'failed';
    await this.ctx.db.update(posts).set({ status, updatedAt: this.ctx.now() }).where(eq(posts.id, postId));
  }
}
