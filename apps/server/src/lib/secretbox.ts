import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Encrypts what must not sit in the database in the clear: the networks'
 * client secrets and every account's access and refresh tokens. A database
 * dump alone is then not enough to post as someone.
 *
 * AES-256-GCM, a fresh nonce per value, the key derived from BMM_SECRET_KEY.
 */
export class SecretBox {
  private readonly key: Buffer;
  private readonly signKey: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(`bmm:enc:${secret}`).digest();
    this.signKey = createHash('sha256').update(`bmm:sign:${secret}`).digest();
  }

  /** Uses BMM_SECRET_KEY, or creates and keeps a key file in the data directory. */
  static open(configured: string | undefined, dataDir: string): SecretBox {
    if (configured) return new SecretBox(configured);
    const file = join(dataDir, 'secret.key');
    if (!existsSync(file)) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    }
    return new SecretBox(readFileSync(file, 'utf8').trim());
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
  }

  decrypt(boxed: string): string {
    const [v, iv, tag, body] = boxed.split('.');
    if (v !== 'v1' || !iv || !tag || body === undefined) throw new Error('Not an encrypted value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Could not decrypt a stored secret. BMM_SECRET_KEY differs from the one it was saved with.');
    }
  }

  /** A signature for links that must work without signing in. */
  sign(message: string): string {
    return createHmac('sha256', this.signKey).update(message).digest('base64url');
  }

  verify(message: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(message));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
