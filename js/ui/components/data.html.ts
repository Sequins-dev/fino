/** HTML lowerings and styles for data components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { componentStyleAttrs, controlledNativeValue } from 'internal:ui/components/html-runtime';
import { FileTree, Table, Timeline, fileIcon, visibleTreeRows } from 'internal:ui/components/data';
import type { FileTreeProps, TableColumn } from 'internal:ui/components/data';
import { iconForm } from 'internal:ui/components/icons';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

function cellAttrs(column: TableColumn): Props {
  const attrs: Props = {};
  if (column.align === 'end') attrs.style = { textAlign: 'right' };
  if (column.width !== undefined) {
    attrs.style = {
      ...(attrs.style as Record<string, string> | undefined),
      width: `${column.width}ch`,
    };
  }
  return attrs;
}

mapComponentLowering(Table, 'html', (props) => {
  const { columns, rows, selectedIndex, onSelectRow } = props;
  const select =
    onSelectRow === undefined
      ? undefined
      : (raw?: string): void => {
          const index = Number(raw);
          if (Number.isInteger(index) && index >= 0 && index < rows.length) onSelectRow(index);
        };
  return controlledNativeValue(select, (actionAttrs) =>
    h(
      'table',
      componentStyleAttrs(props as Props, 'ui-table'),
      h(
        'thead',
        null,
        h('tr', null, ...columns.map((column) => h('th', cellAttrs(column), column.header))),
      ),
      h(
        'tbody',
        null,
        ...rows.map((row, index) =>
          h(
            'tr',
            { className: index === selectedIndex ? 'is-selected' : undefined },
            ...columns.map((column) => {
              const value = row[column.key] ?? '';
              return h(
                'td',
                cellAttrs(column),
                onSelectRow === undefined
                  ? value
                  : h(
                      'button',
                      {
                        ...actionAttrs,
                        type: actionAttrs.name === undefined ? 'button' : undefined,
                        value: String(index),
                        className: 'ui-row-select',
                      },
                      value,
                    ),
              );
            }),
          ),
        ),
      ),
    ),
  );
});

function treeAction(props: FileTreeProps): ((raw?: string) => void) | undefined {
  if (props.onToggle === undefined && props.onSelect === undefined) return undefined;
  const rows = new Map(
    visibleTreeRows(props.nodes, props.expanded).map((row) => [row.node.key, row]),
  );
  return (raw): void => {
    if (raw === undefined) return;
    const split = raw.indexOf(':');
    if (split === -1) return;
    const action = raw.slice(0, split);
    const key = raw.slice(split + 1);
    const row = rows.get(key);
    if (row === undefined) return;
    if (action === 'toggle' && row.directory) props.onToggle?.(key);
    else if (action === 'select') props.onSelect?.(key);
  };
}

mapComponentLowering(FileTree, 'html', (props) => {
  const rows = visibleTreeRows(props.nodes, props.expanded);
  return controlledNativeValue(treeAction(props as FileTreeProps), (attrs) =>
    h(
      'div',
      { ...componentStyleAttrs(props as Props, 'ui-tree'), role: 'tree' },
      ...rows.map((row) => {
        const { node, depth, directory, open } = row;
        const selected = node.key === props.selectedKey;
        const rowAttrs: Props = {
          className: `ui-tree-row${selected ? ' is-selected' : ''}`,
          role: 'treeitem',
          'aria-level': String(depth + 1),
          'aria-selected': selected ? 'true' : 'false',
          style: { paddingLeft: `${depth * 2}ch` },
        };
        if (directory) rowAttrs['aria-expanded'] = open ? 'true' : 'false';
        const control = (action: 'toggle' | 'select', label: string, className: string): VNode =>
          h(
            'button',
            {
              ...attrs,
              type: attrs.name === undefined ? 'button' : undefined,
              value: `${action}:${node.key}`,
              className,
            },
            label,
          );
        const glyph = iconForm(fileIcon(node, props.icons, open, props.folderIcons), 'html');
        const icon =
          directory && props.onToggle !== undefined
            ? control('toggle', glyph, 'ui-tree-icon')
            : h('span', { className: 'ui-tree-icon', 'aria-hidden': 'true' }, glyph);
        const nameAction = props.onSelect !== undefined ? 'select' : directory ? 'toggle' : null;
        const name =
          nameAction === null
            ? h('span', { className: 'ui-tree-name' }, node.label)
            : control(nameAction, node.label, 'ui-tree-name');
        return h('div', { key: node.key, ...rowAttrs }, icon, name);
      }),
    ),
  );
});

mapComponentLowering(Timeline, 'html', (props) =>
  h(
    'ol',
    componentStyleAttrs(props as Props, 'ui-timeline'),
    ...props.entries.map((entry) =>
      h(
        'li',
        { key: entry.key, className: `is-${entry.variant ?? 'info'}` },
        h('span', { className: 'ui-timeline-title' }, entry.title),
        entry.detail === undefined
          ? null
          : h('span', { className: 'ui-timeline-detail' }, entry.detail),
      ),
    ),
  ),
);

registerHtmlCss(`
.ui-table { width: 100%; border-collapse: collapse; }
.ui-table th, .ui-table td { padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--ui-border); text-align: left; }
.ui-table th { color: var(--tui-bright-black); font-weight: 700; }
.ui-table tr.is-selected { background: var(--ui-selected); }
.ui-row-select { width: 100%; border: 0; padding: 0; background: transparent; color: inherit; text-align: inherit; cursor: pointer; }
.ui-tree { display: flex; flex-direction: column; }
.ui-tree-row { display: flex; align-items: center; min-height: 1.8rem; }
.ui-tree-row.is-selected { background: var(--ui-selected); }
.ui-tree-icon, .ui-tree-name { border: 0; padding: 0.2rem; background: transparent; color: inherit; text-align: left; cursor: default; }
button.ui-tree-icon, button.ui-tree-name { cursor: pointer; }
.ui-tree-icon { width: 2rem; flex: 0 0 auto; }
.ui-timeline { margin: 0; padding: 0; list-style: none; }
.ui-timeline li { position: relative; display: flex; flex-direction: column; gap: 0.2rem; padding: 0 0 1rem 1.5rem; }
.ui-timeline li::before { content: ''; position: absolute; left: 0; top: 0.35rem; width: 0.65rem; height: 0.65rem; border-radius: 50%; background: currentColor; }
.ui-timeline li:not(:last-child)::after { content: ''; position: absolute; left: 0.3rem; top: 1rem; bottom: 0; border-left: 1px solid var(--ui-border); }
.ui-timeline .is-info { color: var(--tui-blue); }
.ui-timeline .is-success { color: var(--tui-green); }
.ui-timeline .is-warning { color: var(--tui-yellow); }
.ui-timeline .is-danger { color: var(--tui-red); }
.ui-timeline .is-neutral { color: var(--tui-bright-black); }
.ui-timeline-title { color: var(--tui-fg); }
.ui-timeline-detail { color: var(--tui-bright-black); }
`);
