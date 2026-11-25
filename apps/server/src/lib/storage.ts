import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Where media bytes live. One implementation today: a directory, which is a
 * volume in Kubernetes and Compose. The interface is what an S3 driver has
 * to provide later.
 */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<{ stream: Readable; bytes: number }>;
  delete(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error('Bad storage key');
    return join(this.root, key.slice(-2), key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async stream(key: string): Promise<{ stream: Readable; bytes: number }> {
    const file = this.path(key);
    const { size } = await stat(file);
    return { stream: createReadStream(file), bytes: size };
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** For tests: nothing touches the disk. */
export class MemoryStorage implements Storage {
  private readonly items = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.items.set(key, data);
  }
  async get(key: string) {
    const v = this.items.get(key);
    if (!v) throw new Error('Not found in storage');
    return v;
  }
  async stream(key: string) {
    const { Readable } = await import('node:stream');
    const v = await this.get(key);
    return { stream: Readable.from(v), bytes: v.length };
  }
  async delete(key: string) {
    this.items.delete(key);
  }
}
