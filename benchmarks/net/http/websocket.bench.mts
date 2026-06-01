/**
 * Benchmarks for fino:net/http/websocket
 *
 * Run with: cargo run -- bench benchmarks/net/http/websocket.bench.mts
 */

import { CloseEvent, ErrorEvent, WebSocketConnection } from 'fino:net/http/websocket';
import { bench } from 'fino:bench';

bench('net/http websocket', (b) => {
  b.measure('event construction', () => {
    new CloseEvent('close', { code: 1000, reason: 'normal' });
    new ErrorEvent('error', { error: new Error('boom') });
  });
  b.measure('connection construction', () => new WebSocketConnection());
});
