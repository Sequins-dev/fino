/** Deterministic co-located previews for chart components. @internal */
import { h } from 'fino:ui';
import { BarChart, LineChart } from 'fino:ui/components';
import type { Series } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

const BAR_SERIES: Series[] = [
  { key: 'north', label: 'North', points: [12, 19, 8, 24] },
  { key: 'south', label: 'South', points: [9, 14, 17, 11] },
  { key: 'east', label: 'East', points: [15, 6, 21, 13] },
];
const LINE_SERIES: Series[] = [
  { key: 'p50', label: 'p50 latency', points: [12, 14, 11, 15, 13, 16, 14, 18] },
  { key: 'p99', label: 'p99 latency', points: [30, 34, 28, 36, 33, 40, 35, 44] },
  { key: 'errors', label: 'error rate', points: [1, 2, 1, 3, 2, 2, 4, 3] },
];

/** Build chart-family previews for a catalog host. */
export function chartsPreviews(): PreviewGroup {
  return {
    title: 'Charts',
    previews: [
      {
        key: 'bar-chart',
        name: 'Bar chart',
        controls: {
          horizontal: { type: 'boolean', default: false },
          showValues: { type: 'boolean', default: false },
        },
        view: (args) =>
          h(BarChart, {
            series: BAR_SERIES,
            labels: ['Q1', 'Q2', 'Q3', 'Q4'],
            height: 8,
            horizontal: args.horizontal === true,
            showValues: args.showValues === true,
          }),
      },
      {
        key: 'line-chart',
        name: 'Line chart',
        controls: {
          showAxis: { type: 'boolean', default: true },
          showLegend: { type: 'boolean', default: true },
        },
        view: (args) =>
          h(LineChart, {
            series: LINE_SERIES,
            height: 8,
            showAxis: args.showAxis === true,
            showLegend: args.showLegend === true,
          }),
      },
    ],
  };
}
