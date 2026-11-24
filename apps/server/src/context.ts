import type { Config } from './config.js';
import type { Db, DbHandle } from './db/client.js';

export interface AppContext {
  config: Config;
  db: Db;
  dbHandle: DbHandle;
  version: string;
}
