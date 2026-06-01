/**
 * Benchmarks for fino:messaging
 *
 * Run with: cargo run -- bench benchmarks/runtime/messaging.bench.mts
 */

import { MessageChannel, MessageEvent } from 'fino:messaging';
import { bench } from 'fino:bench';

bench('messaging primitives', (b) => {
  b.measure('MessageChannel construct/close', () => {
    const channel = new MessageChannel();
    channel.port1.close();
    channel.port2.close();
  });
  b.measure('MessageEvent construct', () => new MessageEvent('message', { data: { ok: true } }));
});
