import { describe, it } from 'fino:test/test';
import { h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import { FileTree, Table, Timeline, createTreeState, visibleTreeRows } from 'fino:ui/components';
import { toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { dataPreviews } from 'internal:ui/components/data.preview';
import { defaultArgs } from 'internal:ui/preview';
import { createTuiHarness, plainLine } from './tui-harness.ts';

function html(tree: VNode, actions?: Map<string, (value?: string) => void>): string {
  return renderToHtml(toHtml(tree, actions === undefined ? {} : { actions }));
}

describe('data components', () => {
  it('keeps expansion, selection, and visible tree rows outside components', (t) => {
    const nodes = [
      { key: 'src', label: 'src', children: [{ key: 'main', label: 'main.ts' }] },
      { key: 'readme', label: 'README.md' },
    ];
    const state = createTreeState([], 'readme');
    t.deepEqual(
      visibleTreeRows(nodes, state.expanded.get()).map((row) => row.node.key),
      ['src', 'readme'],
    );
    state.toggle('src');
    state.select('main');
    t.deepEqual(
      visibleTreeRows(nodes, state.expanded.get()).map((row) => row.node.key),
      ['src', 'main', 'readme'],
    );
    t.equal(state.selectedKey.get(), 'main');
    t.equal(state.isExpanded('src'), true);
  });

  it('groups HTML table and tree actions once per control', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const calls: string[] = [];
    const out = html(
      h(
        'fragment',
        null,
        h(Table, {
          columns: [{ key: 'name', header: 'Name' }],
          rows: [{ name: 'one' }, { name: 'two' }],
          onSelectRow: (index) => calls.push(`row:${index}`),
        }),
        h(FileTree, {
          nodes: [{ key: 'src', label: 'src', children: [{ key: 'main', label: 'main.ts' }] }],
          expanded: ['src'],
          onToggle: (key) => calls.push(`toggle:${key}`),
          onSelect: (key) => calls.push(`select:${key}`),
        }),
      ),
      actions,
    );
    t.equal(actions.size, 2);
    t.ok(out.includes('role="tree"'));
    actions.get('a0')?.('1');
    actions.get('a1')?.('toggle:src');
    actions.get('a1')?.('select:main');
    t.deepEqual(calls, ['row:1', 'toggle:src', 'select:main']);
  });

  it('renders table, tree, and timeline terminal compositions', (t) => {
    const app = createTuiHarness(32, 9);
    app.render(
      h(
        'fragment',
        null,
        h(FileTree, {
          nodes: [{ key: 'src', label: 'src', children: [{ key: 'main', label: 'main.ts' }] }],
          expanded: ['src'],
          selectedKey: 'main',
        }),
        h(Table, {
          columns: [{ key: 'name', header: 'Name' }],
          rows: [{ name: 'api' }],
        }),
        h(Timeline, {
          entries: [{ key: 'done', title: 'Done', detail: '12s', variant: 'success' }],
        }),
      ),
    );
    const text = app.lines().map(plainLine).join('\n');
    for (const value of ['main.ts', 'Name', 'api', 'Done']) t.ok(text.includes(value));
  });

  it('keeps data previews co-located and renderable', (t) => {
    const group = dataPreviews();
    t.ok(group.previews.length > 0);
    for (const preview of group.previews) {
      t.ok(html(preview.view(defaultArgs(preview))).length > 0, `${group.title}/${preview.key}`);
    }
  });
});
