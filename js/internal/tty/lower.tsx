/** @jsxImportSource fino:ui */
/**
 * internal:tty/lower — lower semantic `ui:*` nodes to terminal primitives.
 *
 * The component catalog (`fino:ui/components`) emits purely semantic nodes: a
 * checkbox is `ui:checkbox` carrying `checked`/`label`/`onChange`, with no
 * presentation attached. This module owns the terminal look: each semantic
 * node lowers to the box/text/clickable composition the layout engine paints
 * (`[x]`, `●`, `▸`, `[ label ]`, `──●`, …), forwarding handlers onto the
 * lowered `Clickable`s. `fino:tty/tui` runs `lowerTui()` over every tree
 * before layout and reconciliation, so the retained tree and the event
 * dispatcher only ever see primitives.
 */
import { h, defineRenderTarget, lowerTree, mapRenderTargetLowering } from 'fino:ui';
// Terminal lowerings that live beside their components, imported for their
// registration side effects.
import 'internal:ui/components/feedback.tui';
import 'internal:ui/components/navigation.tui';
import 'internal:ui/components/data.tui';
import 'internal:ui/components/virtual.tui';
import 'internal:ui/components/charts.tui';
import 'internal:ui/components/pickers.tui';
import 'internal:ui/components/overlay.tui';
import 'internal:ui/components/menu.tui';
import 'internal:ui/components/disclosure.tui';
import 'internal:ui/components/forms.tui';
import 'internal:ui/components/layout.tui';
import 'internal:ui/components/typography.tui';
import 'internal:ui/components/display.tui';
import 'internal:ui/components/icons.tui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { stringWidth } from 'fino:tty/frame';
import { highlightLines } from 'fino:format/typescript';
import { env } from 'fino:process';
import {
  Box,
  Calendar,
  Clickable,
  Expander,
  Input,
  Layer,
  MenuHeader,
  MenuList,
  MenuRow,
  MenuSeparator,
  Panel,
  Radio,
  Rule,
  TabList,
  Text,
  Toast,
  styles,
} from 'fino:ui/components';
// The rest of what a lowering needs is deliberately absent from the public
// barrel: pure helpers that exist so both render targets agree on the same
// answer (the same edit reducer, the same icon name, the same axis ticks)
// rather than API an application would call. They come from the catalog
// module that owns each one.
import { applyTextAreaEdit, applyTextEdit } from 'internal:ui/components/text-edit';
import { defaultComboBoxFilter } from 'internal:ui/components/menu';
import { iconForm } from 'internal:ui/components/icons';
import { fileIcon } from 'internal:ui/components/data';
import { paginationRange } from 'internal:ui/components/navigation';
import { niceScale, plotBraille, seriesColor } from 'internal:ui/components/charts';
import {
  formatClockTime,
  formatTimeParts,
  monthGrid,
  monthLabel,
  parseClockTime,
  parseHexColor,
  parseIsoMonth,
  shiftMonth,
  timeColumnWindow,
  weekdayLabels,
} from 'internal:ui/components/pickers';
import type { ClockParts } from 'internal:ui/components/pickers';
import type {
  BarChartProps,
  BlockquoteProps,
  BoldProps,
  BreadcrumbsProps,
  ButtonProps,
  CalendarProps,
  CardProps,
  CheckboxProps,
  CodeProps,
  ColorPickerProps,
  ComboBoxProps,
  ContextMenuProps,
  DatePickerProps,
  DetailsProps,
  DigitalClockProps,
  EmptyStateProps,
  ExpanderProps,
  FieldProps,
  FieldsetProps,
  FileTreeNode,
  FileTreeProps,
  FloatingActionBarProps,
  HeadingProps,
  HoverCardProps,
  IconButtonProps,
  IconProps,
  InlineCodeProps,
  ItalicProps,
  LineChartProps,
  LinkProps,
  ListProps,
  MenuItem,
  MenuListProps,
  MenuRowProps,
  ModalProps,
  NumberInputProps,
  PaginationProps,
  PanelProps,
  PopoverProps,
  RadioGroupProps,
  RadioProps,
  SelectProps,
  Series,
  SliderProps,
  StatProps,
  StatusDotProps,
  StatusDotStatus,
  StepsProps,
  SwitchProps,
  TabListProps,
  TableProps,
  TabsProps,
  TextAreaProps,
  TextInputProps,
  TimelineProps,
  TimePickerProps,
  ToastProps,
  ToastStackProps,
  TooltipProps,
  Trend,
  UiKeyEvent,
  UiMouseEvent,
  VirtualListProps,
} from 'fino:ui/components';
import type { Color, Style } from 'fino:tty/style';
import { nearestAnsi256, supportsTruecolor } from 'fino:tty/style';

type Composer = (props: Props, children: NormalizedChild[]) => VNode;










function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let out = value;
  if (max !== undefined) out = Math.min(out, max);
  if (min !== undefined) out = Math.max(out, min);
  return out;
}





































// `Link` is the one catalog component allowed to navigate. With `onActivate`
// it becomes a focusable Clickable, same as any other click-like control.
// Terminals get no clickable hyperlinks: OSC 8 cannot survive the frame
// pipeline (parseAnsi drops non-SGR escapes so segments stay free of control
// codes), and carrying links through Segment/Row is a frame-model change we
// chose not to make. An href-only link renders as styled, underlined text.

// Each child gets its own gutter row, so a quote built from several `Text`
// lines carries `│` beside every one of them — matching Markdown's `>` on
// every quoted line. A single child that word-wraps internally still only
// carries one gutter for that block: how many rows it wraps to is a
// layout-time decision made after this composer runs, and repeating the
// gutter per wrapped row would mean teaching the frame/cell layer about a
// tiling left border, which is out of scope for a component lowering.








// `Layer` has no notion of "this node's own enclosing container" — anchoring
// always means anchoring to a known hit id (the container must expose one
// via `anchorId`), and its placement model offers only start/end alignment
// relative to that anchor point, never centering. `top-start`/`top-end`
// (rather than `bottom-start`/`bottom-end`) land the bar just inside the
// anchor's bottom edge instead of pushed below it entirely — the closest
// approximation of "floating over the container's bottom" the engine
// currently supports. `'bottom-center'` has no anchored-center counterpart
// to fall back on, so it renders with the same left alignment as
// `'top-start'` here; the web target centers it for real with flexbox.






// Columns are click-selectable lists, as requested, and — since a component
// cannot hold "which column has arrow-key focus" as state of its own —
// Up/Down and Left/Right step the whole value directly (minutes and hours
// respectively) while the popover is open, the same directly-manipulated
// idiom `NumberInput`/`Slider` already use elsewhere in this catalog, rather
// than inventing per-column keyboard focus state that has nowhere to live.


// Truecolor detection (env.COLORTERM via fino:process) happens here, in the
// lowering — never inside the `ColorPicker` component function, which stays
// clock- and environment-free like every other catalog component. Terminals
// that don't report `truecolor`/`24bit` fall back to the nearest of the
// xterm 256-color palette (`nearestAnsi256`) for every swatch cell.

// Chart series colors resolve through the same truecolor-capability check
// ColorPicker's swatches use: `fino:tty/style`'s SGR codec would happily
// emit a raw 24-bit escape for an explicit `{ rgb }` series color even on a
// terminal that can't render it, so it's downgraded to the nearest
// xterm-256 index here — in the lowering, never inside the chart
// components, matching the "environment detection stays out of components"
// rule `colorPicker` already established.


/**
 * The node names the terminal paints itself.
 *
 * This is the target's floor: lowering stops here, and anything else reaching
 * it without a registered lowering is an error rather than a silently empty
 * box. `button` and `list` are the older `fino:tty/tui` primitives, still
 * handled by the layout engine.
 */
const TUI_PRIMITIVES = [
  'fragment',
  // Retained host text nodes, so lowering an already-mounted tree is a no-op
  // rather than an error.
  '#text',
  'box',
  'text',
  'spacer',
  'rule',
  'input',
  'button',
  'list',
  'clickable',
  'scrollview',
  'layer',
  'measured',
];

defineRenderTarget('tui', { primitives: TUI_PRIMITIVES });

/**
 * Lower a semantic tree to terminal primitives.
 *
 * Thin wrapper over `lowerTree(node, 'tui')`, kept because the terminal target
 * and its tests name this operation directly.
 */
export function lowerTui(node: VNode): VNode {
  return lowerTree(node, 'tui');
}
