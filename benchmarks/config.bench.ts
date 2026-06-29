/**
 * Benchmarks for fino:config
 *
 * Run with: cargo run -- bench benchmarks/config.bench.ts
 */

import { loadConfig } from 'fino:config';
import { DiskFileSystem } from 'fino:file';
import { pid } from 'fino:process';
import { v } from 'fino:validate';
import { bench } from 'fino:bench';

const fs = new DiskFileSystem();
const CONFIG_PATH = `/tmp/fino-config-bench-${pid}.json`;
await fs.writeFile(CONFIG_PATH, JSON.stringify({
  server: { host: 'file-host', port: 4000 },
  feature: true,
}));

const schema = v.object({
  server: v.object({
    host: v.string(),
    port: v.integer().min(1),
  }),
  mode: v.string().default('dev'),
  feature: v.boolean().default(false),
});

bench('config', (b) => {
  b.measure('loadConfig defaults/file/env/argv', () => loadConfig({
    schema,
    sources: [
      { type: 'defaults', value: { server: { host: 'default-host', port: 3000 }, mode: 'default' } },
      { type: 'file', path: CONFIG_PATH },
      { type: 'env', values: { APP_HOST: 'env-host' }, map: { APP_HOST: 'server.host' } },
      { type: 'argv', args: ['--server.port', '7000', '--mode', 'prod'], map: { '--server.port': 'server.port', '--mode': 'mode' } },
      { type: 'override', value: { feature: false } },
    ],
  }));
});
