/** Host-neutral floating and overlay components. @internal */
import { h } from 'fino:ui';
import type { Child, Props, VNode } from 'fino:ui';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';
import type { MenuItem } from 'internal:ui/components/menu';

/** Semantic variants shared by notifications and status surfaces. */
export type StatusVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Props accepted by {@link Modal}. */
export interface ModalProps extends StyleProps, Props {
  title?: string;
  onDismiss?: () => void;
  width?: number;
  height?: number;
  children?: Child;
}

/** Centered dialog above a backdrop. */
export function Modal(props: ModalProps): VNode {
  return h('ui:modal', props);
}

/** Props accepted by {@link ContextMenu}. */
export interface ContextMenuProps extends StyleProps, Props {
  /** Position where the menu opens. */
  at: { x: number; y: number };
  items: readonly MenuItem[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  onDismiss?: () => void;
}

/** Positioned menu with outside-click and Escape dismissal. */
export function ContextMenu(props: ContextMenuProps): VNode {
  return h('ui:context-menu', props);
}

/** Props accepted by {@link Popover}. */
export interface PopoverProps extends StyleProps, FlexChildProps, Props {
  open: boolean;
  /** Stable trigger id used to anchor the surface. */
  anchorId: string;
  onDismiss?: () => void;
  children?: Child;
}

/** Interactive surface anchored beneath a trigger. */
export function Popover(props: PopoverProps): VNode {
  return h('ui:popover', props);
}

/** Props accepted by {@link Tooltip}. */
export interface TooltipProps extends StyleProps, Props {
  text: string;
  open: boolean;
  anchorId: string;
}

/** One-line anchored hint. */
export function Tooltip(props: TooltipProps): VNode {
  return h('ui:tooltip', props);
}

/** Props accepted by {@link Toast}. */
export interface ToastProps extends StyleProps, FlexChildProps, Props {
  message: string;
  variant?: StatusVariant;
}

/** One notification with a semantic status variant. */
export function Toast(props: ToastProps): VNode {
  return h('ui:toast', props);
}

/** One entry in a {@link ToastStack}. */
export interface ToastEntry {
  id: string;
  message: string;
  variant?: StatusVariant;
}

/** Props accepted by {@link ToastStack}. */
export interface ToastStackProps extends StyleProps, Props {
  toasts: readonly ToastEntry[];
}

/** Notification column pinned to the viewport edge. */
export function ToastStack(props: ToastStackProps): VNode {
  return h('ui:toast-stack', props);
}

/** Props accepted by {@link HoverCard}. */
export interface HoverCardProps extends StyleProps, FlexChildProps, Props {
  open: boolean;
  anchorId: string;
  title?: string;
  children?: Child;
}

/** Structured anchored content controlled by the caller. */
export function HoverCard(props: HoverCardProps): VNode {
  return h('ui:hover-card', props);
}

/** Props accepted by {@link FloatingActionBar}. */
export interface FloatingActionBarProps extends StyleProps, FlexChildProps, Props {
  /** Id of the container the bar floats within. */
  anchorId: string;
  placement?: 'bottom-start' | 'bottom-center' | 'bottom-end';
  children?: Child;
}

/** Action row floating at the bottom of an identified container. */
export function FloatingActionBar(props: FloatingActionBarProps): VNode {
  return h('ui:floating-action-bar', props);
}
