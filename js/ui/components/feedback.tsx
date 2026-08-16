/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/feedback — small status surfaces: badges, spinners,
 * progress bars, key hints, and tags.
 *
 * Each component renders native web markup directly; the terminal forms are
 * registered beside it in `feedback.tui.tsx`. `TagGroup` needs neither: it
 * composes a `Box`, and every target already knows how to lower that.
 *
 * @internal
 */
import { h, type Child, type NormalizedChild, type Props, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  handlerOf,
  idAttr,
  register,
  tone,
} from 'internal:ui/components/html-runtime';
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
  const { label, variant, id } = props;
  return h('span', { className: `ui-badge ${tone(variant, 'accent')}`, ...idAttr(id) }, label);
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
  return h('span', {
    className: 'ui-spinner',
    role: 'status',
    'aria-label': 'loading',
    ...idAttr(props.id),
  });
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
  const { value, showPercent, id } = props;
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return h(
    'span',
    { className: 'ui-progress-wrap', ...idAttr(id) },
    h('progress', { className: 'ui-progress', max: '100', value: String(percent) }),
    showPercent === true ? h('span', { className: 'ui-progress-percent' }, `${percent}%`) : null,
  );
}

/** Props accepted by `KeyHint`. */
export interface KeyHintProps extends FlexChildProps, Props {
  keys: Array<{ key: string; label: string }>;
  separator?: string;
  id?: string;
}
/** Key legend row: `y approve · n reject`. */
export function KeyHint(props: KeyHintProps): VNode {
  const { keys, separator, id } = props;
  const sep = separator ?? ' · ';
  const parts: NormalizedChild[] = [];
  keys.forEach((hint, index) => {
    if (index > 0) parts.push(h('span', { className: 'ui-keyhint-sep' }, sep));
    parts.push(h('kbd', null, hint.key));
    parts.push(` ${hint.label}`);
  });
  return h('span', { className: 'ui-keyhint', ...idAttr(id) }, ...parts);
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
  const { label, onRemove, color, id } = props;
  const remove = handlerOf<() => void>(onRemove);
  let remover: VNode | null = null;
  if (remove !== undefined && actionsActive()) {
    const act = register(() => remove());
    remover = actionForm(
      {},
      h(
        'button',
        { className: 'ui-tag-remove', name: 'do', value: act, 'aria-label': `Remove ${label}` },
        '×',
      ),
    );
  } else if (remove !== undefined) {
    remover = h(
      'button',
      { type: 'button', className: 'ui-tag-remove', 'aria-label': `Remove ${label}` },
      '×',
    );
  }
  return h('span', { className: `ui-tag ${tone(color, 'accent')}`, ...idAttr(id) }, label, remover);
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
