import { describe, it } from 'fino:test/test';
import {
  h,
  Fragment,
  createSignal,
  batch,
  createRenderer,
  componentName,
  defineRenderTarget,
  lowerTree,
  mapRenderTargetLowering,
  nameComponent,
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
    const target = defineRenderTarget('test:plain');
    try {
      const lowered = lowerTree(h(Label, { prefix: '>' }, 'name'), 'test:plain');
      t.equal(lowered.type, 'text', 'the component ran during lowering');
      t.deepEqual(lowered.children, ['>', 'name'], 'children are passed through props');
    } finally {
      target.dispose();
    }
  });
  it('preserves the caller key through a function component', (t) => {
    function Item() {
      return h('row', { key: 'implementation-key' });
    }
    const target = defineRenderTarget('test:plain');
    try {
      t.equal(lowerTree(h(Item, { key: 'instance-key' }), 'test:plain').key, 'instance-key');
    } finally {
      target.dispose();
    }
  });
  it('lets a render target substitute its own lowering for a component', (t) => {
    function Label(props: { prefix: string }) {
      return h('text', null, props.prefix);
    }
    // Registered by the *target*, not by whoever wrote Label — that is the
    // point: a target lowers components it did not author.
    const plainTarget = defineRenderTarget('test:plain');
    const shoutTarget = defineRenderTarget('test:shout', { primitives: ['loud'] });
    const lowering = mapRenderTargetLowering(Label, 'test:shout', (props: { prefix: string }) =>
      h('loud', null, props.prefix.toUpperCase()),
    );
    try {
      const node = h(Label, { prefix: 'hi' });
      t.equal(lowerTree(node, 'test:plain').type, 'text', 'other targets keep the default');
      const shouted = lowerTree(node, 'test:shout');
      t.equal(shouted.type, 'loud', 'the registered lowering replaced the default');
      t.deepEqual(shouted.children, ['HI'], 'the lowering saw the same props');
    } finally {
      lowering.dispose();
      shoutTarget.dispose();
      plainTarget.dispose();
    }
  });
  it('lowers host element names generically for a target', (t) => {
    const target = defineRenderTarget('test:boxed', { primitives: ['box'] });
    const lowering = mapRenderTargetLowering(
      'article',
      'test:boxed',
      (props: { children?: Child[] }) =>
        h('box', { border: true }, ...((props.children ?? []) as Child[])),
    );
    try {
      const lowered = lowerTree(h('article', null, 'body'), 'test:boxed');
      t.equal(lowered.type, 'box', 'the element name resolved through the registry');
      t.deepEqual(lowered.children, ['body'], 'children carried across');
    } finally {
      lowering.dispose();
      target.dispose();
    }
  });
  it('refuses a node the target has no lowering for', (t) => {
    const target = defineRenderTarget('test:strict', { primitives: ['ink'] });
    try {
      t.throws(
        () => lowerTree(h('article', null, 'body'), 'test:strict'),
        /No 'test:strict' lowering for 'article'/,
        'the primitive floor names both the node and the target',
      );
    } finally {
      target.dispose();
    }
  });
  it('stops a lowering that never reaches a primitive', (t) => {
    function Loop() {
      return h(Loop, null);
    }
    const target = defineRenderTarget('test:plain');
    try {
      t.throws(
        () => lowerTree(h(Loop, null), 'test:plain'),
        /did not reach a primitive/,
        'the depth cap catches a lowering that emits its own type',
      );
    } finally {
      target.dispose();
    }
  });
  it('lowers nested third-party composition to a target primitive', (t) => {
    function ThirdPartyLeaf(props: { children?: Child[] }) {
      return h('article', null, ...((props.children ?? []) as Child[]));
    }
    function ThirdPartyWrapper(props: { children?: Child[] }) {
      return h(ThirdPartyLeaf, null, ...((props.children ?? []) as Child[]));
    }
    const target = defineRenderTarget('test:third-party', { primitives: ['panel'] });
    const lowering = mapRenderTargetLowering(
      'article',
      'test:third-party',
      (props: { children?: Child[] }) => h('panel', null, ...((props.children ?? []) as Child[])),
    );
    try {
      const lowered = lowerTree(
        h(ThirdPartyWrapper, { key: 'outside-catalog' }, 'body'),
        'test:third-party',
      );
      t.equal(lowered.type, 'panel', 'composition reaches the target primitive fixpoint');
      t.equal(lowered.key, 'outside-catalog', 'the outer component key survives every lowering');
      t.deepEqual(lowered.children, ['body'], 'nested children survive every lowering');
    } finally {
      lowering.dispose();
      target.dispose();
    }
  });
  it('restores target floors and lowerings when overrides are disposed', (t) => {
    const baseTarget = defineRenderTarget('test:override', { primitives: ['base'] });
    const baseLowering = mapRenderTargetLowering('article', 'test:override', () => h('base', null));
    const overrideTarget = defineRenderTarget('test:override', { primitives: ['override'] });
    const overrideLowering = mapRenderTargetLowering('article', 'test:override', () =>
      h('override', null),
    );
    try {
      t.equal(
        lowerTree(h('article', null), 'test:override').type,
        'override',
        'the most recent active registrations win',
      );
      overrideLowering.dispose();
      overrideTarget.dispose();
      t.equal(
        lowerTree(h('article', null), 'test:override').type,
        'base',
        'disposing overrides restores the previous registrations',
      );
      t.ok(overrideLowering.disposed, 'registration reports its disposed state');
      overrideLowering.dispose();
    } finally {
      overrideLowering.dispose();
      overrideTarget.dispose();
      baseLowering.dispose();
      baseTarget.dispose();
    }
  });
  it('removes exact registrations even when they are disposed out of order', (t) => {
    const target = defineRenderTarget('test:out-of-order');
    const first = mapRenderTargetLowering('article', 'test:out-of-order', () => h('first', null));
    const second = mapRenderTargetLowering('article', 'test:out-of-order', () => h('second', null));
    try {
      first.dispose();
      t.equal(
        lowerTree(h('article', null), 'test:out-of-order').type,
        'second',
        'removing an older entry leaves the active override intact',
      );
    } finally {
      second.dispose();
      first.dispose();
      target.dispose();
    }
  });
  it('requires targets and restores explicit component names', (t) => {
    function Named() {
      return h('text', null);
    }
    t.throws(
      () => lowerTree(h('text', null), 'test:missing'),
      /Unknown render target 'test:missing'/,
      'an undeclared target fails deterministically',
    );
    const base = nameComponent(Named, 'example.base');
    const override = nameComponent(Named, 'example.override');
    t.equal(componentName(Named), 'example.override', 'the active explicit name wins');
    override.dispose();
    t.equal(componentName(Named), 'example.base', 'disposing restores the previous name');
    base.dispose();
    t.equal(componentName(Named), 'Named', 'disposing all names restores the function name');
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
