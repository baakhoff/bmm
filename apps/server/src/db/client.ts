import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: 'postgres' | 'pglite';
  ping(): Promise<void>;
  close(): Promise<void>;
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * Opens the database and brings its schema up to date.
 *
 * postgres://  a real server; what the Helm chart and compose file use.
 * pglite://    Postgres compiled to WASM, in-process. No server to run, one
 *              process only: good for trying BMM out and for tests.
 */
export async function openDb(url: string): Promise<DbHandle> {
  if (url.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const target = url.slice('pglite://'.length);
    let client: InstanceType<typeof PGlite>;
    if (target === 'memory' || target === '') {
      client = new PGlite();
    } else {
      const dir = resolve(target);
      mkdirSync(dir, { recursive: true });
      client = new PGlite(dir);
    }
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    return {
      db: db as unknown as Db,
      kind: 'pglite',
      ping: async () => {
        await client.query('select 1');
      },
      close: () => client.close(),
    };
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('DATABASE_URL must start with postgres:// or pglite://');
  }
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  // Migrations take a lock-friendly single connection, then the pool opens.
  const migrator = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(migrator), { migrationsFolder });
  } finally {
    await migrator.end();
  }
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Db,
    kind: 'postgres',
    ping: async () => {
      await client`select 1`;
    },
    close: () => client.end({ timeout: 5 }),
  };
}

export { schema };
