/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { Box, LineChart } from 'fino:ui/components';
import { renderFrame } from 'fino:tty/tui';

const points = [3, 7, 4, 9, 5, 8, 6, 10];

function plotWidth(frameWidth: number, showAxis = false): number {
  const out = renderFrame(
    <Box direction="column" width={frameWidth}>
      <LineChart series={[{ key: 'a', points }]} height={5} showAxis={showAxis} />
    </Box>,
    { width: frameWidth, height: 7 },
  );
  return Math.max(
    ...out
      .split('\n')
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '').length),
  );
}

describe('line chart fills its container', () => {
  it('widens with the available width', (t) => {
    const narrow = plotWidth(24);
    const wide = plotWidth(70);
    t.ok(narrow <= 24, `narrow plot stays inside its box (${narrow})`);
    t.ok(wide > narrow + 20, `wide plot expands to fill (${narrow} → ${wide})`);
    t.ok(wide <= 70, `wide plot does not overflow its box (${wide})`);
  });

  it('leaves room for the axis gutter when axis labels are shown', (t) => {
    const withAxis = plotWidth(60, true);
    t.ok(withAxis <= 60, `axis variant stays inside the box (${withAxis})`);
    t.ok(withAxis > 40, `axis variant still fills most of the width (${withAxis})`);
  });
});
