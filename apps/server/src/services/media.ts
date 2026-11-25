import type { ImportMediaRequest, Media } from '@bmm/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import sharp, { type Metadata } from 'sharp';
import { auditAs } from '../audit.js';
import type { AppContext } from '../context.js';
import { media, postMedia, profiles } from '../db/schema.js';
import { uuidv7 } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { fetchPublic } from '../lib/safe-fetch.js';
import { type Actor, mayUseProfile, need, useProfile } from './actor.js';

type Row = typeof media.$inferSelect;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
const PUBLIC_TTL_MS = 2 * 3_600_000;
const FORMATS: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function toMedia(m: Row): Media {
  return {
    id: m.id,
    profileId: m.profileId,
    kind: m.kind,
    mime: m.mime,
    width: m.width,
    height: m.height,
    bytes: m.bytes,
    filename: m.filename,
    alt: m.alt,
    contentUrl: `/api/v1/media/${m.id}/content`,
    createdAt: m.createdAt.toISOString(),
  };
}

function cleanName(name: string | undefined, ext: string): string {
  const base =
    (name ?? '')
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^\w.\- ]+/g, '_')
      .slice(0, 120) || `image.${ext}`;
  return base;
}

/**
 * Stores an image. The file's own bytes decide what it is, not its name or
 * the content type the sender claimed.
 */
export async function addMedia(
  ctx: AppContext,
  actor: Actor,
  input: { profileId: string; data: Buffer; filename?: string; alt?: string },
): Promise<Media> {
  need(actor, 'media:write');
  await useProfile(ctx, actor, input.profileId);
  if (input.data.length === 0) throw badRequest('The file is empty');
  if (input.data.length > MAX_UPLOAD_BYTES) throw badRequest('The file is larger than 20 MB');
  let meta: Metadata;
  try {
    meta = await sharp(input.data, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw badRequest('Not an image BMM can read. Use JPEG, PNG or WebP.');
  }
  const mime = meta.format ? FORMATS[meta.format] : undefined;
  if (!mime || !meta.width || !meta.height) throw badRequest('Not an image BMM can read. Use JPEG, PNG or WebP.');
  // Phones store portrait photos sideways with a rotation flag; report the size as seen.
  const rotated = (meta.orientation ?? 1) >= 5;
  const id = uuidv7();
  await ctx.storage.put(id, input.data);
  const [row] = await ctx.db
    .insert(media)
    .values({
      id,
      profileId: input.profileId,
      kind: 'image',
      mime,
      width: rotated ? meta.height : meta.width,
      height: rotated ? meta.width : meta.height,
      bytes: input.data.length,
      filename: cleanName(input.filename, meta.format as string),
      alt: (input.alt ?? '').slice(0, 1000),
    })
    .returning();
  if (!row) throw new Error('insert returned nothing');
  await auditAs(ctx, actor, {
    action: 'media.added',
    targetType: 'media',
    targetId: id,
    metadata: { profileId: input.profileId, filename: row.filename, bytes: row.bytes },
  });
  return toMedia(row);
}

export async function importMedia(ctx: AppContext, actor: Actor, input: ImportMediaRequest): Promise<Media> {
  need(actor, 'media:write');
  await useProfile(ctx, actor, input.profileId);
  let data: Buffer;
  let filename = input.filename;
  if (input.url) {
    const got = await fetchPublic(input.url, { fetch: ctx.net.fetch, lookup: ctx.lookup }, MAX_UPLOAD_BYTES);
    data = got.data;
    filename ??= decodeURIComponent(new URL(got.finalUrl).pathname.split('/').pop() ?? '');
  } else {
    const b64 = (input.dataBase64 ?? '').replace(/^data:[^,]*,/, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64.replace(/\s+/g, ''))) throw badRequest('dataBase64 is not base64');
    data = Buffer.from(b64, 'base64');
  }
  return addMedia(ctx, actor, { profileId: input.profileId, data, filename, alt: input.alt });
}

export async function useMedia(ctx: AppContext, actor: Actor, id: string): Promise<Row> {
  const [row] = await ctx.db
    .select({ m: media })
    .from(media)
    .innerJoin(profiles, eq(profiles.id, media.profileId))
    .where(and(eq(media.id, id), eq(profiles.userId, actor.auth.user.id)))
    .limit(1);
  if (!row || !mayUseProfile(actor, row.m.profileId)) throw notFound('No such media');
  return row.m;
}

export async function listMedia(ctx: AppContext, actor: Actor, profileId: string): Promise<Media[]> {
  need(actor, 'media:read');
  await useProfile(ctx, actor, profileId);
  const rows = await ctx.db
    .select()
    .from(media)
    .where(eq(media.profileId, profileId))
    .orderBy(desc(media.id))
    .limit(200);
  return rows.map(toMedia);
}

export async function getMedia(ctx: AppContext, actor: Actor, id: string): Promise<Media> {
  need(actor, 'media:read');
  return toMedia(await useMedia(ctx, actor, id));
}

export async function mediaContent(ctx: AppContext, actor: Actor, id: string) {
  need(actor, 'media:read');
  const row = await useMedia(ctx, actor, id);
  return { row, ...(await ctx.storage.stream(id)) };
}

export async function deleteMedia(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  need(actor, 'media:write');
  const row = await useMedia(ctx, actor, id);
  const [used] = await ctx.db.select().from(postMedia).where(eq(postMedia.mediaId, id)).limit(1);
  if (used) throw conflict('A post uses this image. Delete the post, or take the image off it, first.');
  await ctx.db.delete(media).where(eq(media.id, id));
  await ctx.storage.delete(id).catch(() => undefined);
  await auditAs(ctx, actor, {
    action: 'media.deleted',
    targetType: 'media',
    targetId: id,
    metadata: { filename: row.filename },
  });
}

/** Media rows for a post, in order, all from the given profile. */
export async function mediaForPost(ctx: AppContext, profileId: string, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  if (new Set(ids).size !== ids.length) throw badRequest('The same image is attached twice');
  const rows = await ctx.db
    .select()
    .from(media)
    .where(and(inArray(media.id, ids), eq(media.profileId, profileId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw badRequest(`Media ${id} does not exist in this profile`);
    return r;
  });
}

/**
 * A link Instagram can download the image from: no sign-in, but signed and
 * short-lived, so knowing one link gives access to one image for two hours.
 */
export function publicJpegUrl(ctx: AppContext, mediaId: string): string | null {
  const base = ctx.config.publicMediaUrl;
  if (!base) return null;
  const exp = Math.floor((ctx.now().getTime() + PUBLIC_TTL_MS) / 1000);
  const sig = ctx.secrets.sign(`media:${mediaId}:${exp}`);
  const root = base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`;
  return new URL(`public/media/${mediaId}/${exp}/${sig}.jpg`, root).toString();
}

export async function publicJpeg(ctx: AppContext, mediaId: string, exp: string, sig: string): Promise<Buffer> {
  const expires = Number(exp);
  if (!Number.isInteger(expires) || expires * 1000 < ctx.now().getTime()) throw notFound();
  if (!ctx.secrets.verify(`media:${mediaId}:${expires}`, sig)) throw notFound();
  const [row] = await ctx.db.select().from(media).where(eq(media.id, mediaId)).limit(1);
  if (!row) throw notFound();
  return toJpeg(await ctx.storage.get(mediaId));
}

export function toJpeg(data: Buffer): Promise<Buffer> {
  return sharp(data, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}
