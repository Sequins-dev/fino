/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/data.preview — preview previews for file trees, tables, timelines, and virtual lists.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/preview` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import {
  Button,
  FileTree,
  HStack,
  Table,
  Text,
  Timeline,
  VStack,
  VirtualList,
  VirtualScroll,
  createTreeState,
  styles,
} from 'fino:ui/components';
import type { FileTreeNode } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

export function dataPreviews(): PreviewGroup {
  const tree = createTreeState(['src']);
  const picked = createSignal<string | null>('a');
  const row = createSignal(0);
  const virtualRows = 10;
  const virtual = new VirtualScroll();
  virtual.setCount(500);
  const virtualVersion = createSignal(0);
  const virtualBump = (): void => virtualVersion.set(virtualVersion.get() + 1);
  const nodes: FileTreeNode[] = [
    {
      key: 'src',
      label: 'src',
      children: [
        { key: 'a', label: 'main.ts' },
        { key: 'theme', label: 'theme.json' },
        { key: 'lib', label: 'lib', children: [{ key: 'b', label: 'util.js' }] },
        { key: 'logo', label: 'logo.png' },
        { key: 'data', label: 'data.bin' },
      ],
    },
    { key: 'docs', label: 'docs', children: [{ key: 'guide', label: 'guide.md' }] },
    { key: 'readme', label: 'README.md' },
    { key: 'lock', label: 'deps.lock' },
  ];
  return {
    title: 'Data views',
    previews: [
      {
        key: 'file-tree',
        name: 'FileTree',
        view: () => (
          <FileTree
            id="preview-tree"
            nodes={nodes}
            expanded={tree.expanded.get()}
            selectedKey={picked.get()}
            onToggle={tree.toggle}
            onSelect={(key) => picked.set(key)}
          />
        ),
      },
      {
        key: 'table',
        name: 'Table',
        view: () => (
          <Table
            id="preview-table"
            columns={[
              { key: 'name', header: 'Name' },
              { key: 'size', header: 'Size', align: 'end' },
            ]}
            rows={[
              { name: 'a.ts', size: '120' },
              { name: 'lib/b.ts', size: '48' },
              { name: 'README.md', size: '1024' },
            ]}
            selectedIndex={row.get()}
            onSelectRow={(index) => row.set(index)}
          />
        ),
      },
      {
        key: 'timeline',
        name: 'Timeline',
        view: () => (
          <Timeline
            entries={[
              { key: 'boot', title: 'Runtime booted', detail: '12ms' },
              { key: 'build', title: 'Build finished', detail: '420ms', variant: 'success' },
              { key: 'cache', title: 'Cache miss', detail: 'cold start', variant: 'warning' },
              { key: 'deploy', title: 'Deploy failed', detail: 'rolled back', variant: 'danger' },
              { key: 'retry', title: 'Retry scheduled', variant: 'info' },
            ]}
          />
        ),
      },
      {
        key: 'virtual-list',
        name: 'VirtualList',
        view: () => {
          virtualVersion.get();
          const slice = virtual.window(virtualRows);
          return (
            <VStack gap={1}>
              <VirtualList
                height={virtualRows}
                window={slice}
                offset={virtual.offset}
                onMouse={(event) => {
                  if (virtual.handleWheel(event, virtualRows)) {
                    virtualBump();
                    return true;
                  }
                  return false;
                }}
                onScroll={(offset) => {
                  virtual.scrollTo(offset, virtualRows);
                  virtualBump();
                }}
              >
                {Array.from({ length: slice.end - slice.start }, (_, i) => {
                  const index = slice.start + i;
                  return (
                    <Text key={String(index)}>{`item ${String(index).padStart(3, '0')}`}</Text>
                  );
                })}
              </VirtualList>
              <HStack gap={1}>
                <Button
                  label="Jump to end"
                  onClick={() => {
                    virtual.scrollToEnd(virtualRows);
                    virtualBump();
                  }}
                />
                <Text
                  style={[styles.muted]}
                >{`offset ${virtual.offset}/${virtual.totalRows}`}</Text>
              </HStack>
            </VStack>
          );
        },
      },
    ],
  };
}
