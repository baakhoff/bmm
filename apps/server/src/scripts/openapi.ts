// Prints the OpenAPI document, for docs and client generation.
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const app = await buildApp(loadConfig({ DATABASE_URL: 'pglite://memory', BMM_LOG_LEVEL: 'silent' }));
await app.ready();
process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
