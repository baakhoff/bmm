import type {
  CreatePostRequest,
  Post,
  PostPage,
  PostStatus,
  UpdatePostRequest,
  ValidatePostRequest,
  ValidationIssue,
  ValidationResult,
} from '@bmm/shared';
import { CreatePostRequestSchema, ValidatePostRequestSchema } from '@bmm/shared';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { auditAs } from '../audit.js';
import type { AppContext } from '../context.js';
import { accounts, media, postMedia, posts, postTargets, profiles } from '../db/schema.js';
import { uuidv7 } from '../lib/crypto.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { type Actor, label, mayUseProfile, need, useProfile } from './actor.js';
import { mediaForPost, toMedia } from './media.js';

type PostRow = typeof posts.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;
type MediaRow = typeof media.$inferSelect;
interface TargetInput {
  accountId: string;
  text?: string | null;
}

async function accountsForTargets(ctx: AppContext, profileId: string, targets: TargetInput[]): Promise<AccountRow[]> {
  const ids = targets.map((t) => t.accountId);
  if (new Set(ids).size !== ids.length) throw badRequest('The same account is targeted twice');
  if (ids.length === 0) return [];
  const rows = await ctx.db
    .select()
    .from(accounts)
    .where(and(inArray(accounts.id, ids), eq(accounts.profileId, profileId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw badRequest(`Account ${id} does not exist in this profile`);
    return r;
  });
}

function check(
  ctx: AppContext,
  text: string,
  mediaRows: MediaRow[],
  targets: TargetInput[],
  accountRows: AccountRow[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (targets.length === 0) {
    issues.push({
      level: 'error',
      code: 'no_targets',
      message: 'Choose at least one account to publish to.',
      accountId: null,
      network: null,
    });
  }
  for (const [i, account] of accountRows.entries()) {
    const own = targets[i]?.text;
    const findings = ctx.connectors[account.network].validate(own ?? text, mediaRows, {
      publicMedia: Boolean(ctx.config.publicMediaUrl),
    });
    if (account.status === 'needs_reauth') {
      findings.unshift({
        level: 'error',
        code: 'needs_reauth',
        message: `@${account.username} has to be connected again before it can publish.`,
      });
    }
    for (const f of findings) issues.push({ ...f, accountId: account.id, network: account.network });
  }
  return issues;
}

/** Everything that can be known to be wrong before asking a network. Changes nothing. */
export async function validatePost(
  ctx: AppContext,
  actor: Actor,
  input: ValidatePostRequest,
): Promise<ValidationResult> {
  need(actor, 'posts:read');
  const v = ValidatePostRequestSchema.parse(input);
  await useProfile(ctx, actor, v.profileId);
  const mediaRows = await mediaForPost(ctx, v.profileId, v.mediaIds);
  const accountRows = await accountsForTargets(ctx, v.profileId, v.targets);
  const issues = check(ctx, v.text, mediaRows, v.targets, accountRows);
  return { ok: !issues.some((i) => i.level === 'error'), issues };
}

function refuse(issues: ValidationIssue[]): never {
  const errors = issues.filter((i) => i.level === 'error');
  throw new HttpError(422, 'validation_failed', errors.map((e) => e.message).join(' '));
}

function when(ctx: AppContext, action: 'draft' | 'schedule' | 'publish', scheduledAt: string | undefined): Date | null {
  if (action === 'publish') return ctx.now();
  if (!scheduledAt) {
    if (action === 'schedule') throw badRequest('scheduledAt is required to schedule a post');
    return null;
  }
  const at = new Date(scheduledAt);
  if (action === 'schedule' && at.getTime() < ctx.now().getTime() - 60_000) {
    throw badRequest('scheduledAt is in the past. Use action "publish" to publish now.');
  }
  return at;
}

export async function loadPosts(ctx: AppContext, rows: PostRow[]): Promise<Post[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const mediaRows = await ctx.db
    .select({ postId: postMedia.postId, position: postMedia.position, m: media })
    .from(postMedia)
    .innerJoin(media, eq(media.id, postMedia.mediaId))
    .where(inArray(postMedia.postId, ids))
    .orderBy(asc(postMedia.position));
  const targetRows = await ctx.db
    .select({ t: postTargets, a: accounts })
    .from(postTargets)
    .innerJoin(accounts, eq(accounts.id, postTargets.accountId))
    .where(inArray(postTargets.postId, ids))
    .orderBy(asc(postTargets.position), asc(postTargets.id));
  return rows.map((p) => ({
    id: p.id,
    profileId: p.profileId,
    text: p.text,
    status: p.status,
    scheduledAt: p.scheduledAt?.toISOString() ?? null,
    media: mediaRows.filter((m) => m.postId === p.id).map((m) => toMedia(m.m)),
    targets: targetRows
      .filter((t) => t.t.postId === p.id)
      .map(({ t, a }) => ({
        id: t.id,
        accountId: a.id,
        network: a.network,
        username: a.username,
        text: t.text,
        status: t.status,
        attempts: t.attempts,
        externalId: t.externalId,
        externalUrl: t.externalUrl,
        error: t.error,
        publishedAt: t.publishedAt?.toISOString() ?? null,
      })),
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}

async function usePost(ctx: AppContext, actor: Actor, id: string): Promise<PostRow> {
  const [row] = await ctx.db
    .select({ p: posts })
    .from(posts)
    .innerJoin(profiles, eq(profiles.id, posts.profileId))
    .where(and(eq(posts.id, id), eq(profiles.userId, actor.auth.user.id)))
    .limit(1);
  if (!row || !mayUseProfile(actor, row.p.profileId)) throw notFound('No such post');
  return row.p;
}

export async function getPost(ctx: AppContext, actor: Actor, id: string): Promise<Post> {
  need(actor, 'posts:read');
  const [post] = await loadPosts(ctx, [await usePost(ctx, actor, id)]);
  return post as Post;
}

export async function listPosts(
  ctx: AppContext,
  actor: Actor,
  q: { profileId?: string; status?: PostStatus; limit: number; before?: string },
): Promise<PostPage> {
  need(actor, 'posts:read');
  if (q.profileId) await useProfile(ctx, actor, q.profileId);
  const limit = actor.auth.profileIds;
  if (!q.profileId && limit && limit.length === 0) return { items: [], nextBefore: null };
  const rows = await ctx.db
    .select({ p: posts })
    .from(posts)
    .innerJoin(profiles, eq(profiles.id, posts.profileId))
    .where(
      and(
        eq(profiles.userId, actor.auth.user.id),
        q.profileId ? eq(posts.profileId, q.profileId) : limit ? inArray(posts.profileId, limit) : undefined,
        q.status ? eq(posts.status, q.status) : undefined,
        q.before ? lt(posts.id, q.before) : undefined,
      ),
    )
    .orderBy(desc(posts.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit).map((r) => r.p);
  return { items: await loadPosts(ctx, page), nextBefore: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
}

async function writeContent(
  ctx: AppContext,
  postId: string,
  mediaRows: MediaRow[] | null,
  targets: TargetInput[] | null,
) {
  if (mediaRows) {
    await ctx.db.delete(postMedia).where(eq(postMedia.postId, postId));
    if (mediaRows.length) {
      await ctx.db.insert(postMedia).values(mediaRows.map((m, position) => ({ postId, mediaId: m.id, position })));
    }
  }
  if (targets) {
    await ctx.db.delete(postTargets).where(eq(postTargets.postId, postId));
    if (targets.length) {
      await ctx.db.insert(postTargets).values(
        targets.map((t, position) => ({
          id: uuidv7(),
          postId,
          accountId: t.accountId,
          text: t.text || null,
          position,
        })),
      );
    }
  }
}

export async function createPost(ctx: AppContext, actor: Actor, input: CreatePostRequest): Promise<Post> {
  need(actor, 'posts:write');
  const v = CreatePostRequestSchema.parse(input);
  await useProfile(ctx, actor, v.profileId);
  const mediaRows = await mediaForPost(ctx, v.profileId, v.mediaIds);
  const accountRows = await accountsForTargets(ctx, v.profileId, v.targets);
  const scheduledAt = when(ctx, v.action, v.scheduledAt);
  if (v.action !== 'draft') {
    const issues = check(ctx, v.text, mediaRows, v.targets, accountRows);
    if (issues.some((i) => i.level === 'error')) refuse(issues);
  }
  const id = uuidv7();
  await ctx.db.insert(posts).values({
    id,
    profileId: v.profileId,
    text: v.text,
    status: v.action === 'draft' ? 'draft' : 'scheduled',
    scheduledAt,
    createdBy: label(actor),
  });
  await writeContent(ctx, id, mediaRows, v.targets);
  await auditAs(ctx, actor, {
    action:
      v.action === 'draft' ? 'post.drafted' : v.action === 'schedule' ? 'post.scheduled' : 'post.publish_requested',
    targetType: 'post',
    targetId: id,
    metadata: { profileId: v.profileId, scheduledAt, accounts: accountRows.map((a) => `${a.network}:@${a.username}`) },
  });
  if (v.action === 'publish') ctx.scheduler.kick();
  return getPostUnchecked(ctx, id);
}

async function getPostUnchecked(ctx: AppContext, id: string): Promise<Post> {
  const [row] = await ctx.db.select().from(posts).where(eq(posts.id, id)).limit(1);
  if (!row) throw notFound('No such post');
  const [post] = await loadPosts(ctx, [row]);
  return post as Post;
}

/** Changes a post that has not started publishing, and optionally schedules or publishes it. */
export async function updatePost(ctx: AppContext, actor: Actor, id: string, input: UpdatePostRequest): Promise<Post> {
  need(actor, 'posts:write');
  const row = await usePost(ctx, actor, id);
  if (row.status !== 'draft' && row.status !== 'scheduled') {
    throw conflict(`This post is ${row.status} and can no longer be changed.`);
  }
  const current = await getPostUnchecked(ctx, id);
  const text = input.text ?? row.text;
  const targets: TargetInput[] =
    input.targets ?? current.targets.map((t) => ({ accountId: t.accountId, text: t.text }));
  const mediaRows = await mediaForPost(ctx, row.profileId, input.mediaIds ?? current.media.map((m) => m.id));
  const accountRows = await accountsForTargets(ctx, row.profileId, targets);
  const action = input.action ?? (row.status === 'draft' ? 'draft' : 'schedule');
  const scheduledAt =
    action === 'publish' ? ctx.now() : input.scheduledAt ? when(ctx, action, input.scheduledAt) : row.scheduledAt;
  if (action === 'schedule' && !scheduledAt) throw badRequest('scheduledAt is required to schedule a post');
  if (action !== 'draft') {
    const issues = check(ctx, text, mediaRows, targets, accountRows);
    if (issues.some((i) => i.level === 'error')) refuse(issues);
  }
  // Only a post that still has not started may be rewritten; the scheduler may have claimed it meanwhile.
  const [updated] = await ctx.db
    .update(posts)
    .set({ text, status: action === 'draft' ? 'draft' : 'scheduled', scheduledAt, updatedAt: ctx.now() })
    .where(and(eq(posts.id, id), inArray(posts.status, ['draft', 'scheduled'])))
    .returning();
  if (!updated) throw conflict('This post started publishing while you were editing it.');
  await writeContent(ctx, id, input.mediaIds ? mediaRows : null, input.targets ? targets : null);
  await auditAs(ctx, actor, {
    action: action === 'draft' ? 'post.updated' : action === 'schedule' ? 'post.scheduled' : 'post.publish_requested',
    targetType: 'post',
    targetId: id,
    metadata: { scheduledAt },
  });
  if (action === 'publish') ctx.scheduler.kick();
  return getPostUnchecked(ctx, id);
}

/** Removes the post here. Anything already published stays on the network. */
export async function deletePost(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  need(actor, 'posts:write');
  const row = await usePost(ctx, actor, id);
  if (row.status === 'publishing') throw conflict('This post is being published right now. Try again in a minute.');
  await ctx.db.delete(posts).where(eq(posts.id, id));
  await auditAs(ctx, actor, {
    action: 'post.deleted',
    targetType: 'post',
    targetId: id,
    metadata: { status: row.status },
  });
}

/** Tries the failed accounts of a post again. Accounts that already published are left alone. */
export async function retryPost(ctx: AppContext, actor: Actor, id: string): Promise<Post> {
  need(actor, 'posts:write');
  const row = await usePost(ctx, actor, id);
  if (row.status !== 'failed' && row.status !== 'partial') {
    throw conflict(`Only a failed or partly failed post can be retried; this one is ${row.status}.`);
  }
  await ctx.db
    .update(postTargets)
    .set({ status: 'pending', attempts: 0, error: null, nextAttemptAt: null, claimedAt: null })
    .where(and(eq(postTargets.postId, id), eq(postTargets.status, 'failed')));
  await ctx.db
    .update(posts)
    .set({ status: 'scheduled', scheduledAt: ctx.now(), updatedAt: ctx.now() })
    .where(eq(posts.id, id));
  await auditAs(ctx, actor, { action: 'post.retry_requested', targetType: 'post', targetId: id });
  ctx.scheduler.kick();
  return getPostUnchecked(ctx, id);
}
