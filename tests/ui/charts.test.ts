import { describe, it } from 'fino:test/test';
import { h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import { stringWidth } from 'fino:tty/frame';
import { BarChart, Box, LineChart } from 'fino:ui/components';
import type { Series } from 'fino:ui/components';
import { pageCss, toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import {
  CHART_PALETTE,
  niceScale,
  plotBraille,
  seriesColor,
  seriesScale,
} from 'internal:ui/components/charts';
import { chartsPreviews } from 'internal:ui/components/charts.preview';
import { defaultArgs } from 'internal:ui/preview';
import { createTuiHarness, plainLine } from './tui-harness.ts';

function html(tree: VNode): string {
  return renderToHtml(toHtml(tree));
}

function braille(bits: number): string {
  return String.fromCodePoint(0x2800 + bits);
}

const SCALE = { min: 0, max: 4, step: 4, ticks: [0, 4] };

describe('shared chart scale and rasterization', () => {
  it('produces stable nice scales across signs, order, and magnitudes', (t) => {
    t.deepEqual(niceScale(0, 87), {
      min: 0,
      max: 100,
      step: 20,
      ticks: [0, 20, 40, 60, 80, 100],
    });
    t.deepEqual(niceScale(87, 0), niceScale(0, 87));
    t.deepEqual(niceScale(-100, -10), {
      min: -100,
      max: 0,
      step: 20,
      ticks: [-100, -80, -60, -40, -20, 0],
    });
    t.deepEqual(niceScale(0.0001, 0.0009).ticks, [0, 0.0002, 0.0004, 0.0006, 0.0008, 0.001]);
    t.deepEqual(niceScale(5, 5), { min: 2, max: 8, step: 1, ticks: [2, 3, 4, 5, 6, 7, 8] });
  });

  it('shares finite series ranges and stable palette resolution', (t) => {
    const series: Series[] = [
      { key: 'a', points: [Number.NaN, 3] },
      { key: 'b', color: 'red', points: [7] },
    ];
    t.deepEqual(seriesScale(series), niceScale(3, 7));
    t.equal(seriesColor(series[0]!, CHART_PALETTE.length), CHART_PALETTE[0]);
    t.equal(seriesColor(series[1]!, 1), 'red');
  });

  it('rasterizes empty, single-point, connected, and crossing series', (t) => {
    t.deepEqual(plotBraille([], 2, 1, SCALE), [braille(0).repeat(2)]);
    t.deepEqual(plotBraille([[4]], 1, 1, SCALE), [braille(0x01)]);
    t.deepEqual(plotBraille([[0]], 1, 1, SCALE), [braille(0x40)]);
    t.equal(plotBraille([[0, 4]], 2, 1, SCALE)[0], braille(0x60) + braille(0x0a));
    const crossing = plotBraille(
      [
        [0, 4],
        [4, 0],
      ],
      2,
      1,
      SCALE,
    )[0]!;
    t.ok(crossing !== plotBraille([[0, 4]], 2, 1, SCALE)[0]);
  });
});

describe('chart HTML lowerings', () => {
  it('renders grouped and horizontal bars as responsive accessible SVG', (t) => {
    const series: Series[] = [
      { key: 'a', points: [1, 2] },
      { key: 'b', points: [3, 4] },
    ];
    const vertical = html(h(BarChart, { series, labels: ['x', 'y'], showValues: true }));
    const horizontal = html(h(BarChart, { series, labels: ['x', 'y'], horizontal: true }));
    t.equal((vertical.match(/<rect/g) ?? []).length, 4);
    t.equal((horizontal.match(/<rect/g) ?? []).length, 4);
    t.ok(vertical.includes('role="img"'));
    t.ok(vertical.includes('<title>Bar chart'));
    t.ok(pageCss().includes('.ui-chart-svg { display: block; width: 100%'));
    t.ok(!/[⠀-⣿]/.test(vertical));
  });

  it('renders empty and multi-series lines with optional axes and legends', (t) => {
    const empty = html(h(LineChart, { series: [] }));
    const populated = html(
      h(LineChart, {
        series: [
          { key: 'a', label: 'Alpha', points: [1] },
          { key: 'b', label: 'Beta', points: [2, 1] },
        ],
        showAxis: true,
        showLegend: true,
      }),
    );
    t.ok(empty.includes('Line chart of 0 series'));
    t.equal((populated.match(/<polyline/g) ?? []).length, 2);
    t.ok(populated.includes('<line'));
    t.ok(populated.includes('ui-chart-legend'));
    t.ok(populated.includes('Alpha') && populated.includes('Beta'));
  });
});

describe('chart terminal lowerings', () => {
  it('renders vertical and horizontal bars with labels and values', (t) => {
    const series: Series[] = [{ key: 'v', points: [0, 4, 8] }];
    const vertical = createTuiHarness(12, 4);
    vertical.render(h(BarChart, { series, labels: ['x', 'y', 'z'], height: 2 }));
    const rows = vertical.lines().map(plainLine);
    t.ok(rows.some((row) => row.includes('█')));
    t.ok(rows.some((row) => row.includes('x') && row.includes('z')));

    const horizontal = createTuiHarness(18, 4);
    horizontal.render(
      h(BarChart, { series, labels: ['long-label', 'y', 'z'], horizontal: true, showValues: true }),
    );
    t.ok(
      horizontal
        .lines()
        .map(plainLine)
        .some((row) => row.includes('8')),
    );
    t.ok(Math.max(...horizontal.lines().map((row) => stringWidth(plainLine(row)))) <= 18);
  });

  it('fills wide containers while remaining inside narrow constraints', (t) => {
    const series: Series[] = [{ key: 'latency', points: [3, 7, 4, 9, 5, 8, 6, 10] }];
    const widthOf = (width: number, showAxis = false): number => {
      const app = createTuiHarness(width, 7);
      app.render(h(Box, { width }, h(LineChart, { series, height: 5, showAxis })));
      return Math.max(...app.lines().map((line) => stringWidth(plainLine(line))));
    };
    const narrow = widthOf(12, true);
    const wide = widthOf(60);
    t.ok(narrow <= 12);
    t.ok(wide > narrow + 20);
    t.ok(wide <= 60);
  });

  it('renders multiple series, axes, legends, and crossings', (t) => {
    const app = createTuiHarness(36, 6);
    app.render(
      h(LineChart, {
        series: [
          { key: 'up', points: [0, 4], color: { rgb: [255, 0, 0] } },
          { key: 'down', points: [4, 0], color: { rgb: [0, 0, 255] } },
        ],
        height: 3,
        showAxis: true,
        showLegend: true,
      }),
    );
    const text = app.lines().map(plainLine).join('\n');
    t.ok(/[⠀-⣿]/.test(text));
    t.ok(text.includes('up') && text.includes('down'));
  });
});

describe('chart previews and styles', () => {
  it('keeps previews renderable and CSS registered once', (t) => {
    const group = chartsPreviews();
    t.equal(group.title, 'Charts');
    t.deepEqual(
      group.previews.map((preview) => preview.key),
      ['bar-chart', 'line-chart'],
    );
    for (const preview of group.previews) {
      t.ok(html(preview.view(defaultArgs(preview))).length > 0, preview.key);
    }
    t.equal(pageCss().split('.ui-chart-svg {').length - 1, 1);
  });
});
