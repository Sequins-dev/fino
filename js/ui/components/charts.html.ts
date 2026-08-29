/** Native SVG lowerings and styles for chart components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { cssColor, componentStyleAttrs, HTML_ROW_PX } from 'internal:ui/components/html-runtime';
import {
  BarChart,
  LineChart,
  chartCategories,
  chartRows,
  seriesColor,
  seriesScale,
} from 'internal:ui/components/charts';
import type { Series } from 'internal:ui/components/charts';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

const SVG_WIDTH = 480;

function point(series: Series, index: number): number {
  const value = series.points[index] ?? 0;
  return Number.isFinite(value) ? value : 0;
}

function chartSvg(height: number, label: string, children: VNode[]): VNode {
  return h(
    'svg',
    {
      className: 'ui-chart-svg',
      viewBox: `0 0 ${SVG_WIDTH} ${height}`,
      role: 'img',
      'aria-label': label,
      xmlns: 'http://www.w3.org/2000/svg',
    },
    h('title', null, label),
    ...children,
  );
}

function legend(series: readonly Series[]): VNode {
  return h(
    'div',
    { className: 'ui-chart-legend' },
    ...series.map((entry, index) =>
      h(
        'span',
        { className: 'ui-chart-legend-item' },
        h('span', {
          className: 'ui-chart-legend-swatch',
          style: { background: cssColor(seriesColor(entry, index)) },
          'aria-hidden': 'true',
        }),
        entry.label ?? entry.key,
      ),
    ),
  );
}

mapComponentLowering(BarChart, 'html', (props) => {
  const categories = chartCategories(props.series, props.labels);
  const scale = seriesScale(props.series, true);
  const span = scale.max - scale.min || 1;
  const innerHeight = chartRows(props.height) * HTML_ROW_PX;
  const horizontal = props.horizontal === true;
  const labelWidth = horizontal
    ? Math.min(120, Math.max(16, ...categories.map((label) => label.length * 7)))
    : 8;
  const margin = {
    top: props.showValues === true ? 20 : 8,
    right: horizontal && props.showValues === true ? 44 : 8,
    bottom: horizontal ? 8 : 24,
    left: labelWidth,
  };
  const svgHeight = innerHeight + margin.top + margin.bottom;
  const innerWidth = SVG_WIDTH - margin.left - margin.right;
  const parts: VNode[] = [];
  if (horizontal) {
    const rowHeight = innerHeight / Math.max(1, categories.length);
    const gap = rowHeight * 0.15;
    const barHeight = (rowHeight - gap) / Math.max(1, props.series.length);
    const zero = margin.left + (innerWidth * (0 - scale.min)) / span;
    categories.forEach((category, categoryIndex) => {
      props.series.forEach((entry, seriesIndex) => {
        const value = point(entry, categoryIndex);
        const end = margin.left + (innerWidth * (value - scale.min)) / span;
        const y = margin.top + categoryIndex * rowHeight + gap / 2 + seriesIndex * barHeight;
        parts.push(
          h(
            'rect',
            {
              x: Math.min(end, zero),
              y,
              width: Math.abs(end - zero),
              height: Math.max(0, barHeight),
              fill: cssColor(seriesColor(entry, seriesIndex)),
            },
            h('title', null, `${entry.label ?? entry.key} — ${category}: ${value}`),
          ),
        );
        if (props.showValues === true) {
          parts.push(
            h(
              'text',
              {
                x: end + (value < 0 ? -4 : 4),
                y: y + barHeight / 2,
                'text-anchor': value < 0 ? 'end' : 'start',
                'dominant-baseline': 'middle',
                'font-size': '10',
              },
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
            y: margin.top + categoryIndex * rowHeight + rowHeight / 2,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
            'font-size': '10',
          },
          category,
        ),
      );
    });
  } else {
    const clusterWidth = innerWidth / Math.max(1, categories.length);
    const gap = clusterWidth * 0.15;
    const barWidth = (clusterWidth - gap) / Math.max(1, props.series.length);
    const zero = margin.top + innerHeight * (1 - (0 - scale.min) / span);
    categories.forEach((category, categoryIndex) => {
      props.series.forEach((entry, seriesIndex) => {
        const value = point(entry, categoryIndex);
        const end = margin.top + innerHeight * (1 - (value - scale.min) / span);
        const x = margin.left + categoryIndex * clusterWidth + gap / 2 + seriesIndex * barWidth;
        parts.push(
          h(
            'rect',
            {
              x,
              y: Math.min(end, zero),
              width: Math.max(0, barWidth),
              height: Math.abs(end - zero),
              fill: cssColor(seriesColor(entry, seriesIndex)),
            },
            h('title', null, `${entry.label ?? entry.key} — ${category}: ${value}`),
          ),
        );
        if (props.showValues === true) {
          parts.push(
            h(
              'text',
              { x: x + barWidth / 2, y: end - 4, 'text-anchor': 'middle', 'font-size': '10' },
              String(value),
            ),
          );
        }
      });
      parts.push(
        h(
          'text',
          {
            x: margin.left + categoryIndex * clusterWidth + clusterWidth / 2,
            y: svgHeight - 6,
            'text-anchor': 'middle',
            'font-size': '10',
          },
          category,
        ),
      );
    });
  }
  const summary = `Bar chart of ${props.series.length} series across ${categories.length} categories`;
  return h(
    'div',
    componentStyleAttrs(props as Props, 'ui-bar-chart'),
    chartSvg(svgHeight, summary, parts),
  );
});

mapComponentLowering(LineChart, 'html', (props) => {
  const scale = seriesScale(props.series);
  const span = scale.max - scale.min || 1;
  const innerHeight = chartRows(props.height) * HTML_ROW_PX;
  const margin = { top: 12, right: 12, bottom: 8, left: props.showAxis === true ? 44 : 8 };
  const svgHeight = innerHeight + margin.top + margin.bottom;
  const innerWidth = SVG_WIDTH - margin.left - margin.right;
  const maxPoints = Math.max(1, ...props.series.map((entry) => entry.points.length));
  const x = (index: number): number =>
    margin.left + (maxPoints <= 1 ? 0 : (index * innerWidth) / (maxPoints - 1));
  const y = (value: number): number =>
    margin.top +
    innerHeight * (1 - ((Number.isFinite(value) ? value : scale.min) - scale.min) / span);
  const parts: VNode[] = [];
  if (props.showAxis === true) {
    for (const tick of scale.ticks) {
      const row = y(tick);
      parts.push(
        h('line', {
          x1: margin.left,
          x2: SVG_WIDTH - margin.right,
          y1: row,
          y2: row,
          stroke: 'var(--ui-border)',
          'stroke-width': '1',
        }),
        h(
          'text',
          {
            x: margin.left - 4,
            y: row,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
            'font-size': '10',
          },
          String(tick),
        ),
      );
    }
  }
  props.series.forEach((entry, index) => {
    const points = entry.points
      .map((value, pointIndex) => `${x(pointIndex)},${y(value)}`)
      .join(' ');
    parts.push(
      h(
        'polyline',
        {
          points,
          fill: 'none',
          stroke: cssColor(seriesColor(entry, index)),
          'stroke-width': '2',
        },
        h('title', null, entry.label ?? entry.key),
      ),
    );
  });
  const summary = `Line chart of ${props.series.length} series: ${props.series
    .map((entry) => entry.label ?? entry.key)
    .join(', ')}`;
  return h(
    'div',
    componentStyleAttrs(props as Props, 'ui-line-chart'),
    chartSvg(svgHeight, summary, parts),
    props.showLegend === true ? legend(props.series) : null,
  );
});

registerHtmlCss(`
.ui-bar-chart, .ui-line-chart { min-width: 0; max-width: 100%; }
.ui-chart-svg { display: block; width: 100%; max-width: 100%; height: auto; overflow: visible; }
.ui-chart-svg text { fill: var(--ui-fg); }
.ui-chart-legend { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin-top: 0.35rem; }
.ui-chart-legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
.ui-chart-legend-swatch { width: 0.75rem; height: 0.75rem; border-radius: 50%; }
`);
