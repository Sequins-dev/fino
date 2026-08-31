import { describe, it } from 'fino:test/test';
import {
  h,
  Fragment,
  createSignal,
  batch,
  createRenderer,
  defineRenderTarget,
  lowerTree,
  mapRenderTargetLowering,
  type Child,
  type HostAdapter,
  type Props,
} from 'fino:ui';
import { jsx, jsxs } from 'fino:ui/jsx-runtime';
describe('fino:ui vnode construction', () => {
  it('normalizes props, keyed children, fragments, and JSX runtime calls', (t) => {
    const vnode = h(
      'row',
      {
        id: 'root',
        key: 'root-key',
      },
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
    t.deepEqual(
      jsxs('text', { children: ['h', 'i'] }),
      h('text', null, 'h', 'i'),
      'jsxs delegates to h',
    );
  });
  it('stores function components instead of invoking them', (t) => {
    function Label(props: { prefix: string; children?: Child[] }) {
      return h('text', null, props.prefix, props.children?.[0]);
    }
    const vnode = h(Label, { prefix: '>' }, 'name');
    t.equal(vnode.type, Label, 'the component itself is the node type');
    t.deepEqual(vnode.props, { prefix: '>' }, 'props are normalized as usual');
    t.deepEqual(vnode.children, ['name'], 'children stay on the node');
  });
  it('invokes a stored component with normalized children when lowered', (t) => {
    function Label(props: { prefix: string; children?: Child[] }) {
      return h('text', null, props.prefix, props.children?.[0]);
    }
    const lowered = lowerTree(h(Label, { prefix: '>' }, 'name'), 'test:plain');
    t.equal(lowered.type, 'text', 'the component ran during lowering');
    t.deepEqual(lowered.children, ['>', 'name'], 'children are passed through props');
  });
  it('preserves the caller key through a function component', (t) => {
    function Item() {
      return h('row', { key: 'implementation-key' });
    }
    t.equal(lowerTree(h(Item, { key: 'instance-key' }), 'test:plain').key, 'instance-key');
  });
  it('lets a render target substitute its own lowering for a component', (t) => {
    function Label(props: { prefix: string }) {
      return h('text', null, props.prefix);
    }
    // Registered by the *target*, not by whoever wrote Label — that is the
    // point: a target lowers components it did not author.
    mapRenderTargetLowering(Label, 'test:shout', (props: { prefix: string }) =>
      h('loud', null, props.prefix.toUpperCase()),
    );
    const node = h(Label, { prefix: 'hi' });
    t.equal(lowerTree(node, 'test:plain').type, 'text', 'other targets keep the default');
    const shouted = lowerTree(node, 'test:shout');
    t.equal(shouted.type, 'loud', 'the registered lowering replaced the default');
    t.deepEqual(shouted.children, ['HI'], 'the lowering saw the same props');
  });
  it('lowers host element names generically for a target', (t) => {
    mapRenderTargetLowering('article', 'test:boxed', (props: { children?: Child[] }) =>
      h('box', { border: true }, ...((props.children ?? []) as Child[])),
    );
    const lowered = lowerTree(h('article', null, 'body'), 'test:boxed');
    t.equal(lowered.type, 'box', 'the element name resolved through the registry');
    t.deepEqual(lowered.children, ['body'], 'children carried across');
  });
  it('refuses a node the target has no lowering for', (t) => {
    defineRenderTarget('test:strict', { primitives: ['ink'] });
    t.throws(
      () => lowerTree(h('article', null, 'body'), 'test:strict'),
      /No 'test:strict' lowering for 'article'/,
      'the primitive floor names both the node and the target',
    );
  });
  it('stops a lowering that never reaches a primitive', (t) => {
    function Loop() {
      return h(Loop, null);
    }
    t.throws(
      () => lowerTree(h(Loop, null), 'test:plain'),
      /did not reach a primitive/,
      'the depth cap catches a lowering that emits its own type',
    );
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
  it('routes named components and reconciles keyed instances in update batches', (t) => {
    let nextId = 0;
    const calls: string[] = [];
    const implementations: Record<string, string> = {
      'layout.row.v1': 'native-row',
      'content.cell.v1': 'native-cell',
    };
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
    const root: TestRoot = {
      kind: 'root',
      children: [],
    };
    const host: HostAdapter<TestNode, TestRoot> = {
      beginUpdate() {
        calls.push('begin');
      },
      endUpdate() {
        calls.push('end');
      },
      createNode(type, props) {
        const implementation = implementations[type];
        if (implementation === undefined) throw new Error(`Unknown component: ${type}`);
        const node = {
          id: ++nextId,
          type: implementation,
          props,
          children: [],
        };
        calls.push(`create:${type}:${node.id}`);
        return node;
      },
      createText(text) {
        const node = {
          id: ++nextId,
          type: '#text',
          text,
          children: [],
        };
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
    renderer.render(
      h(
        'layout.row.v1',
        null,
        h('content.cell.v1', {
          key: 'a',
          value: 1,
        }),
        h('content.cell.v1', {
          key: 'b',
          value: 2,
        }),
      ),
      root,
    );
    const firstA = root.children[0]!.children[0];
    const firstB = root.children[0]!.children[1];
    renderer.render(
      h(
        'layout.row.v1',
        null,
        h('content.cell.v1', {
          key: 'b',
          value: 3,
        }),
        h('content.cell.v1', {
          key: 'a',
          value: 1,
        }),
      ),
      root,
    );
    t.equal(root.children[0]!.type, 'native-row', 'the client chooses the host implementation');
    t.equal(root.children[0]!.children[0], firstB, 'keyed child b is reused and moved first');
    t.equal(root.children[0]!.children[1], firstA, 'keyed child a is reused and moved second');
    t.deepEqual(
      calls.filter((call) => call === 'begin' || call === 'end'),
      ['begin', 'end', 'begin', 'end'],
      'each render is wrapped in one host update batch',
    );
  });
});
