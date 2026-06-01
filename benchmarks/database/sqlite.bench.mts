/**
 * Benchmarks for fino:database/sqlite
 *
 * Run with: cargo run -- bench benchmarks/database/sqlite.bench.mts
 */

import { Database, sqliteAvailable, vec, vecDecode } from 'fino:database/sqlite';
import { bench } from 'fino:bench';

const vecBlob = new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer);

bench('database/sqlite helpers', (b) => {
  b.measure('sqliteAvailable flag', () => sqliteAvailable);
  b.measure('Database class reference', () => Database);
  b.measure('vec encode', () => vec([1, 2, 3, 4]));
  b.measure('vecDecode', () => vecDecode(vecBlob));
});
