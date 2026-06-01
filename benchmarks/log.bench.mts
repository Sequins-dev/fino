/**
 * Benchmarks for fino:log
 *
 * Run with: cargo run -- bench benchmarks/log.bench.mts
 */

import { createLogger, runWithLogContext } from 'fino:log';
import { bench } from 'fino:bench';

const logger = createLogger({ name: 'bench', level: 'fatal', context: { component: 'bench' } });

bench('log', (b) => {
  b.measure('createLogger', () => createLogger({ name: 'bench.child' }));
  b.measure('filtered debug log', () => logger.debug('not emitted'));
  b.measure('runWithLogContext', () => runWithLogContext({ requestId: 'abc' }, () => undefined));
});
