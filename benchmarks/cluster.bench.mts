/**
 * Benchmarks for fino:cluster
 *
 * Run with: cargo run -- bench benchmarks/cluster.bench.mts
 */

import { getCluster, joinCluster, leaveCluster, startCluster } from 'fino:cluster';
import { bench } from 'fino:bench';

bench('cluster state', (b) => {
  b.measure('getCluster() inactive', () => getCluster());
  b.measure('leaveCluster() inactive', () => leaveCluster());
});

bench('cluster public API references', (b) => {
  b.measure('operation references', () => {
    return startCluster !== undefined &&
      joinCluster !== undefined &&
      leaveCluster !== undefined &&
      getCluster !== undefined;
  });
});
