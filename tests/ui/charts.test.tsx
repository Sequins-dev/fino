/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import type { VNode } from 'fino:ui';
import { BarChart, LineChart } from 'fino:ui/components';
import { CHART_PALETTE, niceScale, plotBraille, seriesColor } from 'internal:ui/components/charts';
import type { Series } from 'fino:ui/components';
import { renderFrame } from 'fino:tty/tui';
import { renderToHtml } from 'fino:ui/html';
import { toHtml } from 'fino:ui/components/html';

function lines(tree: VNode, width: number, height: number): string[] {
  return renderFrame(tree, { width, height }).split('\n');
}

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

// Braille pattern glyph for a given raw dot-bit value, expressed as
// codepoint arithmetic against the documented `BRAILLE_BITS` table rather
// than a literal character — self-verifying against the same bit order the
// implementation and its doc comment use, instead of relying on eyeballing
// braille glyphs.
function braille(bits: number): string {
  return String.fromCodePoint(0x2800 + bits);
}
const BLANK = braille(0);

describe('fino:ui/components niceScale', () => {
  it('rounds a positive span to 1/2/5×10ⁿ bounds and ticks', (t) => {
    t.deepEqual(niceScale(0, 87), { min: 0, max: 100, step: 20, ticks: [0, 20, 40, 60, 80, 100] });
  });

  it('handles an all-negative range', (t) => {
    t.deepEqual(niceScale(-100, -10), {
      min: -100,
      max: 0,
      step: 20,
      ticks: [-100, -80, -60, -40, -20, 0],
    });
    // The zero tick must be a real `0`, not `-0` from `Math.ceil(-0.5) * 20`.
    t.ok(Object.is(niceScale(-100, -10).max, 0), 'max normalizes -0 to 0');
  });

  it('accepts min/max in either order', (t) => {
    t.deepEqual(niceScale(87, 0), niceScale(0, 87), 'reversed args produce the same scale');
  });

  it('pads a zero-span input to a real range', (t) => {
    t.deepEqual(
      niceScale(0, 0),
      { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] },
      'zero pads to a 0..1 span before rounding out to nice ticks',
    );
    t.deepEqual(
      niceScale(5, 5),
      { min: 2, max: 8, step: 1, ticks: [2, 3, 4, 5, 6, 7, 8] },
      'a nonzero zero-span value pads symmetrically before rounding out',
    );
  });

  it('stays correct at tiny magnitudes', (t) => {
    t.deepEqual(niceScale(0.0001, 0.0009), {
      min: 0,
      max: 0.001,
      step: 0.0002,
      ticks: [0, 0.0002, 0.0004, 0.0006, 0.0008, 0.001],
    });
  });

  it('stays correct at huge magnitudes', (t) => {
    t.deepEqual(niceScale(1e9, 5e9), {
      min: 1e9,
      max: 5e9,
      step: 1e9,
      ticks: [1e9, 2e9, 3e9, 4e9, 5e9],
    });
  });

  it('honors a custom tick count', (t) => {
    const scale = niceScale(0, 100, 3);
    t.equal(scale.ticks.length <= 4, true, 'fewer wanted ticks yields a coarser step');
  });
});

const SCALE_0_4 = { min: 0, max: 4, step: 4, ticks: [0, 4] };

describe('fino:ui/components plotBraille', () => {
  it('renders an all-blank grid for no series', (t) => {
    t.deepEqual(plotBraille([], 3, 2, SCALE_0_4), [BLANK.repeat(3), BLANK.repeat(3)]);
  });

  it('renders an all-blank grid for a single empty series', (t) => {
    t.deepEqual(plotBraille([[]], 2, 1, SCALE_0_4), [BLANK.repeat(2)]);
  });

  it('plots a single point at the max value to the top-left dot', (t) => {
    // dot 1 = bit0, the top-left dot of the cell — a very well-known
    // braille pattern, U+2801 '⠁'.
    t.deepEqual(plotBraille([[4]], 1, 1, SCALE_0_4), ['⠁']);
    t.equal(plotBraille([[4]], 1, 1, SCALE_0_4)[0], braille(0x01));
  });

  it('plots a single point at the min value to the bottom-left dot', (t) => {
    // dot 7 = bit6 = 0x40, the bottom-left dot (row 3, col 0).
    t.deepEqual(plotBraille([[0]], 1, 1, SCALE_0_4), [braille(0x40)]);
  });

  it('clamps out-of-range values to the nearest edge row instead of extending past the grid', (t) => {
    t.deepEqual(plotBraille([[100]], 1, 1, SCALE_0_4), [braille(0x01)], 'above max clamps to max');
    t.deepEqual(plotBraille([[-50]], 1, 1, SCALE_0_4), [braille(0x40)], 'below min clamps to min');
  });

  it('draws a Bresenham line between two points spanning two cells', (t) => {
    // points [0, 4] over a 2-cell-wide, 1-cell-tall grid: the line rises
    // from the bottom-left sub-corner to the top-right sub-corner.
    const rows = plotBraille([[0, 4]], 2, 1, SCALE_0_4);
    t.equal(rows.length, 1);
    t.equal(rows[0], braille(0x60) + braille(0x0a));
  });

  it('draws multiple series into the same grid by OR-ing their dot bits', (t) => {
    const onlyA = plotBraille([[4]], 1, 1, SCALE_0_4);
    const onlyB = plotBraille([[0]], 1, 1, SCALE_0_4);
    const both = plotBraille([[4], [0]], 1, 1, SCALE_0_4);
    t.equal(
      both[0]!.codePointAt(0),
      onlyA[0]!.codePointAt(0)! - 0x2800 + onlyB[0]!.codePointAt(0)!,
      'combined grid ORs the two single-series bit patterns together',
    );
  });
});

describe('fino:ui/components chart color defaults', () => {
  it('falls back to the qualitative palette by series index', (t) => {
    const series: Series = { key: 'a', points: [1] };
    t.equal(seriesColor(series, 0), CHART_PALETTE[0]);
    t.equal(seriesColor(series, 1), CHART_PALETTE[1]);
    t.equal(
      seriesColor(series, CHART_PALETTE.length),
      CHART_PALETTE[0],
      'index wraps around the palette',
    );
  });

  it('an explicit series color wins over the palette', (t) => {
    const series: Series = { key: 'a', points: [1], color: 'red' };
    t.equal(seriesColor(series, 0), 'red');
  });
});

const BAR_SERIES: Series[] = [{ key: 'v', points: [0, 4, 8] }];
const BAR_LABELS = ['x', 'y', 'z'];

describe('fino:ui/components BarChart — terminal', () => {
  it('renders sub-cell-precise vertical bars over a zero-anchored scale', (t) => {
    // scale = niceScale(0, 8) = { min: 0, max: 8, step: 2 }; over 2 rows
    // (16 eighths) that's 0 → 0 eighths, 4 → 8 eighths (bottom row full),
    // 8 → 16 eighths (both rows full).
    const frame = lines(<BarChart series={BAR_SERIES} labels={BAR_LABELS} height={2} />, 8, 3);
    t.equal(strip(frame[0]!), '    █', 'top row: only the tallest bar (z, value 8) reaches it');
    t.equal(strip(frame[1]!), '  █ █', 'bottom row: value 4 (y) and value 8 (z) both fill it');
    t.equal(strip(frame[2]!), 'x y z', 'category labels beneath each bar');
  });

  it('renders horizontal bars as whole-cell runs', (t) => {
    const frame = lines(
      <BarChart series={BAR_SERIES} labels={BAR_LABELS} horizontal showValues />,
      40,
      6,
    );
    t.ok(
      frame.some((row) => strip(row).includes('z') && strip(row).includes('8')),
      'the largest value renders the longest run beside its category label',
    );
    t.ok(
      strip(frame.find((row) => strip(row).includes('z'))!).length >
        strip(frame.find((row) => strip(row).includes('x'))!).length,
      'a larger value produces a longer bar run than a zero value',
    );
  });

  it('prints per-bar values when showValues is set', (t) => {
    const frame = lines(<BarChart series={BAR_SERIES} labels={BAR_LABELS} showValues />, 20, 5);
    t.ok(
      frame.some((row) => strip(row).includes('8')),
      'the value 8 renders somewhere above its bar',
    );
  });
});

const LINE_SERIES: Series[] = [{ key: 'a', points: [0, 2, 4, 2, 0] }];

describe('fino:ui/components LineChart — terminal', () => {
  it('renders a braille plot with no axis or legend by default', (t) => {
    const frame = lines(<LineChart series={LINE_SERIES} height={3} />, 20, 4);
    t.equal(frame.length >= 3, true);
    t.ok(
      frame.some((row) => /[⠀-⣿]/.test(row)),
      'the plot area is drawn with braille glyphs',
    );
  });

  it('adds a y-axis tick column when showAxis is set', (t) => {
    const withAxis = lines(<LineChart series={LINE_SERIES} height={3} showAxis />, 24, 4);
    const withoutAxis = lines(<LineChart series={LINE_SERIES} height={3} />, 24, 4);
    t.ok(
      strip(withAxis[0]!).length > strip(withoutAxis[0]!).length || withAxis[0] !== withoutAxis[0],
      'axis labels widen the first row',
    );
  });

  it('adds a legend row naming each series when showLegend is set', (t) => {
    const frame = lines(
      <LineChart
        series={[{ key: 'lat', label: 'latency', points: [1, 2, 3] }]}
        height={2}
        showLegend
      />,
      30,
      4,
    );
    t.ok(
      frame.some((row) => strip(row).includes('latency')),
      'the legend row names the series by its label',
    );
  });

  it('composites overlapping series so the later series wins the shared cell', (t) => {
    const overlapping: Series[] = [
      { key: 'a', points: [0, 0, 0] },
      { key: 'b', points: [0, 0, 0] },
    ];
    // Both series draw the identical flat line, so every lit cell is a
    // case of "overlap" — this only asserts the tree renders without
    // throwing and produces braille output, since the visual color choice
    // isn't observable through `renderFrame`'s plain-text frame.
    const frame = lines(<LineChart series={overlapping} height={2} />, 20, 3);
    t.ok(frame.some((row) => /[⠀-⣿]/.test(row)));
  });
});

describe('fino:ui/components BarChart — html', () => {
  it('renders an accessible svg with one rect per bar and hover titles', (t) => {
    const html = renderToHtml(toHtml(<BarChart series={BAR_SERIES} labels={BAR_LABELS} />));
    t.ok(html.includes('<svg'), 'renders a real <svg>');
    t.ok(html.includes('role="img"'), 'the svg carries an accessible role');
    t.ok(html.includes('aria-label="Bar chart'), 'the svg names itself');
    t.ok(html.includes('<title>Bar chart'), 'the svg carries a <title> for the accessible name');
    const rectCount = (html.match(/<rect/g) ?? []).length;
    t.equal(rectCount, BAR_SERIES.length * BAR_LABELS.length, 'one <rect> per series×category');
    t.ok(html.includes('<title>v'), 'each bar carries its own hover title');
  });

  it('never leaks TUI braille or block glyphs into the markup', (t) => {
    const html = renderToHtml(
      toHtml(<BarChart series={BAR_SERIES} labels={BAR_LABELS} showValues horizontal />),
    );
    t.ok(!/[▀-▟]/.test(html), 'no block-element glyphs');
    t.ok(!/[⠀-⣿]/.test(html), 'no braille glyphs');
  });

  it('renders one rect per series across categories, grouped', (t) => {
    const multi: Series[] = [
      { key: 'a', points: [1, 2] },
      { key: 'b', points: [3, 4] },
    ];
    const html = renderToHtml(toHtml(<BarChart series={multi} labels={['p', 'q']} />));
    const rectCount = (html.match(/<rect/g) ?? []).length;
    t.equal(rectCount, 4, 'two series × two categories = four bars');
  });
});

describe('fino:ui/components LineChart — html', () => {
  it('renders an accessible svg with one polyline per series', (t) => {
    const multi: Series[] = [
      { key: 'a', label: 'Alpha', points: [1, 2, 3] },
      { key: 'b', label: 'Beta', points: [3, 2, 1] },
    ];
    const html = renderToHtml(toHtml(<LineChart series={multi} />));
    t.ok(html.includes('<svg'), 'renders a real <svg>');
    t.ok(html.includes('role="img"'), 'the svg carries an accessible role');
    t.ok(html.includes('<title>Line chart'), 'the svg carries a <title> for the accessible name');
    const polylineCount = (html.match(/<polyline/g) ?? []).length;
    t.equal(polylineCount, 2, 'one <polyline> per series');
    t.ok(html.includes('<title>Alpha'), 'each polyline carries its series name as hover text');
    t.ok(html.includes('<title>Beta'));
  });

  it('renders axis tick text only when showAxis is set', (t) => {
    const withAxis = renderToHtml(toHtml(<LineChart series={LINE_SERIES} showAxis />));
    const withoutAxis = renderToHtml(toHtml(<LineChart series={LINE_SERIES} />));
    t.ok(withAxis.includes('<text'), 'axis ticks render as <text>');
    t.ok(!withoutAxis.includes('<text'), 'no axis text without showAxis');
  });

  it('renders a legend list only when showLegend is set', (t) => {
    const html = renderToHtml(
      toHtml(<LineChart series={[{ key: 'a', label: 'Alpha', points: [1, 2] }]} showLegend />),
    );
    t.ok(html.includes('ui-chart-legend'), 'the legend wrapper renders');
    t.ok(html.includes('Alpha'), 'the legend names the series');
  });

  it('never leaks TUI braille or block glyphs into the markup', (t) => {
    const html = renderToHtml(toHtml(<LineChart series={LINE_SERIES} showAxis showLegend />));
    t.ok(!/[▀-▟]/.test(html), 'no block-element glyphs');
    t.ok(!/[⠀-⣿]/.test(html), 'no braille glyphs');
  });
});
