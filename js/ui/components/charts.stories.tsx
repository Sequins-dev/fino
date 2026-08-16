/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/charts.stories — gallery stories for bar and line charts.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/gallery` composes every group into the browsable catalog.
 *
 * @internal
 */
import { BarChart, LineChart } from 'fino:ui/components';
import type { Series } from 'fino:ui/components';
import type { StoryGroup } from 'internal:ui/story';

// Fixed sample data — deterministic, no `Math.random()`, so the gallery (and
// anything that snapshots it, e.g. the HTML target's markup assertions in
// tests) renders identically on every run.
const BAR_CATEGORIES = ['Q1', 'Q2', 'Q3', 'Q4'];
const BAR_SERIES: Series[] = [
  { key: 'north', label: 'North', points: [12, 19, 8, 24] },
  { key: 'south', label: 'South', points: [9, 14, 17, 11] },
  { key: 'east', label: 'East', points: [15, 6, 21, 13] },
];
const LINE_SERIES: Series[] = [
  { key: 'p50', label: 'p50 latency', points: [12, 14, 11, 15, 13, 16, 14, 18, 15, 17] },
  { key: 'p99', label: 'p99 latency', points: [30, 34, 28, 36, 33, 40, 35, 44, 38, 42] },
  { key: 'errors', label: 'error rate', points: [1, 2, 1, 3, 2, 2, 4, 3, 2, 1] },
];

export function chartsStories(): StoryGroup {
  return {
    title: 'Charts',
    stories: [
      {
        key: 'bar-chart',
        name: 'BarChart',
        controls: {
          seriesCount: { type: 'number', label: 'Series', default: 2, min: 1, max: 3, step: 1 },
          height: { type: 'number', default: 8, min: 3, max: 12, step: 1 },
          horizontal: { type: 'boolean', default: false },
          showValues: { type: 'boolean', default: false },
        },
        view: (args) => (
          <BarChart
            series={BAR_SERIES.slice(0, Number(args.seriesCount))}
            labels={BAR_CATEGORIES}
            height={Number(args.height)}
            horizontal={args.horizontal === true}
            showValues={args.showValues === true}
          />
        ),
      },
      {
        key: 'line-chart',
        name: 'LineChart',
        controls: {
          seriesCount: { type: 'number', label: 'Series', default: 2, min: 1, max: 3, step: 1 },
          height: { type: 'number', default: 8, min: 3, max: 12, step: 1 },
          showAxis: { type: 'boolean', label: 'Axis', default: true },
          showLegend: { type: 'boolean', label: 'Legend', default: true },
        },
        view: (args) => (
          <LineChart
            series={LINE_SERIES.slice(0, Number(args.seriesCount))}
            height={Number(args.height)}
            showAxis={args.showAxis === true}
            showLegend={args.showLegend === true}
          />
        ),
      },
    ],
  };
}
