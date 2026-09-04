import { describe, it } from 'fino:test/test';
import { h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import { Text, VirtualList, VirtualScroll } from 'fino:ui/components';
import { toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { defaultArgs } from 'internal:ui/preview';
import { virtualPreviews } from 'internal:ui/components/virtual.preview';
import { createTuiHarness, plainLine } from './tui-harness.ts';

function html(tree: VNode, actions?: Map<string, (value?: string) => void>): string {
  return renderToHtml(toHtml(tree, actions === undefined ? {} : { actions }));
}

describe('virtual lists', () => {
  it('computes sparse measured windows without item-sized state', (t) => {
    const model = new VirtualScroll();
    model.setCount(1_000_000);
    model.setHeight(5_000, 4);
    t.equal(model.totalRows, 1_000_003);
    model.scrollTo(4_999, 5);
    t.deepEqual(model.window(5, 1), {
      start: 4_998,
      end: 5_002,
      topPad: 4_998,
      bottomPad: 994_998,
    });
    t.equal(
      model.handleWheel({ type: 'mouse', action: 'wheel', button: 'wheel-down', x: 0, y: 0 }, 5),
      true,
    );
    t.equal(model.offset, 5_002);
  });

  it('registers one HTML scrolling action', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const calls: number[] = [];
    const out = html(
      h(
        VirtualList,
        {
          height: 3,
          window: { start: 10, end: 11, topPad: 10, bottomPad: 89 },
          offset: 10,
          onScroll: (offset) => calls.push(offset),
        },
        h(Text, null, 'row 10'),
      ),
      actions,
    );
    t.equal(actions.size, 1);
    t.ok(out.includes('data-fi-scroll="1"'));
    actions.get('a0')?.('12');
    t.deepEqual(calls, [12]);
  });

  it('renders only the terminal window children', (t) => {
    const model = new VirtualScroll();
    model.setCount(100);
    model.scrollTo(50, 3);
    const window = model.window(3, 0);
    const app = createTuiHarness(30, 4);
    app.render(
      h(
        VirtualList,
        { height: 3, window, offset: model.offset },
        ...Array.from({ length: window.end - window.start }, (_, index) =>
          h(Text, { key: String(index) }, `Row ${window.start + index}`),
        ),
      ),
    );
    const text = app.lines().map(plainLine).join('\n');
    t.ok(text.includes('Row 50'));
    t.equal(text.includes('Row 49'), false);
  });

  it('keeps virtual previews co-located and renderable', (t) => {
    const group = virtualPreviews();
    t.ok(group.previews.length > 0);
    for (const preview of group.previews) {
      t.ok(html(preview.view(defaultArgs(preview))).length > 0, `${group.title}/${preview.key}`);
    }
  });
});
