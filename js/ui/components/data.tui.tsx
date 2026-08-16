/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/data.tui — terminal forms for tables, file trees, and timelines.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { Box, Clickable, Rule, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { stringWidth } from 'fino:tty/frame';
import { iconForm } from 'internal:ui/components/icons';
import { fileIcon } from 'internal:ui/components/data';
import { FileTree, Table, Timeline } from 'internal:ui/components/data';
import type {
  FileTreeProps,
  TableProps,
  TimelineProps,
} from 'internal:ui/components/data';

mapRenderTargetLowering(Table, 'tui', (all: TableProps): VNode => {
  const { children = [], ...props } = all as TableProps & { children?: NormalizedChild[] };
  const { columns, rows, selectedIndex, onSelectRow, id, ...rest } = props;
  const widths = columns.map((column) => {
    if (column.width !== undefined) return column.width;
    let widest = stringWidth(column.header);
    for (const row of rows) widest = Math.max(widest, stringWidth(row[column.key] ?? ''));
    return widest;
  });
  const cells = (row: Record<string, string>): VNode[] =>
    columns.map((column, index) => (
      <Text
        key={column.key}
        width={widths[index]}
        align={column.align}
        truncate={column.width !== undefined}
      >
        {row[column.key] ?? ''}
      </Text>
    ));
  return (
    <Box direction="column" id={id} {...rest}>
      <Box direction="row" gap={1}>
        {columns.map((column, index) => (
          <Text
            key={column.key}
            width={widths[index]}
            align={column.align}
            truncate={column.width !== undefined}
            style={[styles.bold]}
          >
            {column.header}
          </Text>
        ))}
      </Box>
      <Rule style={[styles.dim]} />
      {rows.map((row, index) =>
        onSelectRow ? (
          <Clickable
            key={`${index}`}
            id={id !== undefined ? `${id}:${index}` : undefined}
            direction="row"
            gap={1}
            focusable={false}
            style={index === selectedIndex ? [styles.inverse] : []}
            onClick={() => onSelectRow(index)}
          >
            {cells(row)}
          </Clickable>
        ) : (
          <Box
            key={`${index}`}
            direction="row"
            gap={1}
            style={index === selectedIndex ? [styles.inverse] : []}
          >
            {cells(row)}
          </Box>
        ),
      )}
    </Box>
  );
});

mapRenderTargetLowering(FileTree, 'tui', (all: FileTreeProps): VNode => {
  const { children = [], ...props } = all as FileTreeProps & { children?: NormalizedChild[] };
  const { nodes, expanded, selectedKey, icons, folderIcons, onToggle, onSelect, id, ...rest } =
    props;
  const rows: VNode[] = [];
  const visit = (node: FileTreeNode, depth: number): void => {
    const dir = node.children !== undefined;
    const open = dir && expanded.includes(node.key);
    const selected = node.key === selectedKey;
    const glyph = iconForm(fileIcon(node, icons, open, folderIcons), 'tui');
    // The icon IS the expander: a directory's icon toggles it, the rest of
    // the row selects. With no select handler the whole row toggles.
    const rowClick =
      onSelect !== undefined
        ? () => onSelect(node.key)
        : dir && onToggle !== undefined
          ? () => onToggle(node.key)
          : undefined;
    rows.push(
      <Clickable
        key={node.key}
        id={id !== undefined ? `${id}:${node.key}` : undefined}
        direction="row"
        focusable={false}
        style={selected ? [styles.bold, styles.inverse] : []}
        onClick={rowClick}
      >
        {depth > 0 ? <Text>{' '.repeat(depth * 2)}</Text> : null}
        {dir ? (
          <Clickable
            id={id !== undefined ? `${id}:${node.key}:toggle` : undefined}
            focusable={false}
            onClick={onToggle ? () => onToggle(node.key) : undefined}
          >
            <Text>{glyph}</Text>
          </Clickable>
        ) : (
          <Text>{glyph}</Text>
        )}
        <Text>{` ${node.label}`}</Text>
      </Clickable>,
    );
    if (open) for (const child of node.children!) visit(child, depth + 1);
  };
  for (const node of nodes) visit(node, 0);
  return (
    <Box direction="column" id={id} {...rest}>
      {rows}
    </Box>
  );
});

mapRenderTargetLowering(Timeline, 'tui', (all: TimelineProps): VNode => {
  const { children = [], ...props } = all as TimelineProps & { children?: NormalizedChild[] };
  const { entries, id, ...rest } = props;
  return (
    <Box direction="column" id={id} {...rest}>
      {entries.flatMap((entry, index) => {
        const last = index === entries.length - 1;
        const rows = [
          <Box key={entry.key} direction="row" gap={1}>
            <Text style={[styles[entry.variant ?? 'info']]}>●</Text>
            <Text>{entry.title}</Text>
          </Box>,
        ];
        if (entry.detail !== undefined) {
          rows.push(
            <Text key={`${entry.key}:detail`} style={[styles.dim]}>
              {`${last ? ' ' : '│'}  ${entry.detail}`}
            </Text>,
          );
        }
        // A connector row between segments, so entries breathe instead of
        // stacking flush against each other.
        if (!last) {
          rows.push(
            <Text key={`${entry.key}:gap`} style={[styles.dim]}>
              {'│'}
            </Text>,
          );
        }
        return rows;
      })}
    </Box>
  );
});
