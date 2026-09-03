import { describe, it } from 'fino:test/test';
import { defineRenderTarget, h, lowerTree } from 'fino:ui';
import type { Child, Props, VNode } from 'fino:ui';
import { Box, Clickable, Input, Rule, Scroll, Text, styles } from 'fino:ui/components';
import * as tui from 'fino:tty/tui';
import {
  Box as TuiBox,
  Clickable as TuiClickable,
  Input as TuiInputPrimitive,
  Scroll as TuiScroll,
  Text as TuiText,
} from 'fino:tty/tui';
import { htmlPage, pageCss, toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { controlledNativeInput, nativeAction } from 'internal:ui/components/html-runtime';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';
import { createTuiHarness, plainLine } from './tui-harness.ts';

describe('fino:ui/components primitive foundation', () => {
  it('reuses the same primitive exports from the terminal module without aliases', (t) => {
    t.equal(TuiBox, Box, 'Box is one shared component');
    t.equal(TuiText, Text, 'Text is one shared component');
    t.equal(TuiClickable, Clickable, 'Clickable is one shared component');
    t.equal(TuiInputPrimitive, Input, 'Input is one shared component');
    t.equal(TuiScroll, Scroll, 'Scroll is one shared component');
    t.equal('ScrollView' in tui, false, 'the abandoned ScrollView name is not retained');
  });

  it('renders primitive composition and rules through the shared TUI harness', (t) => {
    const app = createTuiHarness(12, 3);
    app.render(
      h(
        Box,
        null,
        h(Text, { style: [styles.bold, styles.accent] }, 'ready'),
        h(Rule, { char: '-', inset: 2 }),
      ),
    );
    t.equal(plainLine(app.lines()[0]!), 'ready', 'text paints through the primitive floor');
    t.equal(plainLine(app.lines()[1]!), '----------', 'rule fills its assigned width minus inset');
    t.ok(app.ansi().includes('\x1b[1;36m'), 'semantic styles reach ANSI output');
  });

  it('shares retained click and key helpers across component tests', (t) => {
    const app = createTuiHarness(12, 2);
    let activations = 0;
    app.render(h(Clickable, { id: 'action', onClick: () => activations++ }, h(Text, null, 'run')));
    app.click(1, 0);
    t.equal(activations, 1, 'click dispatches press and release');
    t.equal(app.key({ key: 'enter' }), true, 'key helper routes to focused content');
    t.equal(activations, 2, 'Enter activates the focused clickable');
  });

  it('lowers primitives to styled HTML without leaking handlers', (t) => {
    const html = renderToHtml(
      toHtml(
        h(
          Box,
          { direction: 'row', gap: 2, padding: 1 },
          h(Text, { style: [styles.bold, styles.accent] }, 'ready'),
          h(Clickable, { onClick: () => {} }, 'go'),
        ),
      ),
    );
    t.ok(html.includes('display:flex'), 'Box maps to flexbox');
    t.ok(html.includes('font-weight:bold'), 'style token maps to CSS');
    t.ok(html.includes('var(--tui-cyan)'), 'semantic color maps to the shared palette');
    t.ok(html.includes('<button'), 'Clickable uses native button semantics');
    t.equal(/onClick|onclick/.test(html), false, 'function props do not enter markup');
  });

  it('extracts normalized children once in the typed lowering helper', (t) => {
    interface LabelProps extends Props {
      prefix: string;
      children?: Child;
    }
    function Label(props: LabelProps): VNode {
      return h('label', props, props.children);
    }
    using target = defineRenderTarget('test:component-helper', { primitives: ['out'] });
    using lowering = mapComponentLowering(Label, 'test:component-helper', (props, children) =>
      h('out', { prefix: props.prefix, childProp: 'children' in props }, ...children),
    );
    const lowered = lowerTree(h(Label, { prefix: 'p' }, 'value'), 'test:component-helper');
    t.equal(lowered.props.prefix, 'p', 'typed props reach the lowering');
    t.equal(lowered.props.childProp, false, 'children are removed from the prop object');
    t.deepEqual(lowered.children, ['value'], 'normalized children use the separate argument');
  });

  it('aggregates co-located CSS fragments once', (t) => {
    registerHtmlCss('.ui-foundation-test { color: tomato; }');
    registerHtmlCss('.ui-foundation-test { color: tomato; }');
    const css = pageCss();
    t.equal(css.split('.ui-foundation-test').length - 1, 1, 'identical fragments are deduplicated');
    t.ok(htmlPage('ok').includes('.ui-foundation-test'), 'the page shell aggregates fragments');
  });

  it('centralizes native value and click action wiring', (t) => {
    let value = '';
    let clicks = 0;
    function Controls(): VNode {
      return h(
        'div',
        null,
        controlledNativeInput(h('input', { value }), (next) => {
          value = next ?? '';
        }),
        nativeAction(h('button', null, 'save'), () => clicks++),
      );
    }
    const tree = h(Controls, null);
    const actions = new Map<string, (value?: string) => void>();
    const html = renderToHtml(toHtml(tree, { actions }));
    t.ok(html.includes('name="value"'), 'controlled inputs share the value field');
    t.ok(html.includes('name="do"'), 'controls share the action id protocol');
    t.equal(actions.size, 2, 'one deterministic action is registered per control');
    actions.get('a0')?.('updated');
    actions.get('a1')?.();
    t.equal(value, 'updated', 'value action decodes through the shared helper');
    t.equal(clicks, 1, 'click action invokes through the shared helper');
    const nextActions = new Map<string, (value?: string) => void>();
    toHtml(tree, { actions: nextActions });
    t.equal(nextActions.size, 2, 'reusing a tree registers actions for each independent walk');
  });
});
