/**
 * internal:ui/components/overlay — everything that floats above the normal
 * flow: modals, context menus, popovers, tooltips, toasts, hover cards, and
 * the floating action bar.
 *
 * @internal
 */
import { h, type Child, type Props, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  emptyNode,
  handlerOf,
  register,
  tone,
} from 'internal:ui/components/html-runtime';
import { menuUl } from 'internal:ui/components/menu';
import type { MenuItem } from 'internal:ui/components/menu';
import type { StatusVariant } from 'internal:ui/components/feedback';

function dismissButton(onDismiss: unknown): VNode | null {
  const dismiss = handlerOf<() => void>(onDismiss);
  if (!actionsActive() || dismiss === undefined) return null;
  const act = register(() => dismiss());
  return actionForm(
    {},
    h('button', { className: 'ui-dismiss', name: 'do', value: act, 'aria-label': 'Dismiss' }, '×'),
  );
}

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
export function Modal(all: ModalProps): VNode {
  const { children = [], ...props } = all as ModalProps & { children?: NormalizedChild[] };
  const { title, onDismiss } = props;
  return h(
    'div',
    { className: 'ui-overlay' },
    h(
      'div',
      { className: 'ui-modal', role: 'dialog', 'aria-modal': 'true' },
      dismissButton(onDismiss),
      title !== undefined ? h('header', { className: 'ui-modal-title' }, title) : null,
      ...children,
    ),
  );
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
export function ContextMenu(all: ContextMenuProps): VNode {
  const { children = [], ...props } = all as ContextMenuProps & { children?: NormalizedChild[] };
  const { items, selectedKey, onSelect, onDismiss, id } = props;
  return h(
    'div',
    { className: 'ui-context-menu' },
    dismissButton(onDismiss),
    menuUl(items, selectedKey, { id, onSelect }),
  );
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
export function Popover(all: PopoverProps): VNode {
  const { children = [], ...props } = all as PopoverProps & { children?: NormalizedChild[] };
  const { open, onDismiss } = props;
  if (open !== true) return emptyNode();
  return h(
    'div',
    { className: 'ui-popover' },
    dismissButton(onDismiss),
    ...children,
  );
}

/** Props accepted by `Tooltip`. */
export interface TooltipProps extends Props {
  text: string;
  /** Shown state — the app decides when; there is no hover tracking. */
  open: boolean;
  anchorId: string;
}
/** One-line hint anchored beneath a trigger. */
export function Tooltip(all: TooltipProps): VNode {
  const { children = [], ...props } = all as TooltipProps & { children?: NormalizedChild[] };
  const { text, open } = props;
  if (open !== true) return emptyNode();
  return h('span', { className: 'ui-tooltip', role: 'tooltip' }, text);
}

/** Props accepted by `Toast`. */
export interface ToastProps extends Props {
  message: string;
  variant?: StatusVariant;
}
/** One notification with a status variant. */
export function Toast(all: ToastProps): VNode {
  const { children = [], ...props } = all as ToastProps & { children?: NormalizedChild[] };
  const { message, variant } = props;
  return h('div', { className: `ui-toast ${tone(variant, 'info')}` }, message);
}

/** Props accepted by `ToastStack`. */
export interface ToastStackProps extends Props {
  toasts: Array<{ id: string; message: string; variant?: StatusVariant }>;
}
/** Notification column pinned to the top-right corner. */
export function ToastStack(all: ToastStackProps): VNode {
  const { children = [], ...props } = all as ToastStackProps & { children?: NormalizedChild[] };
  const { toasts } = props;
  if (toasts.length === 0) return emptyNode();
  return h(
    'div',
    { className: 'ui-toast-stack' },
    ...toasts.map((entry) =>
      h('div', { className: `ui-toast ${tone(entry.variant, 'info')}` }, entry.message),
    ),
  );
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
export function HoverCard(all: HoverCardProps): VNode {
  const { children = [], ...props } = all as HoverCardProps & { children?: NormalizedChild[] };
  const { open, title } = props;
  if (open !== true) return emptyNode();
  return h(
    'div',
    { className: 'ui-hover-card' },
    title !== undefined ? h('div', { className: 'ui-hover-card-title' }, title) : null,
    ...children,
  );
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
export function FloatingActionBar(all: FloatingActionBarProps): VNode {
  const { children = [], ...props } = all as FloatingActionBarProps & { children?: NormalizedChild[] };
  const { placement } = props;
  const align =
    placement === 'bottom-end'
      ? 'ui-fab-end'
      : placement === 'bottom-start'
        ? 'ui-fab-start'
        : 'ui-fab-center';
  return h('div', { className: `ui-fab ${align}` }, ...children);
}
