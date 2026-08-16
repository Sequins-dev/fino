/**
 * internal:ui/components/overlay — everything that floats above the normal
 * flow: modals, context menus, popovers, tooltips, toasts, hover cards, and
 * the floating action bar.
 *
 * @internal
 */
import { h, type Child, type Props, type VNode } from 'fino:ui';
import type { MenuItem } from 'internal:ui/components/menu';
import type { StatusVariant } from 'internal:ui/components/feedback';

/** Props accepted by `Modal`. */
export interface ModalProps extends Props {
  title?: string;
  onDismiss?: () => void;
  width?: number;
  height?: number;
  children?: Child;
}
/**
 * Centered dialog above a dimmed backdrop. Esc — from anywhere, the modal
 * root consumes it — and clicks outside both dismiss.
 */
export function Modal(props: ModalProps): VNode {
  return h('ui:modal', props);
}

/** Props accepted by `ContextMenu`. */
export interface ContextMenuProps extends Props {
  /** Cell position the menu opens at — typically the click position. */
  at: { x: number; y: number };
  items: readonly MenuItem[];
  selectedKey?: string | null;
  onSelect: (key: string) => void;
  onDismiss: () => void;
  id?: string;
}
/**
 * Menu overlaying the content at a position. A full-screen catch layer
 * beneath it dismisses on any outside click.
 */
export function ContextMenu(props: ContextMenuProps): VNode {
  return h('ui:context-menu', props);
}

/** Props accepted by `Popover`. */
export interface PopoverProps extends Props {
  open: boolean;
  /** Hit id of the trigger the popover anchors beneath. */
  anchorId: string;
  onDismiss?: () => void;
  children?: Child;
}
/** Overlay anchored beneath a trigger. Esc dismisses; no backdrop. */
export function Popover(props: PopoverProps): VNode {
  return h('ui:popover', props);
}

/** Props accepted by `Tooltip`. */
export interface TooltipProps extends Props {
  text: string;
  /** Shown state — the app decides when; there is no hover tracking. */
  open: boolean;
  anchorId: string;
}
/** One-line hint anchored beneath a trigger. */
export function Tooltip(props: TooltipProps): VNode {
  return h('ui:tooltip', props);
}

/** Props accepted by `Toast`. */
export interface ToastProps extends Props {
  message: string;
  variant?: StatusVariant;
}
/** One notification with a status variant. */
export function Toast(props: ToastProps): VNode {
  return h('ui:toast', props);
}

/** Props accepted by `ToastStack`. */
export interface ToastStackProps extends Props {
  toasts: Array<{ id: string; message: string; variant?: StatusVariant }>;
}
/** Notification column pinned to the top-right corner. */
export function ToastStack(props: ToastStackProps): VNode {
  return h('ui:toast-stack', props);
}

/** Props accepted by `HoverCard`. */
export interface HoverCardProps extends Props {
  /** Shown state — the app decides when, like `Tooltip`; there is no hover tracking. */
  open: boolean;
  /** Hit id of the trigger the card anchors beneath. */
  anchorId: string;
  title?: string;
  children?: Child;
}
/**
 * Structured floating card anchored beneath a trigger, built on the same
 * `Layer`/`anchorId` mechanism as `Tooltip` and `Popover`. The three overlays
 * differ in what they carry and how they leave: `Tooltip` is a one-line text
 * hint, `HoverCard` is structured content (a `title` plus arbitrary
 * `children`) with no dismissal of its own — the app drives `open` exactly
 * like `Tooltip` — and `Popover` is interactive content with `onDismiss`
 * wired to Esc and outside clicks.
 */
export function HoverCard(props: HoverCardProps): VNode {
  return h('ui:hover-card', props);
}

/** Props accepted by `FloatingActionBar`. */
export interface FloatingActionBarProps extends Props {
  /**
   * Hit id of the container the bar floats within. `Layer` — the terminal's
   * only overlay primitive — has no notion of "this component's own
   * enclosing container": anchoring always means anchoring to a known hit
   * id, the same mechanism `Popover` and `Tooltip` use for their trigger. Give
   * the container itself an `id` and pass it here.
   */
  anchorId: string;
  placement?: 'bottom-start' | 'bottom-center' | 'bottom-end';
  children?: Child;
}
/**
 * Action bar floating at the bottom of its container (not the viewport) —
 * for affordances like "jump to latest". `Layer`'s placement model has no
 * anchored-center option (only start/end alignment relative to an anchor),
 * so in the terminal `'bottom-center'` renders left-aligned, same as
 * `'bottom-end'` minus the right offset — see `internal:tty/lower`'s
 * `floatingActionBar` composer for the documented gap. The web target
 * centers it for real with flexbox.
 */
export function FloatingActionBar(props: FloatingActionBarProps): VNode {
  return h('ui:floating-action-bar', props);
}
