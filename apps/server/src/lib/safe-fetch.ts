import { BlockList, isIP } from 'node:net';
import { badRequest } from './errors.js';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return !blocked.check(mapped[1] as string, 'ipv4');
  return !blocked.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Downloads something a caller named by URL. BMM sits inside a private
 * network, and "fetch this address for me" must not become a way to read
 * what only BMM can reach, so every hop has to resolve to a public address.
 */
export async function fetchPublic(
  url: string,
  deps: { fetch: typeof fetch; lookup: (host: string) => Promise<string[]> },
  maxBytes: number,
): Promise<{ data: Buffer; contentType: string | null; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw badRequest('Not a valid URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw badRequest('Only http and https addresses can be imported');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : await deps.lookup(host).catch(() => []);
    if (addresses.length === 0) throw badRequest(`Could not resolve ${host}`);
    if (!addresses.every(isPublicAddress)) {
      throw badRequest('That address points into a private network. Only public addresses can be imported.');
    }
    let res: Response;
    try {
      res = await deps.fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    } catch {
      throw badRequest('Could not download that address');
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw badRequest('The address redirected nowhere');
      current = new URL(next, current).toString();
      continue;
    }
    if (!res.ok) throw badRequest(`The address answered ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw badRequest(`The file is larger than ${Math.floor(maxBytes / 1048576)} MB`);
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) throw badRequest(`The file is larger than ${Math.floor(maxBytes / 1048576)} MB`);
        chunks.push(Buffer.from(chunk));
      }
    }
    return { data: Buffer.concat(chunks), contentType: res.headers.get('content-type'), finalUrl: current };
  }
  throw badRequest('Too many redirects');
}
