/**
 * Benchmarks for fino:cluster
 *
 * Run with: cargo run -- bench benchmarks/cluster.bench.mts
 */

import { getCluster } from 'fino:cluster';
import { bench } from 'fino:bench';

bench('cluster state', (b) => {
  b.measure('getCluster()', () => getCluster());
});
