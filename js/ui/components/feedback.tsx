/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/feedback — small status surfaces: badges, spinners,
 * progress bars, key hints, and tags.
 *
 * @internal
 */
import { h, type Child, type Props, type VNode } from 'fino:ui';
import { Box } from 'internal:ui/components/primitives';
import type { FlexChildProps } from 'internal:ui/components/primitives';

/** Token color variants used by `Badge` and `Tag`. */
export type ToneVariant = 'accent' | 'muted' | 'danger' | 'success' | 'warning';
/** Semantic status variants used by `Toast` and `Timeline`. */
export type StatusVariant = 'info' | 'success' | 'danger' | 'warning';

/** Props accepted by `Badge`. */
export interface BadgeProps extends FlexChildProps, Props {
  label: string;
  variant?: ToneVariant;
  id?: string;
}
/** Small inline status label in a tone color. */
export function Badge(props: BadgeProps): VNode {
  return h('ui:badge', props);
}

/** Frame set cycled by `Spinner` in the terminal target. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Props accepted by `Spinner`. */
export interface SpinnerProps extends FlexChildProps, Props {
  /** Optional fixed frame index; omitted, the render target animates. */
  tick?: number;
  frames?: string[];
  id?: string;
}
/** Indeterminate activity indicator. */
export function Spinner(props: SpinnerProps): VNode {
  return h('ui:spinner', props);
}

/** Props accepted by `ProgressBar`. */
export interface ProgressBarProps extends FlexChildProps, Props {
  /** Completion fraction, 0..1. */
  value: number;
  width?: number;
  showPercent?: boolean;
  id?: string;
}
/** Horizontal completion bar, optionally labeled with a percent. */
export function ProgressBar(props: ProgressBarProps): VNode {
  return h('ui:progress', props);
}

/** Props accepted by `KeyHint`. */
export interface KeyHintProps extends FlexChildProps, Props {
  keys: Array<{ key: string; label: string }>;
  separator?: string;
  id?: string;
}
/** Key legend row: `y approve · n reject`. */
export function KeyHint(props: KeyHintProps): VNode {
  return h('ui:key-hint', props);
}

/** Props accepted by `Tag`. */
export interface TagProps extends FlexChildProps, Props {
  label: string;
  onRemove?: () => void;
  color?: ToneVariant;
  id?: string;
}
/** Chip in a tone color, with an optional remover. */
export function Tag(props: TagProps): VNode {
  return h('ui:tag', props);
}

/** Props accepted by `TagGroup`. */
export interface TagGroupProps extends FlexChildProps, Props {
  gap?: number;
  id?: string;
  children?: Child;
}
/** Wrapping row of tags. */
export function TagGroup(props: TagGroupProps): VNode {
  const { gap, children, ...rest } = props;
  return (
    <Box direction="row" wrap gap={gap ?? 1} {...rest}>
      {children}
    </Box>
  );
}
