/**
 * internal:ui/components/data — components that render a data structure:
 * tables, file trees, and timelines.
 *
 * @internal
 */
import { h, createSignal, type Props, type Signal, type VNode } from 'fino:ui';
import type { FlexChildProps } from 'internal:ui/components/primitives';
import type { StatusVariant } from 'internal:ui/components/feedback';

/** One column of a `Table`. */
export interface TableColumn {
  key: string;
  header: string;
  /** Explicit cell width; narrower content truncates with `…`. */
  width?: number;
  align?: 'start' | 'end';
}
/** Props accepted by `Table`. */
export interface TableProps extends FlexChildProps, Props {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  selectedIndex?: number;
  onSelectRow?: (index: number) => void;
  id?: string;
}
/** Data table: a header row over data rows, with selectable rows. */
export function Table(props: TableProps): VNode {
  return h('ui:table', props);
}

/** One node of a `FileTree`; `children` left undefined marks a leaf. */
export interface FileTreeNode {
  key: string;
  label: string;
  /** Explicit registry icon name; wins over every extension table. */
  icon?: string;
  children?: FileTreeNode[];
}
/** Props accepted by `FileTree`. */
export interface FileTreeProps extends FlexChildProps, Props {
  nodes: FileTreeNode[];
  expanded: string[];
  selectedKey?: string | null;
  /** Extension → registry icon name (no dot, lowercased), layered over `FILE_ICONS`. */
  icons?: Record<string, string>;
  /** Directory icon names; the icon doubles as the expander. */
  folderIcons?: { open: string; closed: string };
  onToggle?: (key: string) => void;
  onSelect?: (key: string) => void;
  id?: string;
}

/** Built-in extension → icon-name table consulted by `fileIcon` after the user table. */
export const FILE_ICONS: Record<string, string> = {
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  md: 'doc',
  json: 'config',
  yaml: 'config',
  yml: 'config',
  toml: 'config',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  lock: 'lock',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
};

/**
 * Resolve a tree node's icon name: an explicit `icon` wins, directories get
 * the folder icons (open variant when `open`), then the file extension maps
 * through the user table and `FILE_ICONS`; anything else is `file`. The
 * result is a registry name — pass it through `iconForm` for a target form.
 */
export function fileIcon(
  node: { label: string; icon?: string; children?: unknown },
  icons?: Record<string, string>,
  open = false,
  folderIcons?: { open: string; closed: string },
): string {
  if (node.icon !== undefined) return node.icon;
  if (node.children !== undefined) {
    return open ? (folderIcons?.open ?? 'folder-open') : (folderIcons?.closed ?? 'folder');
  }
  const dot = node.label.lastIndexOf('.');
  const ext = dot > 0 ? node.label.slice(dot + 1).toLowerCase() : '';
  return icons?.[ext] ?? FILE_ICONS[ext] ?? 'file';
}
/**
 * Tree of expandable directories and selectable rows. Expanding never also
 * selects: the toggle affordance is distinct from the row.
 */
export function FileTree(props: FileTreeProps): VNode {
  return h('ui:file-tree', props);
}

/** Tree expansion state helper for `FileTree`. */
export interface TreeState {
  readonly expanded: Signal<string[]>;
  toggle(key: string): void;
  isExpanded(key: string): boolean;
}
/** Create tree expansion state that survives re-renders. */
export function createTreeState(defaultExpanded: string[] = []): TreeState {
  const expanded = createSignal<string[]>(defaultExpanded);
  return {
    expanded,
    toggle(key: string): void {
      const current = expanded.get();
      expanded.set(
        current.includes(key) ? current.filter((open) => open !== key) : [...current, key],
      );
    },
    isExpanded: (key: string) => expanded.get().includes(key),
  };
}

/** One entry of a `Timeline`. */
export interface TimelineEntry {
  key: string;
  title: string;
  detail?: string;
  variant?: StatusVariant;
}
/** Props accepted by `Timeline`. */
export interface TimelineProps extends FlexChildProps, Props {
  entries: TimelineEntry[];
  id?: string;
}
/** Vertical event list with status-colored markers and details. */
export function Timeline(props: TimelineProps): VNode {
  return h('ui:timeline', props);
}
