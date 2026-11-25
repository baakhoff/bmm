import type { CreateProfileRequest, Profile, UpdateProfileRequest } from '@bmm/shared';
import { CreateProfileRequestSchema } from '@bmm/shared';
import { and, count, eq, inArray } from 'drizzle-orm';
import { auditAs } from '../audit.js';
import type { AppContext } from '../context.js';
import { accounts, media, posts, profiles } from '../db/schema.js';
import { uuidv7 } from '../lib/crypto.js';
import { forbidden } from '../lib/errors.js';
import { type Actor, need, useProfile } from './actor.js';

type Row = typeof profiles.$inferSelect;

function toProfile(p: Row, accountCount: number): Profile {
  return {
    id: p.id,
    name: p.name,
    timezone: p.timezone,
    color: p.color,
    notes: p.notes,
    accountCount,
    createdAt: p.createdAt.toISOString(),
  };
}

async function counts(ctx: AppContext, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.db
    .select({ profileId: accounts.profileId, n: count() })
    .from(accounts)
    .where(inArray(accounts.profileId, ids))
    .groupBy(accounts.profileId);
  return new Map(rows.map((r) => [r.profileId, r.n]));
}

export async function listProfiles(ctx: AppContext, actor: Actor): Promise<Profile[]> {
  need(actor, 'profiles:read');
  const limit = actor.auth.profileIds;
  if (limit && limit.length === 0) return [];
  const rows = await ctx.db
    .select()
    .from(profiles)
    .where(and(eq(profiles.userId, actor.auth.user.id), limit ? inArray(profiles.id, limit) : undefined))
    .orderBy(profiles.id);
  const c = await counts(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toProfile(r, c.get(r.id) ?? 0));
}

export async function getProfile(ctx: AppContext, actor: Actor, id: string): Promise<Profile> {
  need(actor, 'profiles:read');
  const row = await useProfile(ctx, actor, id);
  return toProfile(row, (await counts(ctx, [id])).get(id) ?? 0);
}

export async function createProfile(ctx: AppContext, actor: Actor, input: CreateProfileRequest): Promise<Profile> {
  need(actor, 'profiles:write');
  if (actor.auth.profileIds !== null) {
    throw forbidden('This API token is limited to certain profiles and cannot create new ones');
  }
  const v = CreateProfileRequestSchema.parse(input);
  const [row] = await ctx.db
    .insert(profiles)
    .values({
      id: uuidv7(),
      userId: actor.auth.user.id,
      name: v.name,
      timezone: v.timezone,
      color: v.color,
      notes: v.notes,
    })
    .returning();
  if (!row) throw new Error('insert returned nothing');
  await auditAs(ctx, actor, {
    action: 'profile.created',
    targetType: 'profile',
    targetId: row.id,
    metadata: { name: row.name },
  });
  return toProfile(row, 0);
}

export async function updateProfile(
  ctx: AppContext,
  actor: Actor,
  id: string,
  input: UpdateProfileRequest,
): Promise<Profile> {
  need(actor, 'profiles:write');
  await useProfile(ctx, actor, id);
  const [row] = await ctx.db
    .update(profiles)
    .set({ ...input, updatedAt: ctx.now() })
    .where(eq(profiles.id, id))
    .returning();
  if (!row) throw new Error('update returned nothing');
  await auditAs(ctx, actor, { action: 'profile.updated', targetType: 'profile', targetId: id, metadata: { ...input } });
  return toProfile(row, (await counts(ctx, [id])).get(id) ?? 0);
}

/** Removes the profile with its accounts, media and posts. Nothing is deleted on the networks. */
export async function deleteProfile(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  need(actor, 'profiles:write');
  const row = await useProfile(ctx, actor, id);
  const files = await ctx.db.select({ id: media.id }).from(media).where(eq(media.profileId, id));
  // Posts first: they hold references to media that must be gone before the
  // profile's own cascade reaches the media rows.
  await ctx.db.transaction(async (tx) => {
    await tx.delete(posts).where(eq(posts.profileId, id));
    await tx.delete(profiles).where(eq(profiles.id, id));
  });
  for (const f of files) await ctx.storage.delete(f.id).catch(() => undefined);
  await auditAs(ctx, actor, {
    action: 'profile.deleted',
    targetType: 'profile',
    targetId: id,
    metadata: { name: row.name },
  });
}
