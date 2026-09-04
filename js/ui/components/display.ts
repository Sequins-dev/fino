/** Host-neutral cards, statistics, status indicators, and empty states. @internal */
import { h } from 'fino:ui';
import type { Child, Props, VNode } from 'fino:ui';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';
import type { IconForms } from 'internal:ui/components/icons';

/** Props accepted by {@link Card}. */
export interface CardProps extends StyleProps, FlexChildProps, Props {
  title?: string;
  subtitle?: string;
  image?: { src: string; alt: string };
  actions?: Child;
  children?: Child;
}

/** Content surface with optional media, header, body, and action slots. */
export function Card(props: CardProps): VNode {
  return h('ui:card', props);
}

/** Trend direction shown by {@link Stat}. */
export type Trend = 'up' | 'down' | 'flat';

/** Props accepted by {@link Stat}. */
export interface StatProps extends StyleProps, FlexChildProps, Props {
  label: string;
  value: string;
  hint?: string;
  trend?: Trend;
}

/** Named statistic with an optional non-color-only trend indicator. */
export function Stat(props: StatProps): VNode {
  return h('ui:stat', props);
}

/** Status values shown by {@link StatusDot}. */
export type StatusDotStatus = 'ok' | 'busy' | 'error' | 'idle' | 'warning';

/** Props accepted by {@link StatusDot}. */
export interface StatusDotProps extends StyleProps, FlexChildProps, Props {
  status: StatusDotStatus;
  label?: string;
}

/** Status glyph with an optional label. */
export function StatusDot(props: StatusDotProps): VNode {
  return h('ui:status-dot', props);
}

/** Props accepted by {@link EmptyState}. */
export interface EmptyStateProps extends StyleProps, FlexChildProps, Props {
  icon?: string;
  title: string;
  description?: string;
  action?: Child;
  /** Per-name icon registry overrides. */
  icons?: Record<string, IconForms>;
}

/** Centered presentation for an empty content area. */
export function EmptyState(props: EmptyStateProps): VNode {
  return h('ui:empty-state', props);
}
