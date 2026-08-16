/**
 * internal:ui/components/charts — bar and line charts, with the axis and
 * rasterization math both lowerings share.
 *
 * The charts follow the same split as every other catalog component: the tree
 * carries data, never glyphs or markup. The one exception is `plotBraille` —
 * braille dot rasterization is pure geometry (character selection from a bit
 * pattern), not a presentation decision, so it lives here as a unit-testable
 * pure function and both lowerings call it rather than each re-deriving the
 * dot bit order.
 *
 * A series is `points: number[]` — plain y-values at implied, evenly spaced x
 * positions — rather than `{ x, y }` pairs. Every chart here plots categorical
 * or time-bucketed data (bar categories, sampled line series) where the x axis
 * is a uniform index; `labels` (on `BarChart`) supplies the category names for
 * that axis when the index itself isn't the label. Pairs would add a second
 * coordinate every call site has to invent (usually just the index again) for
 * no chart in this catalog that actually has irregular x spacing — if one
 * shows up later, it can grow its own prop rather than bending every chart
 * through `{x,y}` today.
 *
 * @internal
 */
import { h, type Props, type VNode } from 'fino:ui';
import {
  VIRTUAL_ROW_PX,
  cssColor,
  idAttr,
} from 'internal:ui/components/html-runtime';
import type { Color } from 'fino:tty/style';
import type { FlexChildProps } from 'internal:ui/components/primitives';

/** One data series for `BarChart`/`LineChart`: evenly spaced y-values. */
export interface Series {
  key: string;
  label?: string;
  color?: Color;
  points: number[];
}

/** Small qualitative palette a series falls back to when it omits `color`. */
export const CHART_PALETTE: Color[] = ['cyan', 'green', 'yellow', 'red', 'blue', 'magenta'];

/**
 * Resolve a series' color: its own `color` when given, otherwise the next
 * color from `CHART_PALETTE` by series index — the same resolution both
 * `BarChart` and `LineChart` lowerings use, so a chart's default colors
 * agree between the terminal and the web without either target re-deriving
 * the assignment independently.
 */
export function seriesColor(series: Series, index: number): Color {
  return series.color ?? CHART_PALETTE[index % CHART_PALETTE.length]!;
}

/** Human-friendly axis bounds and tick values computed by `niceScale`. */
export interface NiceScale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

// The classic "nice numbers" rule (Heckbert): round a span to the nearest
// 1/2/5 × 10^n so axis ticks land on numbers a human would choose by hand,
// not on whatever fraction the raw data range happens to produce.
function niceNum(span: number, round: boolean): number {
  if (span <= 0) return 1;
  const exponent = Math.floor(Math.log10(span));
  const fraction = span / 10 ** exponent;
  let niceFraction: number;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * 10 ** exponent;
}

/**
 * Compute human-friendly axis bounds and ticks for `[min, max]`: rounded-out
 * bounds and an evenly spaced tick step chosen by the classic 1/2/5 × 10ⁿ
 * rule, so charts don't axis-label with numbers like `87.4`. `min`/`max` may
 * arrive in either order. A zero-span input (`min === max`) has no range to
 * derive a step from, so it pads to a span of `1` centered on the value (or
 * `[0, 1]` when the value is `0`) before computing ticks.
 *
 * ```ts no_run
 * niceScale(0, 87);     // { min: 0, max: 100, step: 20, ticks: [0,20,40,60,80,100] }
 * niceScale(-100, -10); // { min: -100, max: 0, step: 20, ticks: [-100,-80,…,0] }
 * niceScale(5, 5);      // { min: 2, max: 8, step: 1, ticks: [2,3,4,5,6,7,8] }
 * ```
 */
export function niceScale(min: number, max: number, ticks = 5): NiceScale {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (lo === hi) {
    if (lo === 0) {
      hi = 1;
    } else {
      const pad = Math.abs(lo) * 0.5;
      lo -= pad;
      hi += pad;
    }
  }
  const wanted = Math.max(1, Math.floor(ticks) - 1);
  const span = niceNum(hi - lo, false);
  const step = niceNum(span / wanted, true);
  // Values are snapped to a precision derived from `step` (rather than
  // used raw) to erase float noise from multiplying by `step` — e.g.
  // `Math.ceil(-0.5) * 20` should read as `0`, not `-0`, and a tiny `step`
  // like `0.0002` shouldn't leave ticks like `0.0006000000000000001`.
  const clean = cleanToStep(step);
  const niceMin = clean(Math.floor(lo / step) * step);
  const niceMax = clean(Math.ceil(hi / step) * step);
  const out: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    out.push(clean(Math.round(v / step) * step));
  }
  return { min: niceMin, max: niceMax, step, ticks: out };
}

// Round `value` to the decimal precision `step` itself carries (plus
// headroom), and normalize `-0` to `0` — both are float-multiplication
// artifacts, not meaningful results. Precision is derived from `step`
// rather than fixed, so this stays correct from tiny (`1e-6`) to huge
// (`1e12`) magnitudes alike, clamped to stay within safe-integer range.
function cleanToStep(step: number): (value: number) => number {
  const digits = Math.max(0, Math.min(15, -Math.floor(Math.log10(Math.abs(step))) + 9));
  const factor = 10 ** digits;
  return (value: number): number => {
    const rounded = Math.round(value * factor) / factor;
    return rounded === 0 ? 0 : rounded;
  };
}

// Unicode braille (U+2800 base) dot numbering and bit order:
//   1 4      bit0 bit3
//   2 5  →   bit1 bit4
//   3 6      bit2 bit5
//   7 8      bit6 bit7
// Indexed here as `BRAILLE_BITS[subRowWithinCell][subColWithinCell]`, a
// 4-row × 2-col table matching the 2×4 sub-cell grid one braille glyph packs
// into.
const BRAILLE_BASE = 0x2800;
const BRAILLE_BITS: ReadonlyArray<readonly [number, number]> = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

function valueToSubrow(value: number, scale: NiceScale, subrows: number): number {
  const span = scale.max - scale.min;
  const fraction = span === 0 ? 0.5 : (value - scale.min) / span;
  const clamped = Math.max(0, Math.min(1, fraction));
  // Row 0 is the top of the cell grid, but a larger value should plot
  // higher (a smaller row index) — invert the fraction before scaling.
  return Math.max(0, Math.min(subrows - 1, Math.round((1 - clamped) * (subrows - 1))));
}

function indexToSubcol(index: number, count: number, subcols: number): number {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(subcols - 1, Math.round((index * (subcols - 1)) / (count - 1))));
}

/**
 * Rasterize one or more series of y-values into `height` rows of braille
 * glyphs, `width` cells wide (each cell packs a 2×4 sub-cell grid — see
 * `BRAILLE_BITS` for the dot bit order). Each series' points are spread
 * evenly across the available sub-columns by index and connected
 * point-to-point with a Bresenham line, so a series with fewer points than
 * sub-columns still draws a continuous line rather than isolated dots. A
 * value outside `scale`'s range clamps to the nearest edge row rather than
 * extending past the grid. Multiple input series draw into the *same* grid,
 * OR-ing their dot bits together — pass one series per call (in a
 * single-element array) instead when a caller needs to know which series
 * lit which dots, e.g. to color each series' glyphs separately (see
 * `internal:tty/lower`'s `lineChart` composer).
 *
 * Purely geometric: no color, no styling, just character selection from a
 * dot bit pattern — the one exception to "no glyphs in `components.tsx`",
 * since there is no presentation decision being made here.
 *
 * ```ts no_run
 * plotBraille([[4]], 1, 1, { min: 0, max: 4, step: 4, ticks: [0, 4] });
 * // → ['⠁'] — one point, at the top-left dot (the max value, top of the cell)
 * ```
 */
export function plotBraille(
  series: number[][],
  width: number,
  height: number,
  scale: NiceScale,
): string[] {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const subcols = w * 2;
  const subrows = h * 4;
  const bits = new Array<number>(w * h).fill(0);

  const plotDot = (subcol: number, subrow: number): void => {
    const cellCol = Math.floor(subcol / 2);
    const cellRow = Math.floor(subrow / 4);
    if (cellCol < 0 || cellCol >= w || cellRow < 0 || cellRow >= h) return;
    const dotCol = subcol % 2;
    const dotRow = subrow % 4;
    const index = cellRow * w + cellCol;
    bits[index] = bits[index]! | BRAILLE_BITS[dotRow]![dotCol]!;
  };

  // Bresenham's line algorithm, generalized for either axis direction —
  // connects two sub-cell points with the nearest-integer staircase between
  // them, the standard way to rasterize a line onto a discrete dot grid.
  const plotLine = (x0: number, y0: number, x1: number, y1: number): void => {
    let cx = x0;
    let cy = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      plotDot(cx, cy);
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        cx += sx;
      }
      if (e2 <= dx) {
        err += dx;
        cy += sy;
      }
    }
  };

  for (const points of series) {
    if (points.length === 0) continue;
    const cols = points.map((_, i) => indexToSubcol(i, points.length, subcols));
    const rows = points.map((v) => valueToSubrow(v, scale, subrows));
    plotDot(cols[0]!, rows[0]!);
    for (let i = 1; i < points.length; i++) {
      plotLine(cols[i - 1]!, rows[i - 1]!, cols[i]!, rows[i]!);
    }
  }

  const out: string[] = [];
  for (let r = 0; r < h; r++) {
    let row = '';
    for (let c = 0; c < w; c++) row += String.fromCodePoint(BRAILLE_BASE + bits[r * w + c]!);
    out.push(row);
  }
  return out;
}

const CHART_SVG_WIDTH = 480;

function chartSvgHeight(height: number | undefined): number {
  return Math.max(1, Math.floor(height ?? 8)) * VIRTUAL_ROW_PX;
}

/** Props accepted by `BarChart`. */
export interface BarChartProps extends FlexChildProps, Props {
  series: Series[];
  /** Category labels, one per point index; defaults to the point index. */
  labels?: string[];
  /** Bar length in cells/rows; default 8. */
  height?: number;
  /** Lay bars out as horizontal rows instead of vertical columns. */
  horizontal?: boolean;
  /** Print each bar's value alongside it. */
  showValues?: boolean;
  id?: string;
}
/**
 * Grouped bar chart: one cluster of bars per category, one bar per series
 * within a cluster, sharing a zero-anchored scale across every series.
 * Stacking (segments piled within one bar) is deliberately not offered:
 * the terminal target has only one color per character cell, and a
 * segment boundary that lands mid-cell would need two colors in that one
 * cell to render correctly. Rather than support it only on the web —
 * which would make a chart branch on where it's running, the one thing
 * this catalog's components never do — stacking is left out of both
 * targets. The terminal draws sub-cell-precise bars with the block
 * elements `▁▂▃▄▅▆▇█`; the web draws an inline `<svg>` of `<rect>`s.
 */
export function BarChart(all: BarChartProps): VNode {
  const { children = [], ...props } = all as BarChartProps & { children?: NormalizedChild[] };
  const { series, labels, height, horizontal, showValues, id } = props;
  const svgW = CHART_SVG_WIDTH;
  const innerH = chartSvgHeight(height);
  const margin = { top: showValues === true ? 20 : 8, right: 8, bottom: 24, left: 8 };
  const svgH = innerH + margin.top + margin.bottom;
  const innerW = svgW - margin.left - margin.right;
  const allValues = series.flatMap((s) => s.points);
  const scale = niceScale(Math.min(0, ...allValues), Math.max(0, ...allValues));
  const span = scale.max - scale.min || 1;
  const count = Math.max(0, ...series.map((s) => s.points.length));
  const cats = Array.from({ length: count }, (_, i) => labels?.[i] ?? String(i));
  const summary = `Bar chart of ${series.length} series across ${cats.length} categories`;

  const parts: VNode[] = [];
  if (horizontal === true) {
    const rowH = innerH / Math.max(1, cats.length);
    const barGap = rowH * 0.15;
    const barH = (rowH - barGap) / Math.max(1, series.length);
    const xZero = margin.left + (innerW * (0 - scale.min)) / span;
    cats.forEach((cat, ci) => {
      series.forEach((s, si) => {
        const value = s.points[ci] ?? 0;
        const xValue = margin.left + (innerW * (value - scale.min)) / span;
        const x = Math.min(xValue, xZero);
        const w = Math.abs(xValue - xZero);
        const y = margin.top + ci * rowH + barGap / 2 + si * barH;
        const color = cssColor(seriesColor(s, si));
        parts.push(
          h(
            'rect',
            { x, y, width: w, height: Math.max(0, barH), fill: color },
            h('title', null, `${s.label ?? s.key} — ${cat}: ${value}`),
          ),
        );
        if (showValues === true) {
          parts.push(
            h(
              'text',
              { x: xValue + 4, y: y + barH / 2, 'dominant-baseline': 'middle', 'font-size': '10' },
              String(value),
            ),
          );
        }
      });
      parts.push(
        h(
          'text',
          {
            x: margin.left - 4,
            y: margin.top + ci * rowH + rowH / 2,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
            'font-size': '10',
          },
          cat,
        ),
      );
    });
  } else {
    const clusterW = innerW / Math.max(1, cats.length);
    const barGap = clusterW * 0.15;
    const barW = (clusterW - barGap) / Math.max(1, series.length);
    const yZero = margin.top + innerH * (1 - (0 - scale.min) / span);
    cats.forEach((cat, ci) => {
      series.forEach((s, si) => {
        const value = s.points[ci] ?? 0;
        const yValue = margin.top + innerH * (1 - (value - scale.min) / span);
        const y = Math.min(yValue, yZero);
        const barHeight = Math.abs(yValue - yZero);
        const x = margin.left + ci * clusterW + barGap / 2 + si * barW;
        const color = cssColor(seriesColor(s, si));
        parts.push(
          h(
            'rect',
            { x, y, width: barW, height: barHeight, fill: color },
            h('title', null, `${s.label ?? s.key} — ${cat}: ${value}`),
          ),
        );
        if (showValues === true) {
          parts.push(
            h(
              'text',
              { x: x + barW / 2, y: y - 4, 'text-anchor': 'middle', 'font-size': '10' },
              String(value),
            ),
          );
        }
      });
      parts.push(
        h(
          'text',
          {
            x: margin.left + ci * clusterW + clusterW / 2,
            y: svgH - 6,
            'text-anchor': 'middle',
            'font-size': '10',
          },
          cat,
        ),
      );
    });
  }

  const svg = h(
    'svg',
    {
      className: 'ui-chart-svg',
      viewBox: `0 0 ${svgW} ${svgH}`,
      role: 'img',
      'aria-label': summary,
      xmlns: 'http://www.w3.org/2000/svg',
    },
    h('title', null, summary),
    ...parts,
  );
  return h('div', { className: 'ui-bar-chart', ...idAttr(id) }, svg);
}

/** Props accepted by `LineChart`. */
export interface LineChartProps extends FlexChildProps, Props {
  series: Series[];
  /** Chart height in cells/rows; default 8. */
  height?: number;
  /** Show y-axis tick labels. */
  showAxis?: boolean;
  /** Show a legend row naming each series. */
  showLegend?: boolean;
  id?: string;
}
/**
 * Line chart over one or more series sharing a scale derived from every
 * series' actual range (not zero-anchored, unlike `BarChart` — a line
 * chart's baseline is wherever the data sits, not necessarily zero). The
 * terminal plots through `plotBraille`, one call per series so each can
 * carry its own color; where two series' lines cross into the same
 * character cell, the later series (by array order) wins that cell — a
 * terminal cell has one color, so overlap can't blend. The web draws an
 * inline `<svg>` `<polyline>` per series in the same colors.
 */
export function LineChart(all: LineChartProps): VNode {
  const { children = [], ...props } = all as LineChartProps & { children?: NormalizedChild[] };
  const { series, height, showAxis, showLegend, id } = props;
  const svgW = CHART_SVG_WIDTH;
  const innerH = chartSvgHeight(height);
  const margin = { top: 12, right: 12, bottom: 8, left: showAxis === true ? 36 : 8 };
  const svgH = innerH + margin.top + margin.bottom;
  const innerW = svgW - margin.left - margin.right;
  const allValues = series.flatMap((s) => s.points);
  const scale =
    allValues.length > 0
      ? niceScale(Math.min(...allValues), Math.max(...allValues))
      : niceScale(0, 1);
  const span = scale.max - scale.min || 1;
  const maxPoints = Math.max(1, ...series.map((s) => s.points.length));
  const xOf = (i: number): number =>
    margin.left + (maxPoints <= 1 ? 0 : (i * innerW) / (maxPoints - 1));
  const yOf = (v: number): number => margin.top + innerH * (1 - (v - scale.min) / span);
  const summary = `Line chart of ${series.length} series: ${series
    .map((s) => s.label ?? s.key)
    .join(', ')}`;

  const parts: VNode[] = [];
  if (showAxis === true) {
    for (const tick of scale.ticks) {
      const y = yOf(tick);
      parts.push(
        h('line', {
          x1: margin.left,
          x2: svgW - margin.right,
          y1: y,
          y2: y,
          stroke: 'var(--ui-border)',
          'stroke-width': '1',
        }),
      );
      parts.push(
        h(
          'text',
          {
            x: margin.left - 4,
            y,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
            'font-size': '10',
          },
          String(tick),
        ),
      );
    }
  }
  series.forEach((s, si) => {
    const color = cssColor(seriesColor(s, si));
    const pointsAttr = s.points.map((v, i) => `${xOf(i)},${yOf(v)}`).join(' ');
    parts.push(
      h(
        'polyline',
        { points: pointsAttr, fill: 'none', stroke: color, 'stroke-width': '2' },
        h('title', null, s.label ?? s.key),
      ),
    );
  });

  const svg = h(
    'svg',
    {
      className: 'ui-chart-svg',
      viewBox: `0 0 ${svgW} ${svgH}`,
      role: 'img',
      'aria-label': summary,
      xmlns: 'http://www.w3.org/2000/svg',
    },
    h('title', null, summary),
    ...parts,
  );
  const legend =
    showLegend === true
      ? h(
          'div',
          { className: 'ui-chart-legend' },
          ...series.map((s, si) =>
            h(
              'span',
              { className: 'ui-chart-legend-item' },
              h('span', {
                className: 'ui-chart-legend-swatch',
                style: { background: cssColor(seriesColor(s, si)) },
                'aria-hidden': 'true',
              }),
              s.label ?? s.key,
            ),
          ),
        )
      : null;
  return h('div', { className: 'ui-line-chart', ...idAttr(id) }, svg, legend);
}
