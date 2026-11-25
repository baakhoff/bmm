import { createHash } from 'node:crypto';
import type { Account, Network } from '@bmm/shared';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { auditAs } from '../audit.js';
import { ConnectorError } from '../connectors/types.js';
import type { AppContext } from '../context.js';
import { accounts, oauthStates, profiles } from '../db/schema.js';
import { randomToken, uuidv7 } from '../lib/crypto.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { type Actor, mayUseProfile, need, useProfile } from './actor.js';
import { appCreds, redirectUri } from './networks.js';

type Row = typeof accounts.$inferSelect;
const STATE_TTL_MS = 10 * 60_000;

export function toAccount(a: Row): Account {
  return {
    id: a.id,
    profileId: a.profileId,
    network: a.network,
    externalId: a.externalId,
    username: a.username,
    displayName: a.displayName,
    avatarUrl: a.avatarUrl,
    status: a.status,
    connectedAt: a.createdAt.toISOString(),
  };
}

export async function listAccounts(ctx: AppContext, actor: Actor, profileId?: string): Promise<Account[]> {
  need(actor, 'accounts:read');
  if (profileId) await useProfile(ctx, actor, profileId);
  const limit = actor.auth.profileIds;
  if (!profileId && limit && limit.length === 0) return [];
  const rows = await ctx.db
    .select({ a: accounts })
    .from(accounts)
    .innerJoin(profiles, eq(profiles.id, accounts.profileId))
    .where(
      and(
        eq(profiles.userId, actor.auth.user.id),
        profileId ? eq(accounts.profileId, profileId) : limit ? inArray(accounts.profileId, limit) : undefined,
      ),
    )
    .orderBy(accounts.id);
  return rows.map((r) => toAccount(r.a));
}

export async function useAccount(ctx: AppContext, actor: Actor, id: string): Promise<Row> {
  const [row] = await ctx.db
    .select({ a: accounts })
    .from(accounts)
    .innerJoin(profiles, eq(profiles.id, accounts.profileId))
    .where(and(eq(accounts.id, id), eq(profiles.userId, actor.auth.user.id)))
    .limit(1);
  if (!row || !mayUseProfile(actor, row.a.profileId)) throw notFound('No such account');
  return row.a;
}

/** Forgets the account and its tokens here. The network still lists BMM as an authorised app until removed there. */
export async function disconnectAccount(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  need(actor, 'accounts:write');
  const row = await useAccount(ctx, actor, id);
  await ctx.db.delete(accounts).where(eq(accounts.id, id));
  await auditAs(ctx, actor, {
    action: 'account.disconnected',
    targetType: 'account',
    targetId: id,
    metadata: { network: row.network, username: row.username, profileId: row.profileId },
  });
}

/** Step one of connecting: the address to send the browser to. */
export async function beginConnect(
  ctx: AppContext,
  actor: Actor,
  profileId: string,
  network: Network,
): Promise<string> {
  need(actor, 'accounts:write');
  await useProfile(ctx, actor, profileId);
  const redirect = redirectUri(ctx, network);
  if (!redirect)
    throw badRequest('Connecting accounts needs BMM_PUBLIC_URL, the address the network redirects back to.');
  const app = await appCreds(ctx, network);
  const state = randomToken(24);
  const codeVerifier = randomToken(48);
  await ctx.db.delete(oauthStates).where(lt(oauthStates.expiresAt, ctx.now()));
  await ctx.db.insert(oauthStates).values({
    state,
    network,
    profileId,
    userId: actor.auth.user.id,
    codeVerifier,
    expiresAt: new Date(ctx.now().getTime() + STATE_TTL_MS),
  });
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return ctx.connectors[network].authorizeUrl(app, redirect, state, challenge);
}

/** Step two: the network sent the browser back with a code. Returns the profile to show. */
export async function completeConnect(
  ctx: AppContext,
  actor: Actor,
  network: Network,
  query: { state?: string; code?: string; error?: string; error_description?: string },
): Promise<{ profileId: string; account: Account }> {
  if (!query.state) throw badRequest('The network sent no state back');
  const [pending] = await ctx.db.delete(oauthStates).where(eq(oauthStates.state, query.state)).returning();
  if (!pending || pending.network !== network || pending.expiresAt < ctx.now()) {
    throw badRequest('This connection attempt expired or was already used. Start it again.');
  }
  // Whoever finishes must be whoever started, in the same browser.
  if (actor.auth.via !== 'session' || actor.auth.user.id !== pending.userId) {
    throw new HttpError(403, 'forbidden', 'Finish connecting in the browser you started in.');
  }
  if (query.error || !query.code) {
    throw new HttpError(
      400,
      'denied',
      query.error_description || query.error || 'The network sent no authorisation code',
    );
  }
  const redirect = redirectUri(ctx, network) as string;
  const app = await appCreds(ctx, network);
  let result: Awaited<ReturnType<(typeof ctx.connectors)[Network]['exchangeCode']>>;
  try {
    result = await ctx.connectors[network].exchangeCode(app, redirect, query.code, pending.codeVerifier);
  } catch (err) {
    if (err instanceof ConnectorError) throw new HttpError(502, 'network_refused', err.message);
    throw err;
  }
  const { tokens, account } = result;
  const fields = {
    username: account.username,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    accessTokenEnc: ctx.secrets.encrypt(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken ? ctx.secrets.encrypt(tokens.refreshToken) : null,
    tokenExpiresAt: tokens.expiresAt,
    tokenRefreshedAt: ctx.now(),
    scopes: tokens.scopes,
    status: 'active' as const,
    updatedAt: ctx.now(),
  };
  const [existing] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.network, network), eq(accounts.externalId, account.externalId)))
    .limit(1);
  let row: Row | undefined;
  if (existing) {
    if (existing.profileId !== pending.profileId) {
      throw conflict(`@${account.username} is already connected to another profile. Disconnect it there first.`);
    }
    [row] = await ctx.db.update(accounts).set(fields).where(eq(accounts.id, existing.id)).returning();
  } else {
    [row] = await ctx.db
      .insert(accounts)
      .values({ id: uuidv7(), profileId: pending.profileId, network, externalId: account.externalId, ...fields })
      .returning();
  }
  if (!row) throw new Error('account write returned nothing');
  await auditAs(ctx, actor, {
    action: existing ? 'account.reconnected' : 'account.connected',
    targetType: 'account',
    targetId: row.id,
    metadata: { network, username: row.username, profileId: row.profileId },
  });
  return { profileId: pending.profileId, account: toAccount(row) };
}
