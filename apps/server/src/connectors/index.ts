import type { Network } from '@bmm/shared';
import { instagramConnector } from './instagram.js';
import type { Connector, NetDeps } from './types.js';
import { xConnector } from './x.js';

export function buildConnectors(net: NetDeps): Record<Network, Connector> {
  return { x: xConnector(net), instagram: instagramConnector(net) };
}
