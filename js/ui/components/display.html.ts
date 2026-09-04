/** HTML lowerings and styles for display components. @internal */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { componentStyleAttrs, safeHref } from 'internal:ui/components/html-runtime';
import { Card, EmptyState, Stat, StatusDot } from 'internal:ui/components/display';
import type { StatusDotStatus, Trend } from 'internal:ui/components/display';
import { iconForm } from 'internal:ui/components/icons';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

const TREND_GLYPH: Record<Trend, string> = { up: '▲', down: '▼', flat: '–' };
const TREND_LABEL: Record<Trend, string> = {
  up: 'trending up',
  down: 'trending down',
  flat: 'no change',
};
const TREND_TONE: Record<Trend, string> = { up: 'success', down: 'danger', flat: 'muted' };
const STATUS_TONE: Record<StatusDotStatus, string> = {
  ok: 'success',
  busy: 'info',
  error: 'danger',
  idle: 'muted',
  warning: 'warning',
};

mapComponentLowering(Card, 'html', (props, children) => {
  const safeSrc = props.image === undefined ? undefined : safeHref(props.image.src);
  return h(
    'article',
    componentStyleAttrs(props as Props, 'ui-card'),
    props.image !== undefined && safeSrc !== undefined
      ? h('div', { className: 'ui-card-media' }, h('img', { src: safeSrc, alt: props.image.alt }))
      : null,
    props.title === undefined && props.subtitle === undefined
      ? null
      : h(
          'header',
          { className: 'ui-card-header' },
          props.title === undefined ? null : h('h3', { className: 'ui-card-title' }, props.title),
          props.subtitle === undefined
            ? null
            : h('p', { className: 'ui-card-subtitle' }, props.subtitle),
        ),
    h('div', { className: 'ui-card-body' }, ...children),
    props.actions === undefined
      ? null
      : h('footer', { className: 'ui-card-actions' }, props.actions),
  );
});

mapComponentLowering(Stat, 'html', (props) =>
  h(
    'dl',
    componentStyleAttrs(props as Props, 'ui-stat'),
    h('dt', null, props.label),
    h(
      'dd',
      { className: 'ui-stat-value' },
      props.value,
      props.trend === undefined
        ? null
        : h(
            'span',
            {
              className: `ui-stat-trend is-${TREND_TONE[props.trend]}`,
              'aria-label': TREND_LABEL[props.trend],
            },
            TREND_GLYPH[props.trend],
          ),
    ),
    props.hint === undefined ? null : h('dd', { className: 'ui-stat-hint' }, props.hint),
  ),
);

mapComponentLowering(StatusDot, 'html', (props) =>
  h(
    'span',
    componentStyleAttrs(props as Props, 'ui-status'),
    h('span', {
      className: `ui-status-dot is-${STATUS_TONE[props.status]}`,
      ...(props.label === undefined
        ? { role: 'img', 'aria-label': props.status }
        : { 'aria-hidden': 'true' }),
    }),
    props.label === undefined ? null : h('span', null, props.label),
  ),
);

mapComponentLowering(EmptyState, 'html', (props) =>
  h(
    'section',
    componentStyleAttrs(props as Props, 'ui-empty-state'),
    props.icon === undefined
      ? null
      : h(
          'span',
          { className: 'ui-empty-state-icon', 'aria-hidden': 'true' },
          iconForm(props.icon, 'html', props.icons),
        ),
    h('p', { className: 'ui-empty-state-title' }, props.title),
    props.description === undefined
      ? null
      : h('p', { className: 'ui-empty-state-desc' }, props.description),
    props.action === undefined
      ? null
      : h('div', { className: 'ui-empty-state-action' }, props.action),
  ),
);

registerHtmlCss(`
.ui-card { overflow: hidden; border: 1px solid var(--ui-border); border-radius: 0.5rem; background: var(--ui-surface); }
.ui-card-media img { display: block; width: 100%; height: auto; }
.ui-card-header, .ui-card-body, .ui-card-actions { padding: 0.75rem 1rem; }
.ui-card-title { margin: 0; }
.ui-card-subtitle, .ui-stat dt, .ui-stat-hint, .ui-empty-state-desc { margin: 0.2rem 0 0; color: var(--tui-bright-black); }
.ui-card-actions { display: flex; justify-content: flex-end; gap: 0.5rem; border-top: 1px solid var(--ui-border); }
.ui-stat { margin: 0; }
.ui-stat dd { margin: 0; }
.ui-stat-value { display: flex; align-items: center; gap: 0.5rem; font-size: 1.5em; font-weight: 700; }
.ui-stat-trend.is-success { color: var(--tui-green); }
.ui-stat-trend.is-danger { color: var(--tui-red); }
.ui-stat-trend.is-muted { color: var(--tui-bright-black); }
.ui-status { display: inline-flex; align-items: center; gap: 0.4rem; }
.ui-status-dot { width: 0.65rem; height: 0.65rem; border-radius: 50%; background: currentColor; }
.ui-status-dot.is-success { color: var(--tui-green); }
.ui-status-dot.is-info { color: var(--tui-blue); }
.ui-status-dot.is-danger { color: var(--tui-red); }
.ui-status-dot.is-warning { color: var(--tui-yellow); }
.ui-status-dot.is-muted { color: var(--tui-bright-black); }
.ui-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5rem; text-align: center; }
.ui-empty-state-icon { font-size: 2rem; }
.ui-empty-state-title { margin: 0; font-weight: 700; }
`);
