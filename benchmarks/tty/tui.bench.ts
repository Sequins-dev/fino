/**
 * Benchmarks for fino:tty/tui
 *
 * Run with: cargo run -- bench benchmarks/tty/tui.bench.ts
 */

import { bench } from 'fino:bench';
import { h } from 'fino:ui';
import { Box, List, Text, renderFrame } from 'fino:tty/tui';

const frame = h(Box, { border: true, padding: 1, direction: 'column', gap: 1 },
  h(Text, { wrap: true }, 'Fino terminal UI renders deterministic frames for snapshots and tests.'),
  h(List, { items: ['build', 'test', 'bench', 'ship'], selectedIndex: 1 }),
);

bench('tty/tui', (b) => {
  b.measure('renderFrame 80x24', () => renderFrame(frame, { width: 80, height: 24 }));
  b.measure('renderFrame 40x10', () => renderFrame(frame, { width: 40, height: 10 }));
});
