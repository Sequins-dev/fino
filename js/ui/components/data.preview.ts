/** Co-located previews for data components. @internal */
import { h } from 'fino:ui';
import { FileTree, Table, Timeline } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build data-family previews for a catalog host. */
export function dataPreviews(): PreviewGroup {
  return {
    title: 'Data',
    previews: [
      {
        key: 'table',
        name: 'Table',
        view: () =>
          h(Table, {
            columns: [
              { key: 'name', header: 'Name' },
              { key: 'state', header: 'State' },
            ],
            rows: [
              { name: 'api', state: 'ready' },
              { name: 'worker', state: 'busy' },
            ],
            selectedIndex: 0,
          }),
      },
      {
        key: 'tree',
        name: 'File tree',
        view: () =>
          h(FileTree, {
            nodes: [{ key: 'src', label: 'src', children: [{ key: 'main', label: 'main.ts' }] }],
            expanded: ['src'],
            selectedKey: 'main',
          }),
      },
      {
        key: 'timeline',
        name: 'Timeline',
        view: () =>
          h(Timeline, {
            entries: [
              { key: 'queued', title: 'Queued', variant: 'neutral' },
              { key: 'done', title: 'Completed', detail: '12 seconds', variant: 'success' },
            ],
          }),
      },
    ],
  };
}
