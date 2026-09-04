/** Host-neutral tables, file trees, timelines, and reusable tree state. @internal */
import { createSignal, h } from 'fino:ui';
import type { Props, Signal, VNode } from 'fino:ui';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';
import type { StatusVariant } from 'internal:ui/components/overlay';

/** One column of a {@link Table}. */
export interface TableColumn {
  key: string;
  header: string;
  /** Explicit cell width; narrower terminal content truncates with an ellipsis. */
  width?: number;
  align?: 'start' | 'end';
}

/** Props accepted by {@link Table}. */
export interface TableProps extends StyleProps, FlexChildProps, Props {
  columns: readonly TableColumn[];
  rows: ReadonlyArray<Readonly<Record<string, string>>>;
  selectedIndex?: number;
  onSelectRow?: (index: number) => void;
}

/** Data table with optional controlled row selection. */
export function Table(props: TableProps): VNode {
  return h('ui:table', props);
}

/** One node of a {@link FileTree}; missing children marks a leaf. */
export interface FileTreeNode {
  key: string;
  label: string;
  icon?: string;
  children?: readonly FileTreeNode[];
}

/** One visible flattened tree row shared by render targets. */
export interface VisibleTreeRow {
  node: FileTreeNode;
  depth: number;
  directory: boolean;
  open: boolean;
}

/** Flatten only expanded tree branches into deterministic visible rows. */
export function visibleTreeRows(
  nodes: readonly FileTreeNode[],
  expanded: readonly string[],
): VisibleTreeRow[] {
  const openKeys = new Set(expanded);
  const rows: VisibleTreeRow[] = [];
  const visit = (entries: readonly FileTreeNode[], depth: number): void => {
    for (const node of entries) {
      const directory = node.children !== undefined;
      const open = directory && openKeys.has(node.key);
      rows.push({ node, depth, directory, open });
      if (open) visit(node.children ?? [], depth + 1);
    }
  };
  visit(nodes, 0);
  return rows;
}

/** Props accepted by {@link FileTree}. */
export interface FileTreeProps extends StyleProps, FlexChildProps, Props {
  nodes: readonly FileTreeNode[];
  expanded: readonly string[];
  selectedKey?: string | null;
  icons?: Readonly<Record<string, string>>;
  folderIcons?: { open: string; closed: string };
  onToggle?: (key: string) => void;
  onSelect?: (key: string) => void;
}

/** Built-in extension-to-icon-name table. */
export const FILE_ICONS: Readonly<Record<string, string>> = {
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

/** Resolve a file-tree node to a target-independent icon registry name. */
export function fileIcon(
  node: Pick<FileTreeNode, 'label' | 'icon' | 'children'>,
  icons?: Readonly<Record<string, string>>,
  open = false,
  folderIcons?: { open: string; closed: string },
): string {
  if (node.icon !== undefined) return node.icon;
  if (node.children !== undefined) {
    return open ? (folderIcons?.open ?? 'folder-open') : (folderIcons?.closed ?? 'folder');
  }
  const dot = node.label.lastIndexOf('.');
  const extension = dot > 0 ? node.label.slice(dot + 1).toLowerCase() : '';
  return icons?.[extension] ?? FILE_ICONS[extension] ?? 'file';
}

/** Expandable and selectable file hierarchy. */
export function FileTree(props: FileTreeProps): VNode {
  return h('ui:file-tree', props);
}

/** Reusable expansion and selection state for {@link FileTree}. */
export interface TreeState {
  readonly expanded: Signal<string[]>;
  readonly selectedKey: Signal<string | null>;
  toggle(key: string): void;
  select(key: string | null): void;
  isExpanded(key: string): boolean;
}

/** Create tree state outside component bodies so it survives target re-renders. */
export function createTreeState(
  defaultExpanded: readonly string[] = [],
  defaultSelected: string | null = null,
): TreeState {
  const expanded = createSignal([...new Set(defaultExpanded)]);
  const selectedKey = createSignal(defaultSelected);
  return {
    expanded,
    selectedKey,
    toggle(key): void {
      const current = expanded.get();
      expanded.set(
        current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
      );
    },
    select: (key) => selectedKey.set(key),
    isExpanded: (key) => expanded.get().includes(key),
  };
}

/** One entry of a {@link Timeline}. */
export interface TimelineEntry {
  key: string;
  title: string;
  detail?: string;
  variant?: StatusVariant;
}

/** Props accepted by {@link Timeline}. */
export interface TimelineProps extends StyleProps, FlexChildProps, Props {
  entries: readonly TimelineEntry[];
}

/** Vertical event list with status markers and optional details. */
export function Timeline(props: TimelineProps): VNode {
  return h('ui:timeline', props);
}
