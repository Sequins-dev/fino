/**
 * internal:ui/components/primitives — the structural primitives every render
 * target implements.
 *
 * `box`, `text`, `layer`, `clickable`, `input`, `scrollview` (plus the
 * `spacer` and `rule` helpers) describe layout and nothing else. The semantic
 * catalog composes down to them, and every catalog module shares the prop
 * vocabulary declared here. Import `fino:ui/components` rather than this
 * module — the barrel re-exports the whole public surface.
 *
 * @internal
 */
import { h, type Child, type Props, type VNode } from 'fino:ui';
import type { Color, Style } from 'fino:tty/style';

export type { Color, Style };

export type Direction = 'row' | 'column';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Justify = 'start' | 'center' | 'end' | 'between';
export type WrapMode = 'none' | 'char' | 'word';
export type BorderStyle = 'single' | 'ascii' | 'heavy' | 'double';

/** Style props accepted by every primitive. */
export interface StyleProps {
  color?: Color;
  background?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
  /** Style token(s) merged left-to-right beneath the individual props above. */
  style?: Style | Style[];
  /** Hit-region id, reported by the render target for mouse routing. */
  id?: string;
}

/** Flex-child props accepted by every primitive. */
export interface FlexChildProps {
  grow?: number;
  shrink?: number;
  basis?: number;
  /** Shorthand for `grow`. */
  flex?: number;
  alignSelf?: Align;
  margin?: number;
  marginX?: number;
  marginY?: number;
}

/** Props accepted by `Box`. */
export interface BoxProps extends StyleProps, FlexChildProps, Props {
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  direction?: Direction;
  /** Wrap children onto new lines when the main axis overflows (row only). */
  wrap?: boolean;
  justify?: Justify;
  align?: Align;
  gap?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  border?: boolean | BorderStyle;
  borderStyle?: BorderStyle;
  /** Round the corners: `╭╮╰╯` for single (and `/\\` for ascii) borders in the
   * terminal, border-radius on the web. Composes with any line style. */
  rounded?: boolean;
  borderColor?: Color;
  /** Text drawn into the top border edge. */
  borderTitle?: string;
  overflow?: 'hidden' | 'visible';
  children?: Child;
}

/** Props accepted by `Text`. */
export interface TextProps extends StyleProps, FlexChildProps, Props {
  wrap?: boolean | WrapMode;
  align?: 'start' | 'center' | 'end';
  truncate?: boolean;
  /** Character offset of the caret within this node's text. */
  caret?: number;
  width?: number;
  height?: number;
  children?: Child;
}

/** Props accepted by `Spacer`. */
export interface SpacerProps extends FlexChildProps, Props {
  width?: number;
  height?: number;
}

/** Character range of an active text selection; `start < end` after clamping. */
export interface TextSelection {
  start: number;
  end: number;
}

/** Props accepted by `Input`. */
export interface InputProps extends StyleProps, FlexChildProps, Props {
  value?: string;
  placeholder?: string;
  focused?: boolean;
  caret?: number;
  /** Highlighted range, painted inverse by the terminal target. */
  selection?: TextSelection | null;
}

/** Props accepted by `Layer`. */
export interface LayerProps extends StyleProps, Props {
  /** Explicit cell position the layer attaches to. */
  anchor?: { x: number; y: number };
  /** Anchor beneath the painted rect of the node with this hit id. */
  anchorId?: string;
  placement?:
    | 'bottom-start'
    | 'bottom-center'
    | 'bottom-end'
    | 'top-start'
    | 'top-center'
    | 'top-end'
    | 'center';
  /** Place the layer inside the anchor's rect rather than beside it. */
  within?: boolean;
  /** Dim everything beneath the layer. */
  backdrop?: boolean;
  /** Skip the opaque backing fill, letting content beneath show through. */
  transparent?: boolean;
  width?: number;
  height?: number;
  children?: Child;
}

/** Key event delivered to component handlers by the render target. */
export interface UiKeyEvent {
  type: 'key';
  key: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Mouse event delivered to component handlers by the render target. */
export interface UiMouseEvent {
  type: 'mouse';
  action: 'press' | 'release' | 'drag' | 'move' | 'wheel';
  button: string;
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /**
   * `x`/`y` relative to the deepest hit node's own painted rect — the
   * terminal target sets this (from the same rect hit-testing already
   * resolves), so a control like `Slider` can compute click-to-position
   * without knowing its own screen offset. Absent on targets that have no
   * such concept, and absent when nothing was hit.
   */
  localX?: number;
  localY?: number;
}

/** Props accepted by `Clickable`. */
export interface ClickableProps extends StyleProps, FlexChildProps, Props {
  onClick?: () => void;
  onKey?: (event: UiKeyEvent) => boolean | void;
  onMouse?: (event: UiMouseEvent) => boolean | void;
  onFocus?: () => void;
  onBlur?: () => void;
  focusable?: boolean;
  /** Receive key events while nothing is focused — for overlay surfaces. */
  captureKeys?: boolean;
  disabled?: boolean;
  direction?: Direction;
  align?: Align;
  justify?: Justify;
  gap?: number;
  width?: number;
  height?: number;
  children?: Child;
}

/** Props accepted by `Scroll`. */
export interface ScrollProps extends StyleProps, FlexChildProps, Props {
  width?: number;
  height?: number;
  /** First content row shown at the top of the viewport. */
  offset?: number;
  children?: Child;
}

/** Props accepted by `Rule`. */
export interface RuleProps extends StyleProps, FlexChildProps, Props {
  /** Fill character, default `─`. */
  char?: string;
  /** Cells left undrawn at the right edge. */
  inset?: number;
}

/** Layout container with the flexbox model, padding, margins, and borders. */
export function Box(props: BoxProps): VNode {
  return h('box', props);
}
/** Styled text runs with wrapping, truncation, and caret reporting. */
export function Text(props: TextProps): VNode {
  return h('text', props);
}
/** Flexible or fixed empty space. */
export function Spacer(props: SpacerProps): VNode {
  return h('spacer', props);
}
/** Single-line editable text field. */
export function Input(props: InputProps): VNode {
  return h('input', props);
}
/** Content rendered above the normal flow, anchored or centered. */
export function Layer(props: LayerProps): VNode {
  return h('layer', props);
}
/**
 * Non-visual behavior container: lays out like a plain `Box`, and a click
 * anywhere within — or Enter/Space while focused — fires `onClick`.
 */
export function Clickable(props: ClickableProps): VNode {
  return h('clickable', props);
}
/** Scrollable viewport over child content. */
export function Scroll(props: ScrollProps): VNode {
  return h('scrollview', props);
}
/** Horizontal line filling its container. */
export function Rule(props: RuleProps = {}): VNode {
  return h('rule', props);
}
