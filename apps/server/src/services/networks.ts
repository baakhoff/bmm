import { NETWORKS, type Network, type NetworkApp, type NetworksStatus, type SetNetworkAppRequest } from '@bmm/shared';
import { eq } from 'drizzle-orm';
import { auditAs } from '../audit.js';
import type { AppCreds } from '../connectors/types.js';
import type { AppContext } from '../context.js';
import { networkApps } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { type Actor, need } from './actor.js';

export function redirectUri(ctx: AppContext, network: Network): string | null {
  return ctx.config.publicUrl ? new URL(`/api/v1/oauth/${network}/callback`, ctx.config.publicUrl).toString() : null;
}

export async function networksStatus(ctx: AppContext, actor: Actor): Promise<NetworksStatus> {
  need(actor, 'accounts:read');
  const rows = await ctx.db.select().from(networkApps);
  const apps: NetworkApp[] = NETWORKS.map((network) => {
    const row = rows.find((r) => r.network === network);
    return {
      network,
      configured: Boolean(row),
      clientId: row?.clientId ?? null,
      redirectUri: redirectUri(ctx, network),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });
  return { apps, publicMediaUrl: ctx.config.publicMediaUrl?.toString() ?? null };
}

/** Instance-wide, so it takes the admin scope: these credentials act for every profile. */
export async function setNetworkApp(
  ctx: AppContext,
  actor: Actor,
  network: Network,
  input: SetNetworkAppRequest,
): Promise<void> {
  need(actor, 'admin');
  const values = {
    clientId: input.clientId,
    clientSecretEnc: ctx.secrets.encrypt(input.clientSecret),
    updatedAt: ctx.now(),
  };
  await ctx.db
    .insert(networkApps)
    .values({ network, ...values })
    .onConflictDoUpdate({ target: networkApps.network, set: values });
  await auditAs(ctx, actor, {
    action: 'network.app_set',
    targetType: 'network',
    targetId: network,
    metadata: { clientId: input.clientId },
  });
}

export async function removeNetworkApp(ctx: AppContext, actor: Actor, network: Network): Promise<void> {
  need(actor, 'admin');
  await ctx.db.delete(networkApps).where(eq(networkApps.network, network));
  await auditAs(ctx, actor, { action: 'network.app_removed', targetType: 'network', targetId: network });
}

export async function appCreds(ctx: AppContext, network: Network): Promise<AppCreds> {
  const [row] = await ctx.db.select().from(networkApps).where(eq(networkApps.network, network)).limit(1);
  if (!row) {
    throw badRequest(
      `No developer app is configured for ${network}. Add its client ID and secret under Settings, Networks.`,
    );
  }
  return { clientId: row.clientId, clientSecret: ctx.secrets.decrypt(row.clientSecretEnc) };
}
