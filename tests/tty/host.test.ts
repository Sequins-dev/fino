import { describe, it } from 'fino:test/test';
import { createRenderer, h } from 'fino:ui';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';

describe('internal:tty/host retained reconciliation', () => {
  it('preserves node identity and avoids dirtying unchanged props', (t) => {
    const root = createTerminalRoot();
    const renderer = createRenderer(terminalHost());
    renderer.render(h('box', { direction: 'column' }, h('text', { bold: true }, 'one')), root);
    const box = root.children[0]!;
    const text = box.children[0]!;
    const revision = root.revision;

    renderer.render(h('box', { direction: 'column' }, h('text', { bold: true }, 'one')), root);
    t.equal(root.children[0], box, 'the root host node is retained');
    t.equal(root.children[0]!.children[0], text, 'the child host node is retained');
    t.equal(root.revision, revision, 'equal props and text do not dirty the tree');

    renderer.render(h('box', { direction: 'column' }, h('text', { bold: true }, 'two')), root);
    t.equal(root.children[0]!.children[0], text, 'a text update preserves host identity');
    t.ok(root.revision > revision, 'a visible text update dirties the retained root');
  });

  it('retains keyed children across reordering and releases removed subtrees', (t) => {
    const root = createTerminalRoot();
    const released: string[] = [];
    root.onRelease = (node) => released.push(String(node.props.id ?? node.type));
    const renderer = createRenderer(terminalHost());
    renderer.render(
      h(
        'box',
        null,
        h('text', { key: 'a', id: 'a' }, 'A'),
        h('box', { key: 'b', id: 'b' }, h('text', { id: 'nested' }, 'B')),
      ),
      root,
    );
    const box = root.children[0]!;
    const a = box.children[0]!;
    const b = box.children[1]!;

    renderer.render(
      h(
        'box',
        null,
        h('box', { key: 'b', id: 'b' }, h('text', { id: 'nested' }, 'B')),
        h('text', { key: 'a', id: 'a' }, 'A'),
      ),
      root,
    );
    t.deepEqual(box.children, [b, a], 'keyed children move without replacement');

    renderer.render(h('box', null, h('text', { key: 'a', id: 'a' }, 'A')), root);
    t.deepEqual(released, ['b', 'nested', '#text'], 'removal releases the complete subtree');
  });
});
