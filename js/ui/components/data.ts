/**
 * internal:ui/components/data — components that render a data structure:
 * tables, file trees, and timelines.
 *
 * @internal
 */
import { h, createSignal, type Props, type Signal, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  handlerOf,
  register,
  tone,
} from 'internal:ui/components/html-runtime';
import { iconForm } from 'internal:ui/components/icons';
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
export function Table(all: TableProps): VNode {
  const { children = [], ...props } = all as TableProps & { children?: NormalizedChild[] };
  const { columns, rows, selectedIndex, onSelectRow } = props;
  const select = handlerOf<(index: number) => void>(onSelectRow);
  const interactive = actionsActive() && select !== undefined;
  const cellStyle = (align: 'start' | 'end' | undefined): Props =>
    align === 'end' ? { style: { textAlign: 'right' } } : {};
  const table = h(
    'table',
    { className: 'ui-table', ...idAttr(props.id) },
    h(
      'thead',
      null,
      h('tr', null, ...columns.map((column) => h('th', cellStyle(column.align), column.header))),
    ),
    h(
      'tbody',
      null,
      ...rows.map((row, index) => {
        // Every cell of a row shares one action id: a <tr> cannot be a
        // button, so each cell's content is a full-width submit button.
        const act = interactive ? register(() => select!(index)) : null;
        return h(
          'tr',
          index === selectedIndex ? { className: 'is-selected' } : {},
          ...columns.map((column) => {
            const text = row[column.key] ?? '';
            return h(
              'td',
              cellStyle(column.align),
              act !== null
                ? h('button', { className: 'ui-row-select', name: 'do', value: act }, text)
                : text,
            );
          }),
        );
      }),
    ),
  );
  return interactive ? actionForm({}, table) : table;
}

interface TreeContext {
  icons?: Record<string, string>;
  folderIcons?: { open: string; closed: string };
  toggle?: (key: string) => void;
  select?: (key: string) => void;
}

function treeNodesHtml(
  nodes: FileTreeNode[],
  expanded: string[],
  selectedKey: string | null | undefined,
  ctx: TreeContext,
): VNode[] {
  return nodes.map((entry) => {
    const selected = entry.key === selectedKey;
    const dir = entry.children !== undefined;
    const open = dir && expanded.includes(entry.key);
    const glyph = iconForm(fileIcon(entry, ctx.icons, open, ctx.folderIcons), 'html');
    if (dir) {
      const attrs: Props = { className: 'ui-tree-dir' };
      if (open) attrs.open = true;
      // The icon IS the expander: it toggles, the name selects. With no
      // select handler the name toggles too, so the whole row expands.
      // Registered in visual order so ids follow the markup.
      const toggleId =
        actionsActive() && ctx.toggle !== undefined ? register(() => ctx.toggle!(entry.key)) : null;
      const selectId =
        actionsActive() && ctx.select !== undefined ? register(() => ctx.select!(entry.key)) : null;
      const children = h(
        'div',
        { className: 'ui-tree-children' },
        ...treeNodesHtml(entry.children!, expanded, selectedKey, ctx),
      );
      const icon =
        toggleId !== null
          ? h(
              'button',
              {
                className: 'ui-tree-icon',
                name: 'do',
                value: toggleId,
                'aria-label': open ? 'Collapse' : 'Expand',
              },
              glyph,
            )
          : h('span', { className: 'ui-tree-icon' }, glyph);
      const nameAct = selectId ?? toggleId;
      const name =
        nameAct !== null
          ? h('button', { className: 'ui-tree-name', name: 'do', value: nameAct }, entry.label)
          : h('span', { className: 'ui-tree-name' }, entry.label);
      return h(
        'details',
        attrs,
        h('summary', { className: `ui-tree-row${selected ? ' is-selected' : ''}` }, icon, name),
        children,
      );
    }
    const content = [
      h('span', { className: 'ui-tree-icon' }, glyph),
      h('span', { className: 'ui-tree-name' }, entry.label),
    ];
    if (actionsActive() && ctx.select !== undefined) {
      const act = register(() => ctx.select!(entry.key));
      return h(
        'button',
        {
          className: `ui-tree-leaf ui-tree-row${selected ? ' is-selected' : ''}`,
          name: 'do',
          value: act,
        },
        ...content,
      );
    }
    return h(
      'div',
      { className: `ui-tree-leaf ui-tree-row${selected ? ' is-selected' : ''}` },
      ...content,
    );
  });
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
export function FileTree(all: FileTreeProps): VNode {
  const { children = [], ...props } = all as FileTreeProps & { children?: NormalizedChild[] };
  const { nodes, expanded, selectedKey, icons, folderIcons, onToggle, onSelect, id } = props;
  const toggle = handlerOf<(key: string) => void>(onToggle);
  const select = handlerOf<(key: string) => void>(onSelect);
  const ctx: TreeContext = { icons, folderIcons, toggle, select };
  const tree = h(
    'div',
    { className: 'ui-tree', ...idAttr(id) },
    ...treeNodesHtml(nodes, expanded ?? [], selectedKey, ctx),
  );
  return actionsActive() && (toggle !== undefined || select !== undefined)
    ? actionForm({}, tree)
    : tree;
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
export function Timeline(all: TimelineProps): VNode {
  const { children = [], ...props } = all as TimelineProps & { children?: NormalizedChild[] };
  const { entries, id } = props;
  return h(
    'ol',
    { className: 'ui-timeline', ...idAttr(id) },
    ...entries.map((entry) =>
      h(
        'li',
        { className: tone(entry.variant, 'info') },
        h('span', { className: 'ui-timeline-title' }, entry.title),
        entry.detail !== undefined
          ? h('span', { className: 'ui-timeline-detail' }, entry.detail)
          : null,
      ),
    ),
  );
}
