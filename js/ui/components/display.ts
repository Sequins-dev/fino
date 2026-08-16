/**
 * internal:ui/components/display — content presentation surfaces: cards,
 * statistics, status dots, and empty states.
 *
 * @internal
 */
import { h, type NormalizedChild, type Child, type Props, type VNode } from 'fino:ui';
import {
  idAttr,
  safeHref,
  slotChildren,
  tone,
} from 'internal:ui/components/html-runtime';
import type { FlexChildProps } from 'internal:ui/components/primitives';
import { iconForm } from 'internal:ui/components/icons';
import type { IconForms } from 'internal:ui/components/icons';

/** Props accepted by `Card`. */
export interface CardProps extends FlexChildProps, Props {
  title?: string;
  subtitle?: string;
  /**
   * Media slot. The web renders a real `<img src alt>` — `src` passes
   * through the HTML target's `safeHref` allowlist the same as a `Link`
   * `href`, since an image URL is just as app-controlled. The terminal
   * cannot paint images, so it paints a dim `[ alt ]` placeholder line
   * instead.
   */
  image?: { src: string; alt: string };
  /** Footer row of control buttons. */
  actions?: Child;
  id?: string;
  children?: Child;
}
/**
 * Content container: an optional media slot, title/subtitle, body, and a
 * footer row of `actions`. A bordered box in the terminal, a real
 * `<article>` on the web.
 */
export function Card(all: CardProps): VNode {
  const { children = [], ...props } = all as CardProps & { children?: NormalizedChild[] };
  const { title, subtitle, image, actions, id } = props;
  const safeSrc = image !== undefined ? safeHref(image.src) : undefined;
  const media =
    image !== undefined && safeSrc !== undefined
      ? h('div', { className: 'ui-card-media' }, h('img', { src: safeSrc, alt: image.alt }))
      : null;
  const header =
    title !== undefined || subtitle !== undefined
      ? h(
          'div',
          { className: 'ui-card-header' },
          title !== undefined ? h('h3', { className: 'ui-card-title' }, title) : null,
          subtitle !== undefined ? h('p', { className: 'ui-card-subtitle' }, subtitle) : null,
        )
      : null;
  const body = h('div', { className: 'ui-card-body' }, ...children);
  const footer =
    actions !== undefined
      ? h('div', { className: 'ui-card-actions' }, ...slotChildren(actions))
      : null;
  return h('article', { className: 'ui-card', ...idAttr(id) }, media, header, body, footer);
}

/** Trend direction shown by `Stat`. */
export type Trend = 'up' | 'down' | 'flat';

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

/** Props accepted by `Stat`. */
export interface StatProps extends FlexChildProps, Props {
  label: string;
  value: string;
  hint?: string;
  trend?: Trend;
  id?: string;
}
/**
 * Named statistic: a dim label above a bold value, with an optional trend
 * indicator (`▲`/`▼`/`–`, colored success/danger/muted). The trend glyph
 * itself carries the direction — not just its color — and the web target
 * additionally names it through `aria-label`, so the signal never rests on
 * color alone.
 */
export function Stat(all: StatProps): VNode {
  const { children = [], ...props } = all as StatProps & { children?: NormalizedChild[] };
  const { label, value, hint, trend, id } = props;
  const trendSpan =
    trend !== undefined
      ? h(
          'span',
          {
            className: `ui-stat-trend ui-tone-${TREND_TONE[trend]}`,
            'aria-label': TREND_LABEL[trend],
          },
          TREND_GLYPH[trend],
        )
      : null;
  return h(
    'dl',
    { className: 'ui-stat', ...idAttr(id) },
    h('dt', null, label),
    h('dd', { className: 'ui-stat-value' }, value, trendSpan),
    hint !== undefined ? h('dd', { className: 'ui-stat-hint' }, hint) : null,
  );
}

/** Status values shown by `StatusDot`. */
export type StatusDotStatus = 'ok' | 'busy' | 'error' | 'idle' | 'warning';

/** Props accepted by `StatusDot`. */
export interface StatusDotProps extends FlexChildProps, Props {
  status: StatusDotStatus;
  label?: string;
  id?: string;
}
/**
 * Status indicator: a colored `●` plus an optional `label`. On the web the
 * status is always conveyed as text too — the visible `label` when given, an
 * `aria-label` naming the status when not — never color alone.
 */
export function StatusDot(all: StatusDotProps): VNode {
  const { children = [], ...props } = all as StatusDotProps & { children?: NormalizedChild[] };
  const { status, label, id } = props;
  const dot = h('span', {
    className: `ui-status-dot ui-tone-${STATUS_TONE[status]}`,
    ...(label !== undefined ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': status }),
  });
  return h(
    'span',
    { className: 'ui-row', ...idAttr(id) },
    dot,
    label !== undefined ? h('span', null, label) : null,
  );
}

/** Props accepted by `EmptyState`. */
export interface EmptyStateProps extends FlexChildProps, Props {
  /** Registry icon name; see `ICONS`/`iconForm`. */
  icon?: string;
  title: string;
  description?: string;
  action?: Child;
  /** Per-name registry overrides, forwarded to `iconForm`. */
  icons?: Record<string, IconForms>;
  id?: string;
}
/**
 * Centered indicator for an empty content area: an optional icon, a title, a
 * dim description, and an optional `action`. Centering is ordinary
 * `justify`/`align` on a `Box` — give it room to fill (`grow`, an explicit
 * `height`, …) for the centering to be visible.
 */
export function EmptyState(all: EmptyStateProps): VNode {
  const { children = [], ...props } = all as EmptyStateProps & { children?: NormalizedChild[] };
  const { icon, title, description, action, icons, id } = props;
  return h(
    'div',
    { className: 'ui-empty-state', ...idAttr(id) },
    icon !== undefined
      ? h(
          'span',
          { className: 'ui-empty-state-icon', 'aria-hidden': 'true' },
          iconForm(icon, 'html', icons),
        )
      : null,
    h('p', { className: 'ui-empty-state-title' }, title),
    description !== undefined ? h('p', { className: 'ui-empty-state-desc' }, description) : null,
    action !== undefined
      ? h('div', { className: 'ui-empty-state-action' }, ...slotChildren(action))
      : null,
  );
}
