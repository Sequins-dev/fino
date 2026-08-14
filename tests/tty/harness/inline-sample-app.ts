// Minimal inline-mode app for PTY harness testing of renderInline itself.
//
// Keys: printable chars edit the composer; Enter commits two history lines;
// G/S grow/shrink the footer by one pad row; O opens a fullscreen overlay
// (Esc closes it); P prints one history line while the overlay is open;
// Q stops the app.
import { exit } from 'fino:process';
import { h, Box, Text, renderInline, type InlineFrame } from 'fino:tty/tui';

import type { OverlayHandle } from 'fino:tty/tui';

let typed = '';
let count = 0;
let pad = 0;
let overlay: OverlayHandle | null = null;

function frame(): InlineFrame {
  const lines: string[] = [];
  for (let i = 0; i < pad; i++) lines.push(`pad ${i + 1}`);
  lines.push(`❯ ${typed}`);
  lines.push(`status · ${count} committed · pad ${pad}`);
  return { lines, cursor: { row: pad, column: 2 + typed.length } };
}

const app = renderInline(frame(), {
  onEvent(event, app) {
    if (event.type !== 'key') return;
    if (overlay !== null) {
      if (event.key === 'P') {
        app.printAbove([`overlay-queued ${count}`]);
      } else if (event.key === 'escape' || event.key === 'O') {
        overlay.close();
        overlay = null;
        app.update(frame());
      }
      return;
    }
    if (event.key === 'Q') {
      void app.stop().then(() => exit(0));
      return;
    }
    if (event.key === 'enter') {
      count += 1;
      app.printAbove([`# entry ${count}`, `  ${typed || '(empty)'}`]);
      typed = '';
    } else if (event.key === 'G') {
      pad += 1;
    } else if (event.key === 'S') {
      pad = Math.max(0, pad - 1);
    } else if (event.key === 'O') {
      overlay = app.enterOverlay(
        h(
          Box,
          { border: true, padding: 1 },
          h(Text, null, 'overlay view'),
          h(Text, null, `count ${count}`),
        ),
      );
      return;
    } else if (event.key === 'backspace') {
      typed = typed.slice(0, -1);
    } else if (event.text !== undefined && event.text.length === 1) {
      typed += event.text;
    }
    app.update(frame());
  },
});
void app;
