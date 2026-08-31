/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { Box, FloatingActionBar, Text } from 'fino:ui/components';
import { renderFrame } from 'fino:tty/tui';
import { toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';

type Placement = 'bottom-start' | 'bottom-center' | 'bottom-end';

function rows(placement: Placement, width = 40): string[] {
  return renderFrame(
    <Box direction="column" width={width}>
      <Box id="pane" direction="column" width={width} height={6} border>
        <Text>content</Text>
      </Box>
      <FloatingActionBar anchorId="pane" placement={placement}>
        <Text>Jump</Text>
      </FloatingActionBar>
    </Box>,
    { width, height: 7 },
  )
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, ''));
}

/** Column where the bar's own box starts, ignoring the container's border. */
function barSpan(placement: Placement, width = 40): { left: number; right: number; row: number } {
  const all = rows(placement, width);
  const row = all.findIndex((l) => l.includes('Jump'));
  const line = all[row]!;
  const label = line.indexOf('Jump');
  // Scan outward from the label so the container's own border is not mistaken
  // for the bar's edge.
  const left = line.lastIndexOf('│', label);
  const right = line.indexOf('│', label);
  return { left, right, row };
}

describe('FloatingActionBar placement in the terminal', () => {
  it('centers within its parent', (t) => {
    const { left, right } = barSpan('bottom-center');
    const leftGap = left;
    const rightGap = 39 - right;
    t.ok(Math.abs(leftGap - rightGap) <= 1, `balanced margins (${leftGap} vs ${rightGap})`);
    t.ok(left > 8, `not left-aligned (left=${left})`);
  });

  it('left-aligns inside its parent when asked', (t) => {
    const { left } = barSpan('bottom-start');
    t.equal(left, 0, `flush with the parent's left edge (left=${left})`);
  });

  it('right-aligns inside its parent when asked', (t) => {
    const { right } = barSpan('bottom-end');
    t.equal(right, 39, `flush with the parent's right edge (right=${right})`);
  });

  it('tracks the parent width as it changes', (t) => {
    const narrow = barSpan('bottom-center', 30).left;
    const wide = barSpan('bottom-center', 60).left;
    t.ok(wide > narrow + 10, `centre follows the container (${narrow} → ${wide})`);
  });

  it('sits inside the parent rather than below it', (t) => {
    const { row } = barSpan('bottom-center');
    t.ok(row > 0 && row < 6, `within the 6-row pane (row ${row})`);
  });
});

describe('FloatingActionBar placement on the web', () => {
  it('maps each placement to a justification', (t) => {
    const html = (p: Placement): string =>
      renderToHtml(
        toHtml(
          <FloatingActionBar anchorId="pane" placement={p}>
            <Text>Jump</Text>
          </FloatingActionBar>,
        ),
      );
    t.ok(html('bottom-start').includes('ui-fab-start'), 'start');
    t.ok(html('bottom-center').includes('ui-fab-center'), 'center');
    t.ok(html('bottom-end').includes('ui-fab-end'), 'end');
  });
});
