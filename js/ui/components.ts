/**
 * fino:ui/components — host-neutral UI component primitives.
 *
 * This public barrel grows by reviewable component families. The foundation
 * contains only structural primitives and semantic style tokens; later
 * families compose these same contracts for both HTML and terminal targets.
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import { Box, Rule, Text, styles } from 'fino:ui/components';
 *
 * const view = (
 *   <Box border padding={1} gap={1}>
 *     <Text style={[styles.bold, styles.accent]}>Status</Text>
 *     <Rule />
 *     <Text>ready</Text>
 *   </Box>
 * );
 * ```
 */
import { h } from 'fino:ui';
import type { Child, Props, VNode } from 'fino:ui';
import type { Color, Style } from 'fino:tty/style';

export { styles } from 'fino:ui/components/theme';
export type { Color, Style };
export type { StyleToken } from 'fino:ui/components/theme';

/** Main-axis direction for flex containers. */
export type Direction = 'row' | 'column';
/** Cross-axis alignment for flex containers and children. */
export type Align = 'start' | 'center' | 'end' | 'stretch';
/** Main-axis distribution for flex containers. */
export type Justify = 'start' | 'center' | 'end' | 'between';
/** Text wrapping policy. */
export type WrapMode = 'none' | 'char' | 'word';
/** Glyph family used for terminal borders. */
export type BorderStyle = 'single' | 'ascii' | 'round' | 'heavy' | 'double';

/** Style props accepted by structural primitives. */
export interface StyleProps {
  /** Foreground color. */
  color?: Color;
  /** Background color. */
  background?: Color;
  /** Whether to render bold text. */
  bold?: boolean;
  /** Whether to render dim text. */
  dim?: boolean;
  /** Whether to render italic text. */
  italic?: boolean;
  /** Whether to underline text. */
  underline?: boolean;
  /** Whether to swap foreground and background colors. */
  inverse?: boolean;
  /** Whether to strike through text. */
  strike?: boolean;
  /** Style values merged left-to-right beneath individual style props. */
  style?: Style | Style[];
  /** Stable identity used for focus, hit testing, and layer anchoring. */
  id?: string;
}

/** Flex-child props accepted by structural primitives. */
export interface FlexChildProps {
  /** Relative share of unused main-axis space. */
  grow?: number;
  /** Relative share of main-axis overflow to remove. */
  shrink?: number;
  /** Preferred main-axis size before growing or shrinking. */
  basis?: number;
  /** Shorthand for `grow`. */
  flex?: number;
  /** Per-child override for the container's cross-axis alignment. */
  alignSelf?: Align;
  /** Margin on every edge. */
  margin?: number;
  /** Horizontal margin overriding `margin`. */
  marginX?: number;
  /** Vertical margin overriding `margin`. */
  marginY?: number;
}

/** Width and height props shared by sized primitives. */
export interface SizeProps {
  /** Width in terminal cells or target-relative units. */
  width?: number;
  /** Height in terminal rows or target-relative units. */
  height?: number;
}

/** Minimum and maximum bounds for resizable primitives. */
export interface ConstrainedSizeProps extends SizeProps {
  /** Minimum width. */
  minWidth?: number;
  /** Maximum width. */
  maxWidth?: number;
  /** Minimum height. */
  minHeight?: number;
  /** Maximum height. */
  maxHeight?: number;
}

/** Flex-container props shared by structural and interactive containers. */
export interface FlexLayoutProps {
  /** Main-axis direction; defaults to `column`. */
  direction?: Direction;
  /** Distribution of children along the main axis. */
  justify?: Justify;
  /** Alignment of children along the cross axis. */
  align?: Align;
  /** Space between adjacent children. */
  gap?: number;
}

/** Props accepted by {@link Box}. */
export interface BoxProps
  extends StyleProps, FlexChildProps, ConstrainedSizeProps, FlexLayoutProps, Props {
  /** Whether row children may continue on another line. */
  wrap?: boolean;
  /** Padding on every edge. */
  padding?: number;
  /** Horizontal padding overriding `padding`. */
  paddingX?: number;
  /** Vertical padding overriding `padding`. */
  paddingY?: number;
  /** Whether and how to draw a border. */
  border?: boolean | BorderStyle;
  /** Border glyph family used when `border` is `true`. */
  borderStyle?: BorderStyle;
  /** Border color. */
  borderColor?: Color;
  /** Whether content outside the box is clipped. */
  overflow?: 'hidden' | 'visible';
  /** Content laid out inside the box. */
  children?: Child;
}

/** Props accepted by {@link Text}. */
export interface TextProps extends StyleProps, FlexChildProps, SizeProps, Props {
  /** Whether and where text may wrap. */
  wrap?: boolean | WrapMode;
  /** Horizontal text alignment within the assigned width. */
  align?: 'start' | 'center' | 'end';
  /** Whether clipped text ends with an ellipsis. */
  truncate?: boolean;
  /** Character offset whose rendered cell should be reported. */
  caret?: number;
  /** Text content. */
  children?: Child;
}

/** Props accepted by {@link Spacer}. */
export interface SpacerProps extends FlexChildProps, SizeProps, Props {}

/** Character range of an active text selection. */
export interface TextSelection {
  /** Inclusive character offset where the selection begins. */
  start: number;
  /** Exclusive character offset where the selection ends. */
  end: number;
}

/** Props accepted by {@link Input}. */
export interface InputProps extends StyleProps, FlexChildProps, Props {
  /** Controlled text value. */
  value?: string;
  /** Text shown when `value` is empty. */
  placeholder?: string;
  /** Whether the input displays focus state. */
  focused?: boolean;
  /** Character offset of the caret. */
  caret?: number;
  /** Active selection, or `null` when no range is selected. */
  selection?: TextSelection | null;
}

/** Props accepted by {@link Layer}. */
export interface LayerProps extends StyleProps, SizeProps, Props {
  /** Absolute target coordinate used as the placement origin. */
  anchor?: { x: number; y: number };
  /** Placement relative to `anchor`, or the target when no anchor is set. */
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'center';
  /** Content painted above ordinary flow. */
  children?: Child;
}

/** Key event delivered to component handlers. */
export interface UiKeyEvent {
  /** Event discriminator. */
  type: 'key';
  /** Normalized key name. */
  key: string;
  /** Printable text associated with the key. */
  text?: string;
  /** Whether Control was held. */
  ctrl?: boolean;
  /** Whether Alt was held. */
  alt?: boolean;
  /** Whether Shift was held. */
  shift?: boolean;
}

/** Mouse event delivered to component handlers. */
export interface UiMouseEvent {
  /** Event discriminator. */
  type: 'mouse';
  /** Pointer action. */
  action: 'press' | 'release' | 'drag' | 'move' | 'wheel';
  /** Normalized pointer button. */
  button: 'left' | 'middle' | 'right' | 'none' | 'wheel-up' | 'wheel-down';
  /** Target-relative column. */
  x: number;
  /** Target-relative row. */
  y: number;
  /** Whether Control was held. */
  ctrl: boolean;
  /** Whether Alt was held. */
  alt: boolean;
  /** Whether Shift was held. */
  shift: boolean;
  /** Column relative to the deepest hit node. */
  localX?: number;
  /** Row relative to the deepest hit node. */
  localY?: number;
}

/** Props accepted by {@link Clickable}. */
export interface ClickableProps
  extends StyleProps, FlexChildProps, SizeProps, FlexLayoutProps, Props {
  /** Called after an eligible pointer or keyboard activation. */
  onClick?: () => void;
  /** Called for keys routed to this node. */
  onKey?: (event: UiKeyEvent) => boolean | void;
  /** Called for pointer events routed to this node. */
  onMouse?: (event: UiMouseEvent) => boolean | void;
  /** Called when this node receives focus. */
  onFocus?: () => void;
  /** Called when this node loses focus. */
  onBlur?: () => void;
  /** Whether this node participates in focus traversal. */
  focusable?: boolean;
  /** Whether this node receives keys without focus. */
  captureKeys?: boolean;
  /** Whether activation and focus are disabled. */
  disabled?: boolean;
  /** Interactive content. */
  children?: Child;
}

/** Props accepted by {@link Scroll}. */
export interface ScrollProps extends StyleProps, FlexChildProps, SizeProps, Props {
  /** First child row visible in the viewport. */
  offset?: number;
  /** Content clipped to the viewport. */
  children?: Child;
}

/** Props accepted by {@link Rule}. */
export interface RuleProps extends StyleProps, FlexChildProps, Props {
  /** Fill character; defaults to `─`. */
  char?: string;
  /** Cells left undrawn at the right edge. */
  inset?: number;
}

/** Flex layout container. */
export function Box(props: BoxProps): VNode {
  return h('box', props);
}

/** Styled text with wrapping and caret reporting. */
export function Text(props: TextProps): VNode {
  return h('text', props);
}

/** Flexible or fixed empty space. */
export function Spacer(props: SpacerProps): VNode {
  return h('spacer', props);
}

/** Single-line input primitive. */
export function Input(props: InputProps): VNode {
  return h('input', props);
}

/** Out-of-flow content layer. */
export function Layer(props: LayerProps): VNode {
  return h('layer', props);
}

/** Focusable, non-visual interaction container. */
export function Clickable(props: ClickableProps): VNode {
  return h('clickable', props);
}

/** Clipped viewport over child content. */
export function Scroll(props: ScrollProps): VNode {
  return h('scrollview', props);
}

/** Horizontal rule filling its assigned width. */
export function Rule(props: RuleProps = {}): VNode {
  return h('rule', props);
}
