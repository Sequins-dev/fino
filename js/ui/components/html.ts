/**
 * fino:ui/components/html — HTML target for the host-neutral component catalog.
 *
 * `toHtml()` resolves components and primitives into ordinary HTML VNodes.
 * `htmlPage()` wraps serialized markup in a document shell and combines the
 * base palette with CSS fragments registered beside component families.
 *
 * ```ts no_run
 * import { Box, Text } from 'fino:ui/components';
 * import { htmlPage, toHtml } from 'fino:ui/components/html';
 * import { renderToHtml } from 'fino:ui/html';
 *
 * const body = renderToHtml(toHtml(Box({ children: Text({ children: 'ready' }) })));
 * console.log(htmlPage(body));
 * ```
 */
import { defineRenderTarget, h, renderTargetLowering } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { rawHtml, renderToHtml } from 'fino:ui/html';
import type { Color } from 'fino:tty/style';
import { Box, Clickable, Input, Layer, Rule, Scroll, Spacer, Text } from 'fino:ui/components';
import {
  actionsActive,
  cssColor,
  flexChildCss,
  justifyCss,
  num,
  resolveStyle,
  sizeCss,
  styleCss,
  withActions,
} from 'internal:ui/components/html-runtime';
import { mapComponentLowering, registeredHtmlCss } from 'internal:ui/components/target';
import type { ToHtmlOptions } from 'internal:ui/components/html-runtime';
import 'internal:ui/components/icons.html';
import 'internal:ui/components/layout.html';
import 'internal:ui/components/typography.html';
import 'internal:ui/components/forms.html';

export type { ActionCollector, ToHtmlOptions } from 'internal:ui/components/html-runtime';

function boxNode(node: VNode, children: NormalizedChild[]): VNode {
  const props = node.props;
  const css: Record<string, string> = {
    display: 'flex',
    flexDirection: props.direction === 'row' ? 'row' : 'column',
  };
  if (props.wrap === true) css.flexWrap = 'wrap';
  const justify = justifyCss(props.justify);
  if (justify) css.justifyContent = justify;
  if (props.align === 'start') css.alignItems = 'flex-start';
  else if (props.align === 'end') css.alignItems = 'flex-end';
  else if (props.align === 'center') css.alignItems = 'center';
  const gap = num(props, 'gap');
  if (gap !== undefined) css.gap = props.direction === 'row' ? `${gap}ch` : `${gap}lh`;
  const padding = num(props, 'padding');
  const paddingX = num(props, 'paddingX') ?? padding;
  const paddingY = num(props, 'paddingY') ?? padding;
  if (paddingX !== undefined || paddingY !== undefined) {
    css.padding = `${paddingY ?? 0}lh ${paddingX ?? 0}ch`;
  }
  if (props.border === true || typeof props.border === 'string') {
    const color = props.borderColor ? cssColor(props.borderColor as Color) : 'var(--tui-border)';
    const kind = typeof props.border === 'string' ? props.border : props.borderStyle;
    css.border = `${kind === 'heavy' ? 3 : kind === 'double' ? 4 : 1}px ${
      kind === 'double' ? 'double' : kind === 'ascii' ? 'dashed' : 'solid'
    } ${color}`;
  }
  if (props.overflow === 'hidden') css.overflow = 'hidden';
  sizeCss(props, css);
  flexChildCss(props, css);
  styleCss(resolveStyle(props), css);
  const attrs: Props = { style: css };
  if (typeof props.id === 'string') attrs.id = props.id;
  if (node.type === 'clickable') {
    attrs.type = 'button';
    if (props.disabled === true) attrs.disabled = true;
    css.font = 'inherit';
    css.color = css.color ?? 'inherit';
    css.textAlign = 'inherit';
    css.cursor = props.disabled === true ? 'default' : 'pointer';
    return h('button', attrs, ...children);
  }
  return h('div', attrs, ...children);
}

function textNode(node: VNode, children: NormalizedChild[]): VNode {
  const props = node.props;
  const css: Record<string, string> = {};
  if (props.wrap === true || props.wrap === 'word') css.whiteSpace = 'pre-wrap';
  else if (props.wrap === 'char') {
    css.whiteSpace = 'pre-wrap';
    css.wordBreak = 'break-all';
  } else css.whiteSpace = 'pre';
  if (props.truncate === true) {
    css.overflow = 'hidden';
    css.textOverflow = 'ellipsis';
    css.whiteSpace = 'nowrap';
  }
  if (props.align === 'center') css.textAlign = 'center';
  else if (props.align === 'end') css.textAlign = 'right';
  sizeCss(props, css);
  flexChildCss(props, css);
  styleCss(resolveStyle(props), css);
  const attrs: Props = { style: css };
  if (typeof props.id === 'string') attrs.id = props.id;
  return h('span', attrs, ...children);
}

function layerNode(node: VNode, children: NormalizedChild[]): VNode {
  const props = node.props;
  const css: Record<string, string> = { position: 'absolute', zIndex: '10' };
  const anchor = props.anchor as { x: number; y: number } | undefined;
  if (anchor) {
    css.left = `${Math.max(0, anchor.x)}ch`;
    css.top = `${Math.max(0, anchor.y + 1)}lh`;
  } else {
    css.inset = '0';
    css.margin = 'auto';
    css.width = 'fit-content';
    css.height = 'fit-content';
  }
  sizeCss(props, css);
  return h('div', { style: css }, ...children);
}

function spacerNode(props: Props): VNode {
  const css: Record<string, string> = {};
  sizeCss(props, css);
  flexChildCss(props, css);
  return h('div', { style: css, 'aria-hidden': 'true' });
}

function ruleNode(): VNode {
  return h('hr', {
    style: { border: 'none', borderTop: '1px solid var(--tui-border)', width: '100%' },
  });
}

function inputNode(props: Props): VNode {
  const css: Record<string, string> = { font: 'inherit' };
  styleCss(resolveStyle(props), css);
  const attrs: Props = { style: css };
  if (typeof props.value === 'string') attrs.value = props.value;
  if (typeof props.placeholder === 'string') attrs.placeholder = props.placeholder;
  if (typeof props.id === 'string') attrs.id = props.id;
  if (typeof props['aria-invalid'] === 'string') attrs['aria-invalid'] = props['aria-invalid'];
  if (typeof props['aria-describedby'] === 'string') {
    attrs['aria-describedby'] = props['aria-describedby'];
  }
  return h('input', attrs);
}

function scrollNode(props: Props, children: NormalizedChild[]): VNode {
  const css: Record<string, string> = {
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
  };
  sizeCss(props, css);
  flexChildCss(props, css);
  return h('div', { style: css }, ...children);
}

function transformChildren(children: readonly NormalizedChild[]): NormalizedChild[] {
  return children.map((child) => (typeof child === 'string' ? child : transformNode(child)));
}

let walked = new WeakSet<VNode>();
const MAX_LOWERING_DEPTH = 100;

function transformNode(node: VNode): VNode {
  if (walked.has(node)) return node;
  const out = transformUnwalked(node, 0);
  walked.add(out);
  return out;
}

function transformUnwalked(node: VNode, depth: number): VNode {
  if (depth > MAX_LOWERING_DEPTH) {
    throw new Error(`HTML lowering for '${String(node.type)}' did not reach markup`);
  }
  if (typeof node.type !== 'string') {
    return substitute(node, renderTargetLowering(node.type, 'html') ?? node.type, depth);
  }
  const lowering = renderTargetLowering(node.type, 'html');
  if (lowering) return substitute(node, lowering, depth);
  const children = transformChildren(node.children);
  switch (node.type) {
    case 'fragment':
      return { ...node, children };
    case 'box':
    case 'clickable':
      return boxNode(node, children);
    case 'text':
      return textNode(node, children);
    case 'spacer':
      return spacerNode(node.props);
    case 'rule':
      return ruleNode();
    case 'input':
      return inputNode(node.props);
    case 'scrollview':
      return scrollNode(node.props, children);
    case 'layer':
      return layerNode(node, children);
    default: {
      const props: Props = {};
      for (const [name, value] of Object.entries(node.props)) {
        if (typeof value !== 'function') props[name] = value;
      }
      return { type: node.type, props, children, key: node.key };
    }
  }
}

function resolveNested(node: VNode, depth: number): VNode {
  if (walked.has(node)) return node;
  if (typeof node.type !== 'string' || renderTargetLowering(node.type, 'html')) {
    return transformUnwalked(node, depth + 1);
  }
  let changed = false;
  const children = node.children.map((child) => {
    if (typeof child === 'string') return child;
    const next = resolveNested(child, depth);
    if (next !== child) changed = true;
    return next;
  });
  const out = changed ? { ...node, children } : node;
  walked.add(out);
  return out;
}

function substitute(node: VNode, impl: (props: Props) => VNode, depth: number): VNode {
  const composed = impl({ ...node.props, children: node.children });
  const keyed = node.key === null ? composed : { ...composed, key: node.key };
  const resolved = resolveNested(keyed, depth);
  walked.add(resolved);
  return resolved;
}

mapComponentLowering(Box, 'html', (props, children) =>
  boxNode({ type: 'box', props, children, key: null }, children),
);
mapComponentLowering(Clickable, 'html', (props, children) =>
  boxNode({ type: 'clickable', props, children, key: null }, children),
);
mapComponentLowering(Text, 'html', (props, children) =>
  textNode({ type: 'text', props, children, key: null }, children),
);
mapComponentLowering(Layer, 'html', (props, children) =>
  layerNode({ type: 'layer', props, children, key: null }, children),
);
mapComponentLowering(Spacer, 'html', (props) => spacerNode(props));
mapComponentLowering(Rule, 'html', ruleNode);
mapComponentLowering(Input, 'html', inputNode);
mapComponentLowering(Scroll, 'html', scrollNode);

defineRenderTarget('html');

/** Transform a component tree into ordinary HTML VNodes. */
export function toHtml(node: VNode, options: ToHtmlOptions = {}): VNode {
  const state =
    options.actions !== undefined && !actionsActive()
      ? {
          collector: options.actions,
          fields: options.fields ?? {},
          ref: options.action ?? null,
          next: 0,
        }
      : null;
  return withActions(state, () => {
    // Walk markers belong to one traversal. Reusing a VNode with a different
    // action collector must lower and register it again.
    const previous = walked;
    walked = new WeakSet<VNode>();
    try {
      return transformNode(node);
    } finally {
      walked = previous;
    }
  });
}

/** Base palette and primitive styles included in every generated page. */
export const PAGE_CSS = `
:root {
  --tui-bg: #14161b; --tui-fg: #d8dee9; --tui-border: #3b4252;
  --tui-black: #3b4252; --tui-red: #bf616a; --tui-green: #a3be8c;
  --tui-yellow: #ebcb8b; --tui-blue: #81a1c1; --tui-magenta: #b48ead;
  --tui-cyan: #88c0d0; --tui-white: #d8dee9;
  --tui-bright-black: #667084; --tui-bright-red: #d08770;
  --tui-bright-green: #b5cea0; --tui-bright-yellow: #f0d399;
  --tui-bright-blue: #98b8d8; --tui-bright-magenta: #c9a3bc;
  --tui-bright-cyan: #9fd1de; --tui-bright-white: #eceff4;
  --ui-bg: var(--tui-bg); --ui-fg: var(--tui-fg);
  --ui-surface: #1a1e26; --ui-border: #2e3440; --ui-accent: var(--tui-cyan);
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.5rem; background: var(--ui-bg); color: var(--ui-fg);
  font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
}
.ui-root { position: relative; min-height: 90vh; }
.ui-action { display: contents; }
button { border: none; background: none; padding: 0; color: inherit; font: inherit; }
input { font: inherit; }
`;

/** Aggregate base CSS with fragments registered by loaded component families. */
export function pageCss(): string {
  const families = registeredHtmlCss();
  return families.length === 0 ? PAGE_CSS : `${PAGE_CSS}\n${families}\n`;
}

/** Wrap serialized component markup in a complete HTML document. */
export function htmlPage(body: string, options: { title?: string } = {}): string {
  const head = h(
    'head',
    null,
    h('meta', { charset: 'utf-8' }),
    h('title', null, options.title ?? 'fino ui'),
    h('style', null, rawHtml(pageCss())),
  );
  const doc = h(
    'html',
    null,
    head,
    h('body', null, h('div', { className: 'ui-root' }, rawHtml(body))),
  );
  return `<!doctype html>${renderToHtml(doc)}`;
}
