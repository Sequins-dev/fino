import { describe, it } from 'fino:test/test';
import { h, Fragment, createSignal, batch, createRenderer, type Child, type HostAdapter, type Props } from 'fino:ui';
import { jsx, jsxs } from 'fino:ui/jsx-runtime';

describe('fino:ui vnode construction', () => {
  it('normalizes props, keyed children, fragments, and JSX runtime calls', (t) => {
    const vnode = h(
      'row',
      { id: 'root', key: 'root-key' },
      'a',
      [false, h('cell', { key: 'b' }, 'b'), null],
      h(Fragment, null, 'c', undefined),
    );

    t.equal(vnode.type, 'row', 'type is preserved');
    t.equal(vnode.key, 'root-key', 'key is copied from props');
    t.deepEqual(vnode.props, { id: 'root' }, 'key is removed from props');
    t.equal(vnode.children.length, 3, 'empty children are removed and fragments are flattened');
    t.equal(vnode.children[0], 'a', 'text child is preserved');
    t.equal((vnode.children[1] as any).key, 'b', 'child key is preserved');
    t.equal(vnode.children[2], 'c', 'fragment children are flattened');

    t.deepEqual(jsx('text', { children: 'hello' }), h('text', null, 'hello'), 'jsx delegates to h');
    t.deepEqual(jsxs('text', { children: ['h', 'i'] }), h('text', null, 'h', 'i'), 'jsxs delegates to h');
  });

  it('invokes function components with normalized children', (t) => {
    function Label(props: { prefix: string; children?: Child[] }) {
      return h('text', null, props.prefix, props.children?.[0]);
    }

    const vnode = h(Label, { prefix: '>' }, 'name');

    t.equal(vnode.type, 'text', 'function component output is returned');
    t.deepEqual(vnode.children, ['>', 'name'], 'children are passed through props');
  });
});

describe('fino:ui signals', () => {
  it('notifies subscribers once for batched signal writes', (t) => {
    const count = createSignal(0);
    const seen: number[] = [];
    const dispose = count.subscribe((value) => seen.push(value));

    count.set(1);
    batch(() => {
      count.set(2);
      count.set((value) => value + 1);
    });
    dispose();
    count.set(4);

    t.equal(count.get(), 4, 'signal value updates after unsubscribe');
    t.deepEqual(seen, [1, 3], 'batched writes notify once with final value');
  });
});

describe('fino:ui host renderer', () => {
  it('reconciles keyed children and wraps host changes in update batches', (t) => {
    let nextId = 0;
    const calls: string[] = [];
    interface TestNode {
      id: number;
      type: string;
      props?: Props;
      text?: string;
      children: TestNode[];
    }
    interface TestRoot {
      kind: 'root';
      children: TestNode[];
    }
    const root: TestRoot = { kind: 'root', children: [] };
    const host: HostAdapter<TestNode, TestRoot> = {
      beginUpdate() { calls.push('begin'); },
      endUpdate() { calls.push('end'); },
      createNode(type, props) {
        const node = { id: ++nextId, type, props, children: [] };
        calls.push(`create:${type}:${node.id}`);
        return node;
      },
      createText(text) {
        const node = { id: ++nextId, type: '#text', text, children: [] };
        calls.push(`text:${text}:${node.id}`);
        return node;
      },
      updateNode(node, props) {
        node.props = props;
        calls.push(`update:${node.type}:${node.id}`);
      },
      setText(node, text) {
        node.text = text;
        calls.push(`setText:${node.id}:${text}`);
      },
      insertChild(parent, child, index) {
        parent.children.splice(index, 0, child);
        calls.push(`insert:${child.id}:${index}`);
      },
      moveChild(parent, child, index) {
        const from = parent.children.indexOf(child);
        if (from >= 0) parent.children.splice(from, 1);
        parent.children.splice(index, 0, child);
        calls.push(`move:${child.id}:${index}`);
      },
      removeChild(parent, child) {
        const from = parent.children.indexOf(child);
        if (from >= 0) parent.children.splice(from, 1);
        calls.push(`remove:${child.id}`);
      },
    };
    const renderer = createRenderer(host);

    renderer.render(h('row', null, h('cell', { key: 'a', value: 1 }), h('cell', { key: 'b', value: 2 })), root);
    const firstA = root.children[0]!.children[0];
    const firstB = root.children[0]!.children[1];

    renderer.render(h('row', null, h('cell', { key: 'b', value: 3 }), h('cell', { key: 'a', value: 1 })), root);

    t.equal(root.children[0]!.children[0], firstB, 'keyed child b is reused and moved first');
    t.equal(root.children[0]!.children[1], firstA, 'keyed child a is reused and moved second');
    t.deepEqual(
      calls.filter((call) => call === 'begin' || call === 'end'),
      ['begin', 'end', 'begin', 'end'],
      'each render is wrapped in one host update batch',
    );
  });
});
