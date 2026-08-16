/**
 * internal:ui/components/display — content presentation surfaces: cards,
 * statistics, status dots, and empty states.
 *
 * @internal
 */
import { h, type Child, type Props, type VNode } from 'fino:ui';
import type { FlexChildProps } from 'internal:ui/components/primitives';
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
export function Card(props: CardProps): VNode {
  return h('ui:card', props);
}

/** Trend direction shown by `Stat`. */
export type Trend = 'up' | 'down' | 'flat';

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
export function Stat(props: StatProps): VNode {
  return h('ui:stat', props);
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
export function StatusDot(props: StatusDotProps): VNode {
  return h('ui:status-dot', props);
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
export function EmptyState(props: EmptyStateProps): VNode {
  return h('ui:empty-state', props);
}
