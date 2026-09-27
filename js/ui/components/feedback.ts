/**
 * Host-neutral badges, progress, activity, key-hint, and tag components.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Child, Props, VNode } from 'fino:ui';
import { Box } from 'fino:ui/components';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';

/** Semantic tone names used by compact feedback surfaces. */
export type ToneVariant = 'accent' | 'muted' | 'danger' | 'success' | 'warning';

/** A normalized progress value shared by every render target. */
export interface NormalizedProgress {
  /** Clamped completion fraction. */
  fraction: number;
  /** Rounded integer percentage. */
  percent: number;
}

/** Clamp a possibly non-finite progress value to a deterministic 0..1 range. */
export function normalizeProgress(value: number): NormalizedProgress {
  const finite = Number.isFinite(value) ? value : 0;
  const fraction = Math.max(0, Math.min(1, finite));
  return { fraction, percent: Math.round(fraction * 100) };
}

/** Props accepted by {@link Badge}. */
export interface BadgeProps extends StyleProps, FlexChildProps, Props {
  label: string;
  variant?: ToneVariant;
}

/** Small inline status label in a semantic tone. */
export function Badge(props: BadgeProps): VNode {
  return h('ui:badge', props);
}

/** Props accepted by {@link Callout}. */
export interface CalloutProps extends StyleProps, FlexChildProps, Props {
  /** Optional short heading for the callout. */
  title?: string;
  /** Semantic tone. Defaults to `accent`. */
  variant?: ToneVariant;
  /** Explanatory content. */
  children?: Child;
}

/** Explanatory aside with a semantic tone and optional title. */
export function Callout(props: CalloutProps): VNode {
  return h('ui:callout', props);
}

/** Default terminal animation frames used by {@link Spinner}. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Props accepted by {@link Spinner}. */
export interface SpinnerProps extends StyleProps, FlexChildProps, Props {
  /** Pin the animation to a deterministic frame when supplied. */
  tick?: number;
  /** Optional non-empty terminal frame set. */
  frames?: readonly string[];
}

/** Indeterminate activity indicator. */
export function Spinner(props: SpinnerProps = {}): VNode {
  return h('ui:spinner', props);
}

/** Props accepted by {@link ProgressBar}. */
export interface ProgressBarProps extends StyleProps, FlexChildProps, Props {
  /** Completion fraction; values outside 0..1 are clamped. */
  value: number;
  /** Terminal cell width; defaults to 20. */
  width?: number;
  showPercent?: boolean;
}

/** Horizontal completion bar with an optional percentage label. */
export function ProgressBar(props: ProgressBarProps): VNode {
  return h('ui:progress-bar', props);
}

/** One keyboard shortcut displayed by {@link KeyHint}. */
export interface KeyHintEntry {
  key: string;
  label: string;
}

/** Props accepted by {@link KeyHint}. */
export interface KeyHintProps extends StyleProps, FlexChildProps, Props {
  keys: readonly KeyHintEntry[];
  separator?: string;
}

/** Compact keyboard shortcut legend. */
export function KeyHint(props: KeyHintProps): VNode {
  return h('ui:key-hint', props);
}

/** Props accepted by {@link Tag}. */
export interface TagProps extends StyleProps, FlexChildProps, Props {
  label: string;
  onRemove?: () => void;
  color?: ToneVariant;
}

/** Tone-colored chip with an optional remove action. */
export function Tag(props: TagProps): VNode {
  return h('ui:tag', props);
}

/** Props accepted by {@link TagGroup}. */
export interface TagGroupProps extends StyleProps, FlexChildProps, Props {
  gap?: number;
  children?: Child;
}

/** Wrapping row of tags composed from the shared layout primitive. */
export function TagGroup(props: TagGroupProps): VNode {
  const { gap, children, ...rest } = props;
  return h(Box, { ...rest, direction: 'row', wrap: true, gap: gap ?? 1 } as Props, children);
}
