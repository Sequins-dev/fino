/** Terminal lowerings for data components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { Box, Clickable, Rule, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { stringWidth } from 'fino:tty/frame';
import { FileTree, Table, Timeline, fileIcon, visibleTreeRows } from 'internal:ui/components/data';
import { iconForm } from 'internal:ui/components/icons';
import { mapComponentLowering } from 'internal:ui/components/target';

function timelineStyle(variant: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | undefined) {
  return variant === 'neutral' ? styles.muted : styles[variant ?? 'info'];
}

mapComponentLowering(Table, 'tui', (props) => {
  const { columns, rows, selectedIndex, onSelectRow, id, ...rest } = props;
  const widths = columns.map((column) => {
    if (column.width !== undefined) return Math.max(1, Math.floor(column.width));
    let widest = stringWidth(column.header);
    for (const row of rows) widest = Math.max(widest, stringWidth(row[column.key] ?? ''));
    return widest;
  });
  const cells = (row: Readonly<Record<string, string>>): VNode[] =>
    columns.map((column, index) =>
      h(
        Text,
        {
          key: column.key,
          width: widths[index],
          align: column.align,
          truncate: column.width !== undefined,
        },
        row[column.key] ?? '',
      ),
    );
  return h(
    Box,
    { ...rest, direction: 'column', id } as Props,
    h(
      Box,
      { direction: 'row', gap: 1 },
      ...columns.map((column, index) =>
        h(
          Text,
          {
            key: column.key,
            width: widths[index],
            align: column.align,
            truncate: column.width !== undefined,
            style: [styles.bold],
          },
          column.header,
        ),
      ),
    ),
    h(Rule, { style: [styles.dim] }),
    ...rows.map((row, index) => {
      const rowProps: Props = {
        key: String(index),
        direction: 'row',
        gap: 1,
        style: index === selectedIndex ? [styles.inverse] : [],
      };
      return onSelectRow === undefined
        ? h(Box, rowProps, ...cells(row))
        : h(
            Clickable,
            {
              ...rowProps,
              id: id === undefined ? undefined : `${id}:${index}`,
              focusable: false,
              onClick: () => onSelectRow(index),
            },
            ...cells(row),
          );
    }),
  );
});

mapComponentLowering(FileTree, 'tui', (props) => {
  const { nodes, expanded, selectedKey, icons, folderIcons, onToggle, onSelect, id, ...rest } =
    props;
  const rows = visibleTreeRows(nodes, expanded);
  return h(
    Box,
    { ...rest, direction: 'column', id } as Props,
    ...rows.map(({ node, depth, directory, open }) => {
      const glyph = iconForm(fileIcon(node, icons, open, folderIcons), 'tui');
      const rowClick =
        onSelect !== undefined
          ? () => onSelect(node.key)
          : directory && onToggle !== undefined
            ? () => onToggle(node.key)
            : undefined;
      return h(
        Clickable,
        {
          key: node.key,
          id: id === undefined ? undefined : `${id}:${node.key}`,
          direction: 'row',
          focusable: false,
          style: node.key === selectedKey ? [styles.bold, styles.inverse] : [],
          onClick: rowClick,
        },
        depth === 0 ? null : h(Text, null, ' '.repeat(depth * 2)),
        directory
          ? h(
              Clickable,
              {
                id: id === undefined ? undefined : `${id}:${node.key}:toggle`,
                focusable: false,
                onClick: onToggle === undefined ? undefined : () => onToggle(node.key),
              },
              h(Text, null, glyph),
            )
          : h(Text, null, glyph),
        h(Text, null, ` ${node.label}`),
      );
    }),
  );
});

mapComponentLowering(Timeline, 'tui', (props) => {
  const { entries, id, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: 'column', id } as Props,
    ...entries.flatMap((entry, index) => {
      const last = index === entries.length - 1;
      return [
        h(
          Box,
          { key: entry.key, direction: 'row', gap: 1 },
          h(Text, { style: [timelineStyle(entry.variant)] }, '●'),
          h(Text, null, entry.title),
        ),
        entry.detail === undefined
          ? null
          : h(
              Text,
              { key: `${entry.key}:detail`, style: [styles.dim] },
              `${last ? ' ' : '│'}  ${entry.detail}`,
            ),
        last ? null : h(Text, { key: `${entry.key}:gap`, style: [styles.dim] }, '│'),
      ];
    }),
  );
});
