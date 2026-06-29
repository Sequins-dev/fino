/**
 * Benchmarks for internal:net/http/driver
 *
 * Run with: cargo run -- bench benchmarks/net/http/driver.bench.ts
 */

import { isConnectionTakeover } from '../../../js/net/http/driver.ts';
import { bench } from 'fino:bench';

bench('net/http driver', (b) => {
  b.measure('isConnectionTakeover false', () => isConnectionTakeover(new Response('ok')));
  b.measure('isConnectionTakeover true', () => isConnectionTakeover({
    compatibleProtocols: new Set(['http/1.1']),
    _takeOver: () => Promise.resolve(undefined),
  }));
});
