import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, { N: n, r, p, maxmem: 256 * n * r }, (err, key) =>
      err ? rej(err) : res(key),
    );
  });
}

/** scrypt, parameters stored with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4] as string, 'base64url');
  const expected = Buffer.from(parts[5] as string, 'base64url');
  const key = await scrypt(password, salt, n, r, p, expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to compare against when the user does not exist, so timing says nothing. */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Secrets with 256 bits of entropy need no slow hash; SHA-256 is enough. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

let lastStamp = 0;

/**
 * UUIDv7: time-ordered, so it sorts by creation and indexes well. Ids made in
 * the same millisecond still come out in the order they were asked for.
 */
export function uuidv7(now = Date.now()): string {
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  const b = randomBytes(16);
  b.writeUIntBE(lastStamp, 0, 6);
  b[6] = ((b[6] as number) & 0x0f) | 0x70;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
