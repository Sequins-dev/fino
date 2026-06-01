/**
 * Benchmarks for fino:context/topic
 *
 * Run with: cargo run -- bench benchmarks/context/topic.bench.mts
 */

import { topic } from 'fino:context/topic';
import { bench } from 'fino:bench';

const messages = topic<{ value: number }>('bench:topic');

bench('Topic publish/subscribe', (b) => {
  b.measure('topic lookup', () => topic('bench:topic'));
  b.measure('subscribe/unsubscribe', () => {
    const subscription = messages.subscribe(() => undefined);
    subscription.dispose();
  });
  b.measure('publish without subscribers', () => messages.publish({ value: 1 }));
});
