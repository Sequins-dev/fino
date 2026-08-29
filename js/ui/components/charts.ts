/**
 * Target-neutral chart contracts, scales, palettes, and braille geometry.
 *
 * Series use evenly spaced numeric samples. Date/category labels remain
 * presentation metadata rather than duplicating an x coordinate per sample.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import type { Color } from 'fino:tty/style';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';

/** One evenly spaced chart series. */
export interface Series {
  key: string;
  label?: string;
  color?: Color;
  points: readonly number[];
}

/** Qualitative fallback palette shared by every chart target. */
export const CHART_PALETTE: readonly Color[] = [
  'cyan',
  'green',
  'yellow',
  'red',
  'blue',
  'magenta',
];

/** Resolve an explicit series color or its stable palette entry. */
export function seriesColor(series: Series, index: number): Color {
  return (
    series.color ??
    CHART_PALETTE[((index % CHART_PALETTE.length) + CHART_PALETTE.length) % CHART_PALETTE.length]!
  );
}

/** Human-friendly axis bounds and ticks. */
export interface NiceScale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

function niceNumber(span: number, round: boolean): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const exponent = Math.floor(Math.log10(span));
  const fraction = span / 10 ** exponent;
  const value = round
    ? fraction < 1.5
      ? 1
      : fraction < 3
        ? 2
        : fraction < 7
          ? 5
          : 10
    : fraction <= 1
      ? 1
      : fraction <= 2
        ? 2
        : fraction <= 5
          ? 5
          : 10;
  return value * 10 ** exponent;
}

function cleanToStep(step: number): (value: number) => number {
  const digits = Math.max(0, Math.min(15, -Math.floor(Math.log10(Math.abs(step))) + 9));
  const factor = 10 ** digits;
  return (value) => {
    const rounded = Math.round(value * factor) / factor;
    return rounded === 0 ? 0 : rounded;
  };
}

/** Compute rounded-out 1/2/5×10ⁿ bounds and tick values. */
export function niceScale(min: number, max: number, ticks = 5): NiceScale {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 1;
  [lo, hi] = [Math.min(lo, hi), Math.max(lo, hi)];
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else {
      const pad = Math.abs(lo) * 0.5;
      lo -= pad;
      hi += pad;
    }
  }
  const wanted = Math.max(1, Math.floor(Number.isFinite(ticks) ? ticks : 5) - 1);
  const step = niceNumber(niceNumber(hi - lo, false) / wanted, true);
  const clean = cleanToStep(step);
  const niceMin = clean(Math.floor(lo / step) * step);
  const niceMax = clean(Math.ceil(hi / step) * step);
  const values: number[] = [];
  for (let value = niceMin; value <= niceMax + step / 2; value += step) {
    values.push(clean(Math.round(value / step) * step));
  }
  return { min: niceMin, max: niceMax, step, ticks: values };
}

/** Derive one scale from every finite point, optionally anchored at zero. @internal */
export function seriesScale(series: readonly Series[], zero = false): NiceScale {
  const values = series.flatMap((entry) => entry.points.filter(Number.isFinite));
  if (values.length === 0) return niceScale(0, 1);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return niceScale(zero ? Math.min(0, min) : min, zero ? Math.max(0, max) : max);
}

/** Resolve category labels to the longest series length. @internal */
export function chartCategories(series: readonly Series[], labels?: readonly string[]): string[] {
  const count = Math.max(0, ...series.map((entry) => entry.points.length));
  return Array.from({ length: count }, (_, index) => labels?.[index] ?? String(index));
}

/** Normalize a chart height in terminal-style rows. @internal */
export function chartRows(height: number | undefined): number {
  return Math.max(1, Math.floor(height !== undefined && Number.isFinite(height) ? height : 8));
}

/** Compact finite-number label shared by terminal chart forms. @internal */
export function formatChartValue(value: number): string {
  if (!Number.isFinite(value)) return '–';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const BRAILLE_BASE = 0x2800;
const BRAILLE_BITS: ReadonlyArray<readonly [number, number]> = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

function valueToSubrow(value: number, scale: NiceScale, subrows: number): number {
  const safe = Number.isFinite(value) ? value : scale.min;
  const fraction = (safe - scale.min) / (scale.max - scale.min || 1);
  return Math.max(0, Math.min(subrows - 1, Math.round((1 - fraction) * (subrows - 1))));
}

function indexToSubcol(index: number, count: number, subcols: number): number {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(subcols - 1, Math.round((index * (subcols - 1)) / (count - 1))));
}

/**
 * Rasterize series into a width×height braille grid. Samples are connected
 * with Bresenham lines and multiple series OR their dots into the same cells.
 */
export function plotBraille(
  series: readonly (readonly number[])[],
  width: number,
  height: number,
  scale: NiceScale,
): string[] {
  const cellsWide = Math.max(1, Math.floor(width));
  const cellsHigh = Math.max(1, Math.floor(height));
  const subcols = cellsWide * 2;
  const subrows = cellsHigh * 4;
  const bits = new Array<number>(cellsWide * cellsHigh).fill(0);
  const dot = (x: number, y: number): void => {
    const cellX = Math.floor(x / 2);
    const cellY = Math.floor(y / 4);
    if (cellX < 0 || cellX >= cellsWide || cellY < 0 || cellY >= cellsHigh) return;
    const index = cellY * cellsWide + cellX;
    bits[index] = bits[index]! | BRAILLE_BITS[y % 4]![x % 2]!;
  };
  const line = (x0: number, y0: number, x1: number, y1: number): void => {
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      dot(x, y);
      if (x === x1 && y === y1) break;
      const doubled = error * 2;
      if (doubled >= dy) {
        error += dy;
        x += sx;
      }
      if (doubled <= dx) {
        error += dx;
        y += sy;
      }
    }
  };
  for (const points of series) {
    if (points.length === 0) continue;
    const columns = points.map((_, index) => indexToSubcol(index, points.length, subcols));
    const rows = points.map((value) => valueToSubrow(value, scale, subrows));
    dot(columns[0]!, rows[0]!);
    for (let index = 1; index < points.length; index++) {
      line(columns[index - 1]!, rows[index - 1]!, columns[index]!, rows[index]!);
    }
  }
  return Array.from({ length: cellsHigh }, (_, row) => {
    let text = '';
    for (let column = 0; column < cellsWide; column++) {
      text += String.fromCodePoint(BRAILLE_BASE + bits[row * cellsWide + column]!);
    }
    return text;
  });
}

/** Props accepted by {@link BarChart}. */
export interface BarChartProps extends StyleProps, FlexChildProps, Props {
  series: readonly Series[];
  labels?: readonly string[];
  height?: number;
  horizontal?: boolean;
  showValues?: boolean;
}

/** Controlled grouped bar chart rendered appropriately for each target. */
export function BarChart(props: BarChartProps): VNode {
  return h('ui:bar-chart', props);
}

/** Props accepted by {@link LineChart}. */
export interface LineChartProps extends StyleProps, FlexChildProps, Props {
  series: readonly Series[];
  height?: number;
  showAxis?: boolean;
  showLegend?: boolean;
}

/** Controlled evenly spaced line chart rendered appropriately for each target. */
export function LineChart(props: LineChartProps): VNode {
  return h('ui:line-chart', props);
}
