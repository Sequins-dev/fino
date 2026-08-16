/** @jsxImportSource fino:ui */
/**
 * The lowering registry is open in both directions.
 *
 * Everything here is defined outside the framework: a component the catalog
 * has never heard of, and a render target that is not `tui` or `html`. If
 * either of those needed a change inside `fino:ui` to participate, these tests
 * would not compile.
 */
import { describe, it } from 'fino:test/test';
import {
  defineRenderTarget,
  h,
  lowerTree,
  mapRenderTargetLowering,
  type Child,
  type VNode,
} from 'fino:ui';
import { Badge, Panel, Text } from 'fino:ui/components';
import { toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { layoutFrame } from 'fino:tty/tui';
import { frameToAnsi } from 'fino:tty/frame';

/** A component the catalog does not know about. */
function Gauge(props: { label: string; value: number }): VNode {
  return h('div', { className: 'gauge' }, `${props.label}: ${props.value}%`);
}

/** A render target the framework does not know about. */
defineRenderTarget('test:braille', { primitives: ['dots', 'fragment'] });

mapRenderTargetLowering(Gauge, 'test:braille', (props: { label: string; value: number }) =>
  h('dots', { pattern: '⣿'.repeat(Math.round(props.value / 25)) }, props.label),
);

describe('fino:ui lowering registry is open', () => {
  it('renders an out-of-tree component in the built-in targets', (t) => {
    const html = renderToHtml(toHtml(h(Gauge, { label: 'disk', value: 60 })));
    t.equal(html, '<div class="gauge">disk: 60%</div>', 'the default render is the web form');
  });

  it('lets an out-of-tree target lower an out-of-tree component', (t) => {
    const lowered = lowerTree(h(Gauge, { label: 'disk', value: 75 }), 'test:braille');
    t.equal(lowered.type, 'dots', 'the registered lowering replaced the default');
    t.equal(lowered.props.pattern, '⣿⣿⣿', 'it saw the same props');
    t.deepEqual(lowered.children, ['disk'], 'and produced its own children');
  });

  it('lets an out-of-tree target lower components it did not write', (t) => {
    // Badge ships in the catalog and knows nothing about this target.
    mapRenderTargetLowering(Badge, 'test:braille', (props: { label: string }) =>
      h('dots', { pattern: '⠿' }, props.label),
    );
    const lowered = lowerTree(h(Badge, { label: 'ready' }), 'test:braille');
    t.equal(lowered.type, 'dots', 'a catalog component lowered for a foreign target');
    t.deepEqual(lowered.children, ['ready'], 'carrying its own label');
  });

  it('refuses a node the foreign target has no lowering for', (t) => {
    t.throws(
      () => lowerTree(h(Panel, { title: 'nope' }), 'test:braille'),
      /No 'test:braille' lowering for/,
      'the primitive floor names the node and the target',
    );
  });

  it('lets an application override a catalog lowering for a built-in target', (t) => {
    function Loud(props: { children?: Child }): VNode {
      return h('span', null, props.children as Child);
    }
    mapRenderTargetLowering(Loud, 'tui', (props: { children?: Child }) => (
      <Text bold>{props.children}</Text>
    ));
    const frame = frameToAnsi(
      layoutFrame(h(Loud, null, 'shout'), { width: 10, height: 1 }),
    );
    t.ok(frame.includes('shout'), 'the terminal used the registered override');
    t.ok(frame.includes('[1m'), 'with the bold attribute the lowering asked for');
  });
});
