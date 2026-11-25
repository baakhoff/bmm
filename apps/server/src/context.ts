import type { Network } from '@bmm/shared';
import type { Config } from './config.js';
import type { Connector, NetDeps } from './connectors/types.js';
import type { Db, DbHandle } from './db/client.js';
import type { SecretBox } from './lib/secretbox.js';
import type { Storage } from './lib/storage.js';
import type { Scheduler } from './services/scheduler.js';
import type { UpdateChecker } from './updates.js';

export interface AppContext {
  config: Config;
  db: Db;
  dbHandle: DbHandle;
  version: string;
  updates: UpdateChecker;
  secrets: SecretBox;
  storage: Storage;
  net: NetDeps;
  connectors: Record<Network, Connector>;
  scheduler: Scheduler;
  /** The clock. Replaced in tests to move time. */
  now: () => Date;
  /** Resolves a host name for the "import from a URL" guard. Replaced in tests. */
  lookup: (host: string) => Promise<string[]>;
  log: {
    info: (o: object, msg?: string) => void;
    warn: (o: object, msg?: string) => void;
    error: (o: object, msg?: string) => void;
  };
}
