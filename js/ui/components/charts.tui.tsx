/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/charts.tui — terminal forms for bar and line charts.
 *
 * @internal
 */
import { h, mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, VNode } from 'fino:ui';
import { nearestAnsi256, supportsTruecolor } from 'fino:tty/style';
import type { Color } from 'fino:tty/style';
import type { NiceScale, Series } from 'internal:ui/components/charts';
import { Box, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { stringWidth } from 'fino:tty/frame';
import { env } from 'fino:process';
import { niceScale, plotBraille } from 'internal:ui/components/charts';
import { seriesColor } from 'internal:ui/components/charts';
import { BarChart, LineChart } from 'internal:ui/components/charts';
import type { BarChartProps, LineChartProps } from 'internal:ui/components/charts';

function resolveChartColor(color: Color, truecolor: boolean): Color {
  if (typeof color === 'string' || 'ansi256' in color) return color;
  const [r, g, b] = color.rgb;
  return truecolor ? color : { ansi256: nearestAnsi256(r, g, b) };
}

function chartSeriesColor(series: Series, index: number, truecolor: boolean): Color {
  return resolveChartColor(seriesColor(series, index), truecolor);
}

function formatChartValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// Eighth-cell block glyphs for vertical-bar sub-cell precision — index 0 is
// 1/8 filled, index 7 (`█`) is full.
const BLOCK_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const HORIZONTAL_BAR_TRACK = 24;

const BRAILLE_BLANK = String.fromCodePoint(0x2800);

interface ChartCell {
  char: string;
  color: Color | null;
}

function axisGutter(
  series: readonly Series[],
  scale: NiceScale,
  showAxis: boolean | undefined,
): number {
  if (showAxis !== true) return 0;
  // Tick label column plus the gap between it and the plot.
  return Math.max(0, ...scale.ticks.map((t) => formatChartValue(t).length)) + 1;
}

interface LinePlotOptions {
  series: readonly Series[];
  rows: number;
  width: number;
  scale: NiceScale;
  truecolor: boolean;
  showAxis: boolean | undefined;
  showLegend: boolean | undefined;
}

function linePlot(options: LinePlotOptions): VNode {
  const { series, rows, width, scale, truecolor, showAxis, showLegend } = options;

  const composite: ChartCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: width }, () => ({ char: ' ', color: null })),
  );
  series.forEach((s, si) => {
    const color = chartSeriesColor(s, si, truecolor);
    const grid = plotBraille([s.points], width, rows, scale);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < width; c++) {
        const ch = grid[r]![c]!;
        if (ch !== BRAILLE_BLANK) composite[r]![c] = { char: ch, color };
      }
    }
  });

  const axisSpan = scale.max - scale.min || 1;
  const axisRowFor = (tick: number): number => {
    const fraction = (scale.max - tick) / axisSpan;
    return Math.max(0, Math.min(rows - 1, Math.round(fraction * (rows - 1))));
  };
  const axisRows = new Map<number, number>();
  if (showAxis === true) for (const tick of scale.ticks) axisRows.set(axisRowFor(tick), tick);
  const axisWidth =
    showAxis === true ? Math.max(0, ...scale.ticks.map((t) => formatChartValue(t).length)) : 0;

  const chartRows = Array.from({ length: rows }, (_, r) => {
    const cells = composite[r]!;
    const runs: VNode[] = [];
    let i = 0;
    while (i < width) {
      const color = cells[i]!.color;
      let j = i + 1;
      while (j < width && cells[j]!.color === color) j++;
      const text = cells
        .slice(i, j)
        .map((cell) => cell.char)
        .join('');
      runs.push(
        <Text key={String(i)} style={color !== null ? [{ fg: color }] : []}>
          {text}
        </Text>,
      );
      i = j;
    }
    const tick = showAxis === true ? axisRows.get(r) : undefined;
    return (
      <Box key={String(r)} direction="row" gap={1}>
        {showAxis === true ? (
          <Text width={axisWidth} align="end" style={[styles.dim]}>
            {tick !== undefined ? formatChartValue(tick) : ''}
          </Text>
        ) : null}
        <Box direction="row">{runs}</Box>
      </Box>
    );
  });

  return (
    <Box direction="column" gap={1}>
      <Box direction="column">{chartRows}</Box>
      {showLegend === true ? (
        <Box direction="row" gap={2}>
          {series.map((s, si) => (
            <Box key={s.key} direction="row" gap={1}>
              <Text style={[{ fg: chartSeriesColor(s, si, truecolor) }]}>●</Text>
              <Text style={[styles.dim]}>{s.label ?? s.key}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

mapRenderTargetLowering(BarChart, 'tui', (all: BarChartProps): VNode => {
  const { children = [], ...props } = all as BarChartProps & { children?: NormalizedChild[] };
  const { series, labels, height, horizontal, showValues, id, ...rest } = props;
  const truecolor = supportsTruecolor(env.COLORTERM);
  const rows = Math.max(1, Math.floor(height ?? 8));
  const allValues = series.flatMap((s) => s.points);
  const scale = niceScale(Math.min(0, ...allValues), Math.max(0, ...allValues));
  const span = scale.max - scale.min || 1;
  const count = Math.max(0, ...series.map((s) => s.points.length));
  const cats = Array.from({ length: count }, (_, i) => labels?.[i] ?? String(i));

  if (horizontal === true) {
    const labelWidth = Math.max(0, ...cats.map((c) => stringWidth(c)));
    return (
      <Box direction="column" gap={1} id={id} {...rest}>
        {cats.map((cat, ci) => (
          <Box key={String(ci)} direction="column">
            {series.map((s, si) => {
              const value = s.points[ci] ?? 0;
              const fraction = Math.max(0, Math.min(1, (value - scale.min) / span));
              const filled = Math.round(fraction * HORIZONTAL_BAR_TRACK);
              const color = chartSeriesColor(s, si, truecolor);
              return (
                <Box key={s.key} direction="row" gap={1}>
                  <Text width={labelWidth}>{si === 0 ? cat : ''}</Text>
                  <Text style={[{ fg: color }]}>{'█'.repeat(filled)}</Text>
                  {showValues === true ? (
                    <Text style={[styles.dim]}>{formatChartValue(value)}</Text>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    );
  }

  const columnWidth = showValues
    ? Math.max(1, ...allValues.map((v) => formatChartValue(v).length))
    : 1;
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      {cats.map((cat, ci) => (
        <Box key={String(ci)} direction="column">
          {showValues === true ? (
            <Box direction="row">
              {series.map((s, si) => (
                <Text
                  key={s.key}
                  width={columnWidth}
                  align="center"
                  style={[{ fg: chartSeriesColor(s, si, truecolor) }]}
                >
                  {formatChartValue(s.points[ci] ?? 0)}
                </Text>
              ))}
            </Box>
          ) : null}
          <Box direction="column">
            {Array.from({ length: rows }, (_, r) => (
              <Box key={String(r)} direction="row">
                {series.map((s, si) => {
                  const value = s.points[ci] ?? 0;
                  const fraction = Math.max(0, Math.min(1, (value - scale.min) / span));
                  const filledEighths = Math.round(fraction * rows * 8);
                  const band = (rows - 1 - r) * 8;
                  const filledInRow = Math.max(0, Math.min(8, filledEighths - band));
                  const glyph =
                    filledInRow === 0
                      ? ' '
                      : filledInRow === 8
                        ? '█'
                        : BLOCK_LEVELS[filledInRow - 1]!;
                  return (
                    <Text
                      key={s.key}
                      style={filledInRow > 0 ? [{ fg: chartSeriesColor(s, si, truecolor) }] : []}
                    >
                      {glyph.repeat(columnWidth)}
                    </Text>
                  );
                })}
              </Box>
            ))}
          </Box>
          <Text width={series.length * columnWidth} align="center" style={[styles.dim]}>
            {cat}
          </Text>
        </Box>
      ))}
    </Box>
  );
});

// Chart series colors resolve through the same truecolor-capability check
// ColorPicker's swatches use: `fino:tty/style`'s SGR codec would happily
// emit a raw 24-bit escape for an explicit `{ rgb }` series color even on a
// terminal that can't render it, so it's downgraded to the nearest
// xterm-256 index here — in the lowering, never inside the chart
// components, matching the "environment detection stays out of components"
// rule `colorPicker` already established.
mapRenderTargetLowering(LineChart, 'tui', (all: LineChartProps): VNode => {
  const { children = [], ...props } = all as LineChartProps & { children?: NormalizedChild[] };
  const { series, height, showAxis, showLegend, id, ...rest } = props;
  const truecolor = supportsTruecolor(env.COLORTERM);
  const rows = Math.max(1, Math.floor(height ?? 8));
  const allValues = series.flatMap((s) => s.points);
  const scale =
    allValues.length > 0
      ? niceScale(Math.min(...allValues), Math.max(...allValues))
      : niceScale(0, 1);

  // The plot spans whatever width layout assigns, so a chart fills its
  // container instead of collapsing to its sample count.
  return (
    <Box direction="column" id={id} {...rest}>
      {h('measured', {
        height: rows + (showLegend === true ? 2 : 0),
        render: ({ width: available }: { width: number }) =>
          linePlot({
            series,
            rows,
            // Always fit: the plot scales down to the space it is given
            // rather than overflowing when there are more samples than
            // cells — plotBraille resamples across whatever width it gets.
            width: Math.max(1, available - axisGutter(series, scale, showAxis)),
            scale,
            truecolor,
            showAxis,
            showLegend,
          }),
      })}
    </Box>
  );
});
