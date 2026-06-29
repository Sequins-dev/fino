/**
* Benchmarks for fino:ui
*
* Run with: cargo run -- bench benchmarks/ui.bench.ts
*/
import { bench } from 'fino:bench';
import { createRenderer, createSignal, h } from 'fino:ui';
const tree = h('row', null, h('cell', {
  key: 'a',
  value: 1
}, 'a'), h('cell', {
  key: 'b',
  value: 2
}, 'b'), h('cell', {
  key: 'c',
  value: 3
}, 'c'));
const reordered = h('row', null, h('cell', {
  key: 'c',
  value: 4
}, 'c'), h('cell', {
  key: 'a',
  value: 1
}, 'a'), h('cell', {
  key: 'b',
  value: 2
}, 'b'));
bench('ui', (b) => {
  b.measure('h tree', () => h('row', null, h('cell', { key: 'a' }, 'a'), h('cell', { key: 'b' }, 'b')));
  b.measure('signal batched writes', () => {
    const signal = createSignal(0);
    signal.subscribe(() => {});
    signal.set(1);
    signal.set(2);
  });
  b.measure('keyed reconcile', {
    setup() {
      const root = { children: [] as any[] };
      const renderer = createRenderer({
        createNode(type, props) {
          return {
            type,
            props,
            children: [] as any[]
          };
        },
        createText(text) {
          return {
            type: '#text',
            text,
            children: [] as any[]
          };
        },
        updateNode(node, props) {
          node.props = props;
        },
        setText(node, text) {
          node.text = text;
        },
        insertChild(parent, child, index) {
          parent.children.splice(index, 0, child);
        },
        moveChild(parent, child, index) {
          const from = parent.children.indexOf(child);
          if (from >= 0) parent.children.splice(from, 1);
          parent.children.splice(index, 0, child);
        },
        removeChild(parent, child) {
          const from = parent.children.indexOf(child);
          if (from >= 0) parent.children.splice(from, 1);
        }
      });
      renderer.render(tree, root);
      return {
        renderer,
        root,
        flip: false
      };
    },
    fn(ctx) {
      ctx.flip = !ctx.flip;
      ctx.renderer.render(ctx.flip ? reordered : tree, ctx.root);
    }
  });
});
