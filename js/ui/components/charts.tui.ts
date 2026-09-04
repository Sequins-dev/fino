/** Responsive terminal lowerings for chart components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { env } from 'fino:process';
import { stringWidth } from 'fino:tty/frame';
import { supportsTruecolor } from 'fino:tty/style';
import type { Color } from 'fino:tty/style';
import { Box } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { adaptTerminalColor } from 'internal:ui/components/color.tui';
import {
  BarChart,
  LineChart,
  chartCategories,
  chartRows,
  formatChartValue,
  plotBraille,
  seriesColor,
  seriesScale,
} from 'internal:ui/components/charts';
import type {
  BarChartProps,
  LineChartProps,
  NiceScale,
  Series,
} from 'internal:ui/components/charts';
import { mapComponentLowering } from 'internal:ui/components/target';

const BLOCK_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const BRAILLE_BLANK = String.fromCodePoint(0x2800);

function primitiveText(text: string, props: Props = {}): VNode {
  return h('text', props, text);
}

function colorOf(series: Series, index: number, truecolor: boolean): Color {
  return adaptTerminalColor(seriesColor(series, index), truecolor);
}

function horizontalBars(
  props: Omit<BarChartProps, 'children'>,
  categories: string[],
  scale: NiceScale,
  width: number,
  truecolor: boolean,
): VNode {
  const valueWidth =
    props.showValues === true
      ? Math.max(
          1,
          ...props.series.flatMap((entry) => entry.points.map(formatChartValue)).map(stringWidth),
        )
      : 0;
  const longestLabel = Math.max(0, ...categories.map(stringWidth));
  const labelWidth = Math.min(longestLabel, Math.max(0, width - valueWidth - 3));
  const trackWidth = Math.max(1, width - labelWidth - valueWidth - (valueWidth > 0 ? 2 : 1));
  const span = scale.max - scale.min || 1;
  const zero = Math.round(((0 - scale.min) / span) * (trackWidth - 1));
  return h(
    'box',
    { direction: 'column' },
    ...categories.flatMap((category, categoryIndex) =>
      props.series.map((entry, seriesIndex) => {
        const raw = entry.points[categoryIndex] ?? 0;
        const value = Number.isFinite(raw) ? raw : 0;
        const end = Math.round(((value - scale.min) / span) * (trackWidth - 1));
        const from = Math.max(0, Math.min(zero, end));
        const to = Math.min(trackWidth - 1, Math.max(zero, end));
        const cells = Array.from({ length: trackWidth }, (_, index) =>
          index >= from && index <= to && value !== 0 ? '█' : index === zero ? '│' : ' ',
        ).join('');
        return h(
          'box',
          { key: `${categoryIndex}:${entry.key}`, direction: 'row', gap: 1 },
          primitiveText(seriesIndex === 0 ? category : '', {
            width: labelWidth,
            truncate: true,
          }),
          primitiveText(cells, { style: [{ fg: colorOf(entry, seriesIndex, truecolor) }] }),
          valueWidth > 0
            ? primitiveText(formatChartValue(value), {
                width: valueWidth,
                align: 'end',
                style: [styles.dim],
              })
            : null,
        );
      }),
    ),
  );
}

function verticalBars(
  props: Omit<BarChartProps, 'children'>,
  categories: string[],
  scale: NiceScale,
  width: number,
  truecolor: boolean,
): VNode {
  const rows = chartRows(props.height);
  const values = props.series.flatMap((entry) => entry.points).filter(Number.isFinite);
  const valueWidth =
    props.showValues === true ? Math.max(1, ...values.map(formatChartValue).map(stringWidth)) : 1;
  const groupWidth = Math.max(1, Math.floor(width / Math.max(1, categories.length)));
  const barWidth = Math.max(1, Math.floor(groupWidth / Math.max(1, props.series.length)));
  const span = scale.max - scale.min || 1;
  return h(
    'box',
    { direction: 'row' },
    ...categories.map((category, categoryIndex) =>
      h(
        'box',
        { key: String(categoryIndex), direction: 'column', width: groupWidth },
        props.showValues === true
          ? h(
              'box',
              { direction: 'row' },
              ...props.series.map((entry, seriesIndex) =>
                primitiveText(formatChartValue(entry.points[categoryIndex] ?? 0), {
                  key: entry.key,
                  width: Math.max(barWidth, valueWidth),
                  align: 'center',
                  truncate: true,
                  style: [{ fg: colorOf(entry, seriesIndex, truecolor) }],
                }),
              ),
            )
          : null,
        h(
          'box',
          { direction: 'column' },
          ...Array.from({ length: rows }, (_, row) =>
            h(
              'box',
              { key: String(row), direction: 'row' },
              ...props.series.map((entry, seriesIndex) => {
                const raw = entry.points[categoryIndex] ?? 0;
                const value = Number.isFinite(raw) ? raw : 0;
                const fraction = Math.max(0, Math.min(1, (value - scale.min) / span));
                const filledEighths = Math.round(fraction * rows * 8);
                const band = (rows - 1 - row) * 8;
                const filled = Math.max(0, Math.min(8, filledEighths - band));
                const glyph = filled === 0 ? ' ' : BLOCK_LEVELS[filled - 1]!;
                return primitiveText(glyph.repeat(barWidth), {
                  key: entry.key,
                  style: filled === 0 ? [] : [{ fg: colorOf(entry, seriesIndex, truecolor) }],
                });
              }),
            ),
          ),
        ),
        primitiveText(category, {
          width: groupWidth,
          align: 'center',
          truncate: true,
          style: [styles.dim],
        }),
      ),
    ),
  );
}

mapComponentLowering(BarChart, 'tui', (props) => {
  const { series, labels, height, horizontal, showValues, ...boxProps } = props;
  const input = { series, labels, height, horizontal, showValues };
  const categories = chartCategories(series, labels);
  const scale = seriesScale(series, true);
  const truecolor = supportsTruecolor(env.COLORTERM);
  return h(
    Box,
    boxProps,
    h('measured', {
      render: ({ width }: { width: number }) =>
        horizontal === true
          ? horizontalBars(input, categories, scale, Math.max(1, width), truecolor)
          : verticalBars(input, categories, scale, Math.max(1, width), truecolor),
    }),
  );
});

interface ChartCell {
  char: string;
  color: Color | null;
}

function axisWidth(scale: NiceScale, showAxis: boolean | undefined, available: number): number {
  if (showAxis !== true) return 0;
  const wanted = Math.max(0, ...scale.ticks.map((tick) => stringWidth(formatChartValue(tick)))) + 1;
  return Math.min(wanted, Math.max(0, available - 1));
}

function linePlot(
  series: readonly Series[],
  rows: number,
  width: number,
  scale: NiceScale,
  truecolor: boolean,
  showAxis: boolean | undefined,
  showLegend: boolean | undefined,
): VNode {
  const gutter = axisWidth(scale, showAxis, width);
  const plotWidth = Math.max(1, width - gutter);
  const composite: ChartCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: plotWidth }, () => ({ char: ' ', color: null })),
  );
  series.forEach((entry, seriesIndex) => {
    const color = colorOf(entry, seriesIndex, truecolor);
    const grid = plotBraille([entry.points], plotWidth, rows, scale);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < plotWidth; column++) {
        const char = grid[row]![column]!;
        if (char !== BRAILLE_BLANK) composite[row]![column] = { char, color };
      }
    }
  });
  const tickRows = new Map<number, number>();
  if (showAxis === true) {
    for (const tick of scale.ticks) {
      const row = Math.round(((scale.max - tick) / (scale.max - scale.min || 1)) * (rows - 1));
      tickRows.set(Math.max(0, Math.min(rows - 1, row)), tick);
    }
  }
  const plot = Array.from({ length: rows }, (_, row) => {
    const runs: VNode[] = [];
    let start = 0;
    while (start < plotWidth) {
      const color = composite[row]![start]!.color;
      let end = start + 1;
      while (end < plotWidth && composite[row]![end]!.color === color) end++;
      runs.push(
        primitiveText(
          composite[row]!.slice(start, end)
            .map((cell) => cell.char)
            .join(''),
          { key: String(start), style: color === null ? [] : [{ fg: color }] },
        ),
      );
      start = end;
    }
    return h(
      'box',
      { key: String(row), direction: 'row' },
      gutter > 0
        ? primitiveText(tickRows.has(row) ? formatChartValue(tickRows.get(row)!) : '', {
            width: gutter,
            align: 'end',
            style: [styles.dim],
          })
        : null,
      h('box', { direction: 'row' }, ...runs),
    );
  });
  const legend =
    showLegend === true
      ? h(
          'box',
          { direction: 'row', wrap: true, gap: 1, width },
          ...series.map((entry, index) =>
            h(
              'box',
              { key: entry.key, direction: 'row' },
              primitiveText('●', { style: [{ fg: colorOf(entry, index, truecolor) }] }),
              primitiveText(` ${entry.label ?? entry.key}`, { style: [styles.dim] }),
            ),
          ),
        )
      : null;
  return h('box', { direction: 'column' }, h('box', { direction: 'column' }, ...plot), legend);
}

mapComponentLowering(LineChart, 'tui', (props) => {
  const { series, height, showAxis, showLegend, ...boxProps } = props;
  const rows = chartRows(height);
  const scale = seriesScale(series);
  const truecolor = supportsTruecolor(env.COLORTERM);
  return h(
    Box,
    boxProps,
    h('measured', {
      render: ({ width }: { width: number }) =>
        linePlot(series, rows, Math.max(1, width), scale, truecolor, showAxis, showLegend),
    }),
  );
});
