/**
 * fino:ui/components/html — the HTML render target for the component catalog.
 *
 * `toHtml()` transforms a `fino:ui` tree into ordinary HTML VNodes. Semantic
 * `ui:*` nodes lower to native, web-styled markup: `ui:checkbox` becomes a
 * real `<input type="checkbox">`, `ui:details` a `<details><summary>`,
 * `ui:select` a `<select>`, `ui:table` a `<table>`, `ui:file-tree` nested
 * `<details>` — so checkboxes toggle, sections expand, and selects open with
 * zero client JavaScript. Bare primitive trees (`box`, `text`, `clickable`,
 * `layer`, …) keep the flexbox/character-unit mapping so terminal-shaped
 * layouts still survive on the web.
 *
 * By default markup is static and handler props are dropped. Passing
 * `{ actions }` enables server-driven interactions: every handler-bearing
 * semantic node is assigned a sequential action id (`a0`, `a1`, … in tree
 * order), registered on the collector, and emitted as a plain GET `<form>` —
 * click-likes as submit buttons carrying `do=<id>`, value-bearing controls as
 * native inputs named `value` that auto-submit on change. The server renders
 * the same tree, looks up the submitted `do` id, and invokes the handler.
 * Value-bearing controls without a change handler — and click-likes without a
 * click handler — lower as `disabled`, so state the server cannot change is
 * never toggleable in the page.
 *
 * The result serializes with `fino:ui/html`'s `renderToHtml()`; `htmlPage()`
 * wraps transformed markup in a document shell whose stylesheet gives the
 * catalog a native web treatment (system-ui type, rem spacing, the terminal
 * palette as CSS custom properties).
 *
 * ```ts no_run
 * import { toHtml, htmlPage } from 'fino:ui/components/html';
 * import { renderToHtml } from 'fino:ui/html';
 *
 * const markup = renderToHtml(toHtml(view()));
 * const page = htmlPage(markup, { title: 'Preview' });
 * ```
 */
import { h, defineRenderTarget, mapRenderTargetLowering, renderTargetLowering } from 'fino:ui';
import {
  Box,
  Clickable,
  Input,
  Layer,
  Rule,
  Scroll,
  Spacer,
  Text,
} from 'internal:ui/components/primitives';
import {
  actionsActive,
  borderShorthand,
  cssColor,
  flexChildCss,
  setChildTransform,
  justifyCss,
  num,
  resolveStyle,
  sizeCss,
  styleCss,
  tone,
  withActions,
} from 'internal:ui/components/html-runtime';
export type { ActionCollector, ToHtmlOptions } from 'internal:ui/components/html-runtime';
import type { ToHtmlOptions } from 'internal:ui/components/html-runtime';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import type { Color } from 'fino:tty/style';
import { rawHtml, renderToHtml } from 'fino:ui/html';
// The pure helpers a lowering shares with the terminal target — the same
// filter, the same icon names, the same axis ticks — are not part of the
// public `fino:ui/components` surface; they come from the catalog module
// that owns each one.

function boxNode(node: VNode, children: NormalizedChild[]): VNode {
  const props = node.props;
  const css: Record<string, string> = { display: 'flex' };
  css.flexDirection = props.direction === 'row' ? 'row' : 'column';
  if (props.wrap === true) css.flexWrap = 'wrap';
  const justify = justifyCss(props.justify);
  if (justify) css.justifyContent = justify;
  const align = props.align;
  if (typeof align === 'string' && align !== 'stretch') {
    css.alignItems = align === 'start' ? 'flex-start' : align === 'end' ? 'flex-end' : 'center';
  }
  const gap = num(props, 'gap');
  if (gap) {
    css.gap = props.direction === 'row' ? `${gap}ch` : `${gap * 0.5}lh`;
  }
  const padding = num(props, 'padding');
  const paddingX = num(props, 'paddingX') ?? padding;
  const paddingY = num(props, 'paddingY') ?? padding;
  if (paddingX !== undefined || paddingY !== undefined) {
    css.padding = `${(paddingY ?? 0) * 0.5}lh ${paddingX ?? 0}ch`;
  }
  const border = props.border;
  if (border === true || typeof border === 'string') {
    const name = typeof border === 'string' ? border : props.borderStyle;
    const color = props.borderColor ? cssColor(props.borderColor as Color) : 'var(--tui-border)';
    const spec = borderShorthand(name, props.rounded === true, color);
    css.border = spec.border;
    css.borderRadius = spec.radius;
  }
  if (props.overflow === 'hidden') css.overflow = 'hidden';
  sizeCss(props, css);
  flexChildCss(props, css);
  styleCss(resolveStyle(props), css);

  const attrs: Props = { style: css };
  if (typeof props.id === 'string') attrs.id = props.id;
  const title = typeof props.borderTitle === 'string' ? props.borderTitle : undefined;
  if (title !== undefined) {
    return h('fieldset', attrs, h('legend', null, title), ...children);
  }
  const clickable = node.type === 'clickable';
  if (clickable) {
    attrs.type = 'button';
    if (node.props.disabled === true) attrs.disabled = true;
    css.font = 'inherit';
    css.color = css.color ?? 'inherit';
    css.textAlign = 'inherit';
    css.cursor = node.props.disabled === true ? 'default' : 'pointer';
    return h('button', attrs, ...children);
  }
  return h('div', attrs, ...children);
}

function textNode(node: VNode, children: NormalizedChild[]): VNode {
  const props = node.props;
  const css: Record<string, string> = {};
  const wrap = props.wrap;
  if (wrap === true || wrap === 'word') css.whiteSpace = 'pre-wrap';
  else if (wrap === 'char') {
    css.whiteSpace = 'pre-wrap';
    css.wordBreak = 'break-all';
  } else css.whiteSpace = 'pre';
  if (props.truncate === true) {
    css.overflow = 'hidden';
    css.textOverflow = 'ellipsis';
    css.whiteSpace = 'nowrap';
  }
  if (typeof props.align === 'string' && props.align !== 'start') {
    css.textAlign = props.align === 'end' ? 'right' : 'center';
  }
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
  const inner = h('div', { style: css }, ...children);
  if (props.backdrop === true) {
    return h(
      'div',
      {
        style: {
          position: 'absolute',
          inset: '0',
          background: 'rgb(0 0 0 / 0.45)',
          zIndex: '10',
        },
      },
      inner,
    );
  }
  return inner;
}

function transformChildren(children: readonly NormalizedChild[]): NormalizedChild[] {
  return children.map((child) => (typeof child === 'string' ? child : transformNode(child)));
}

/** Collector receiving `id → invoke` pairs during an interactive transform. */

/**
 * Transform a `fino:ui` tree into HTML VNodes.
 *
 * Semantic `ui:*` nodes lower to native markup built from their data —
 * their primitive composition (if any target would use one) is never
 * consulted. Primitive nodes map to flexbox markup, and nodes that are
 * already HTML elements pass through with their children transformed, so
 * mixed trees keep working.
 *
 * Without options the markup is static and handler props are dropped. With
 * `{ actions }`, handler-bearing nodes emit GET forms whose `do=<id>` field
 * names a handler registered on the collector; `{ fields }` rides along as
 * hidden inputs so the round trip lands back on the same page state.
 */
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
  return withActions(state, () => transformNode(node));
}

/**
 * Nodes this walker has already produced.
 *
 * Lowering is a fixpoint — a lowering may emit further components or semantic
 * nodes, and those have to be lowered in turn. Without this, a lowering that
 * transforms its own children would have that subtree walked again by the
 * outer pass, once per level of nesting. Membership is by identity, so only
 * the nodes a lowering newly created get visited.
 */
const walked = new WeakSet<VNode>();

// A lowering chain that never bottoms out is a bug in a lowering, not a deep
// tree; this counts substitutions at one node.
const MAX_LOWERING_DEPTH = 100;

function transformNode(node: VNode): VNode {
  if (walked.has(node)) return node;
  const out = transformUnwalked(node, 0);
  walked.add(out);
  return out;
}

function transformUnwalked(node: VNode, depth: number): VNode {
  if (depth > MAX_LOWERING_DEPTH) {
    throw new Error(
      `HTML lowering for '${String(node.type)}' did not reach markup after ` +
        `${MAX_LOWERING_DEPTH} substitutions — a lowering is probably emitting its own type`,
    );
  }
  // `h()` stores component functions rather than invoking them, so resolve
  // them here: an `'html'` lowering registered for the component wins,
  // otherwise the component's own function is its HTML behaviour.
  if (typeof node.type !== 'string') {
    const impl = renderTargetLowering(node.type, 'html') ?? node.type;
    return substitute(node, impl, depth);
  }
  const elementLowering = renderTargetLowering(node.type, 'html');
  if (elementLowering !== undefined) return substitute(node, elementLowering, depth);
  if (walked.has(node)) return node;
  const children = transformChildren(node.children);
  switch (node.type) {
    case 'fragment':
      return { ...node, children };
    case 'box':
    case 'clickable':
      return boxNode(node, children);
    case 'text':
      return textNode(node, children);
    case 'spacer': {
      const css: Record<string, string> = {};
      sizeCss(node.props, css);
      flexChildCss(node.props, css);
      return h('div', { style: css, 'aria-hidden': 'true' });
    }
    case 'rule':
      return h('hr', {
        style: {
          border: 'none',
          borderTop: '1px solid var(--tui-border)',
          width: '100%',
          margin: '0.25lh 0',
        },
      });
    case 'input': {
      const css: Record<string, string> = { font: 'inherit' };
      styleCss(resolveStyle(node.props), css);
      const attrs: Props = { style: css };
      if (typeof node.props.value === 'string') attrs.value = node.props.value;
      if (typeof node.props.placeholder === 'string') attrs.placeholder = node.props.placeholder;
      return h('input', attrs);
    }
    case 'scrollview': {
      const css: Record<string, string> = {
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
      };
      sizeCss(node.props, css);
      flexChildCss(node.props, css);
      return h('div', { style: css }, ...children);
    }
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

/**
 * Resolve components and semantic nodes inside finished markup.
 *
 * This is the composition half of the fixpoint: a lowering may build its
 * output partly from other components, and those still need lowering, but the
 * element nodes it emitted are already final and must be left exactly as they
 * are. Elements are marked walked on the way back up so the outer pass skips
 * them instead of re-walking the subtree once per level of nesting.
 */
function resolveNested(node: VNode, depth: number): VNode {
  if (walked.has(node)) return node;
  if (typeof node.type !== 'string' || renderTargetLowering(node.type, 'html') !== undefined) {
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
  // A lowering's output is finished markup. Running it back through the
  // element switch would rewrite the real HTML it emitted — `input` and `text`
  // are primitive node names to that switch and genuine element names here,
  // and the hidden fields an `actionForm` emits lose their `type` and `name`
  // to it. Only what the lowering *composed* is revisited.
  const keyed = node.key === null ? composed : { ...composed, key: node.key };
  const resolved = resolveNested(keyed, depth);
  walked.add(resolved);
  return resolved;
}

// Primitives are components, so they resolve through the registry like every
// other component. That is what lets a lowering's output be treated as
// finished markup: with `Box`/`Text`/`Input` reachable by map key, the node
// names `box`/`text`/`input` never arrive here from a component at all, and
// the switch below is left for hand-written trees that spell them directly.
type PrimitiveProps = Props & { children?: NormalizedChild[] };

function asNode(props: PrimitiveProps): { node: VNode; children: NormalizedChild[] } {
  const { children = [], ...rest } = props;
  return { node: { type: '', props: rest, children, key: null }, children };
}

mapRenderTargetLowering(Box, 'html', (props: PrimitiveProps) => {
  const { node, children } = asNode(props);
  return boxNode(node, children);
});
mapRenderTargetLowering(Clickable, 'html', (props: PrimitiveProps) => {
  const { node, children } = asNode(props);
  return boxNode({ ...node, type: 'clickable' }, children);
});
mapRenderTargetLowering(Text, 'html', (props: PrimitiveProps) => {
  const { node, children } = asNode(props);
  return textNode(node, children);
});
mapRenderTargetLowering(Layer, 'html', (props: PrimitiveProps) => {
  const { node, children } = asNode(props);
  return layerNode(node, children);
});
mapRenderTargetLowering(Spacer, 'html', (props: PrimitiveProps) => {
  const css: Record<string, string> = {};
  sizeCss(props, css);
  flexChildCss(props, css);
  return h('div', { style: css, 'aria-hidden': 'true' });
});
mapRenderTargetLowering(Rule, 'html', () =>
  h('hr', {
    style: {
      border: 'none',
      borderTop: '1px solid var(--tui-border)',
      width: '100%',
      margin: '0.25lh 0',
    },
  }),
);
mapRenderTargetLowering(Input, 'html', (props: PrimitiveProps) => {
  const css: Record<string, string> = { font: 'inherit' };
  styleCss(resolveStyle(props), css);
  const attrs: Props = { style: css };
  if (typeof props.value === 'string') attrs.value = props.value;
  if (typeof props.placeholder === 'string') attrs.placeholder = props.placeholder;
  return h('input', attrs);
});
mapRenderTargetLowering(Scroll, 'html', (props: PrimitiveProps) => {
  const { children } = asNode(props);
  const css: Record<string, string> = {
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
  };
  sizeCss(props, css);
  flexChildCss(props, css);
  return h('div', { style: css }, ...children);
});

// The web's vocabulary is open-ended — every HTML tag name is legitimate — so
// the target declares no primitive floor and `transformNode` passes unknown
// element names straight through.
defineRenderTarget('html');

// Hand the walker to the runtime for the one case that needs lowered children.
setChildTransform(transformChildren);

/** Stylesheet for the component classes `toHtml` emits; embed it in page shells. */
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
  --ui-surface: #1a1e26; --ui-surface-2: #232936;
  --ui-border: #2e3440; --ui-border-strong: #3d4452;
  --ui-accent: var(--tui-cyan); --ui-muted: var(--tui-bright-black);
  --ui-danger: var(--tui-red); --ui-success: var(--tui-green);
  --ui-warning: var(--tui-yellow); --ui-info: var(--tui-blue);
  --ui-radius: 0.5rem;
}
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--ui-bg); color: var(--ui-fg);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 15px; line-height: 1.5; padding: 1.5rem;
}
.ui-root { position: relative; min-height: 90vh; }
a { color: var(--ui-accent); text-decoration: none; }
a:hover { text-decoration: underline; }
kbd {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 0.8em;
  border: 1px solid var(--ui-border-strong); border-bottom-width: 2px;
  border-radius: 0.25rem; padding: 0 0.375rem; background: var(--ui-surface);
}
button { border: none; background: none; padding: 0; color: inherit; font: inherit; }
fieldset {
  min-width: 0; border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius); padding: 0.375rem 0.75rem;
}
legend { padding: 0 0.5ch; opacity: 0.8; }
input, select {
  font: inherit; background: var(--ui-surface); color: inherit;
  border: 1px solid var(--ui-border); border-radius: 0.375rem;
  padding: 0.25rem 0.5rem;
}
input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible {
  outline: 2px solid var(--ui-accent); outline-offset: 1px;
}

.ui-panel {
  display: flex; flex-direction: column; gap: 0.5rem;
  background: var(--ui-surface); border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius); padding: 0.875rem 1rem;
}
.ui-panel-title {
  font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--ui-muted);
}
.ui-button {
  display: inline-block; align-self: flex-start;
  padding: 0.375rem 0.875rem; border-radius: 0.375rem;
  border: 1px solid var(--ui-border-strong); background: var(--ui-surface-2);
  cursor: pointer; transition: background 0.1s, border-color 0.1s;
}
.ui-button:hover:not(:disabled) { background: #2b3242; border-color: #4a5264; }
.ui-button:active:not(:disabled) { background: #242a38; }
.ui-button:disabled { opacity: 0.45; cursor: default; }
.ui-choice { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; width: fit-content; }
.ui-choice.is-disabled { opacity: 0.45; cursor: default; }
.ui-check { width: 1rem; height: 1rem; padding: 0; accent-color: var(--ui-accent); cursor: pointer; }
.ui-radio-group { display: flex; flex-direction: column; gap: 0.375rem; }
.ui-switch {
  appearance: none; -webkit-appearance: none; cursor: pointer;
  width: 2.25rem; height: 1.25rem; padding: 0; border: none;
  border-radius: 0.75rem; background: var(--ui-border-strong);
  position: relative; transition: background 0.15s;
}
.ui-switch::before {
  content: ''; position: absolute; top: 0.125rem; left: 0.125rem;
  width: 1rem; height: 1rem; border-radius: 50%;
  background: var(--ui-fg); transition: left 0.15s;
}
.ui-switch:checked { background: var(--ui-accent); }
.ui-switch:checked::before { left: 1.125rem; background: var(--ui-bg); }
.ui-field { min-width: 12rem; }
.ui-field:focus { border-color: var(--ui-accent); }
.ui-details {
  border: 1px solid var(--ui-border); border-radius: var(--ui-radius);
  background: var(--ui-surface); width: fit-content; min-width: 16rem;
}
.ui-details > summary {
  padding: 0.5rem 0.875rem; cursor: pointer; font-weight: 600;
  border-radius: var(--ui-radius); list-style-position: inside;
}
.ui-details > summary:hover { background: var(--ui-surface-2); }
.ui-details-body {
  display: flex; flex-direction: column; gap: 0.375rem;
  padding: 0.25rem 0.875rem 0.75rem;
}
.ui-details:not([open]) .ui-details-body { display: none; }
.ui-tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--ui-border); }
.ui-tab {
  padding: 0.375rem 0.875rem; border-radius: 0.375rem 0.375rem 0 0;
  color: var(--ui-muted);
}
.ui-tab:hover { text-decoration: none; background: var(--ui-surface); color: var(--ui-fg); }
.ui-tab.is-active { color: var(--ui-fg); font-weight: 600; box-shadow: inset 0 -2px 0 var(--ui-accent); }
.ui-tab.is-disabled { opacity: 0.45; pointer-events: none; }
.ui-tab-panel { padding: 0.75rem 0.25rem; }
.ui-menu {
  list-style: none; margin: 0; padding: 0.25rem; min-width: 13rem; width: fit-content;
  border: 1px solid var(--ui-border); border-radius: var(--ui-radius);
  background: var(--ui-surface);
}
.ui-menu-header {
  padding: 0.375rem 0.75rem 0.125rem; font-size: 0.7rem; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--ui-muted);
}
.ui-menu-sep { padding: 0.25rem 0.5rem; }
.ui-menu-sep hr, hr.ui-menu-sep { border: none; border-top: 1px solid var(--ui-border); }
.ui-menu-item button {
  display: flex; align-items: center; gap: 0.5rem; width: 100%;
  text-align: left; padding: 0.375rem 0.75rem; border-radius: 0.375rem; cursor: pointer;
}
.ui-menu-item button:hover:not(:disabled) { background: var(--ui-surface-2); }
.ui-menu-item.is-selected button { background: rgb(136 192 208 / 0.14); font-weight: 600; }
.ui-menu-item.is-disabled button { opacity: 0.45; cursor: default; }
.ui-menu-detail { margin-left: auto; padding-left: 1rem; color: var(--ui-muted); font-size: 0.85em; }
.ui-menu-more { padding: 0.25rem 0.75rem; color: var(--ui-muted); font-size: 0.85em; }
.ui-overlay {
  position: fixed; inset: 0; z-index: 50;
  background: rgb(0 0 0 / 0.55);
  display: flex; align-items: center; justify-content: center;
}
.ui-modal {
  display: flex; flex-direction: column; gap: 0.5rem;
  min-width: 20rem; max-width: 90vw; padding: 1.25rem 1.5rem;
  background: var(--ui-surface); border: 1px solid var(--ui-border-strong);
  border-radius: 0.75rem; box-shadow: 0 20px 50px rgb(0 0 0 / 0.5);
}
.ui-modal-title { font-weight: 600; font-size: 1.05rem; }
.ui-context-menu, .ui-popover {
  position: absolute; z-index: 40; margin-top: 0.25rem; width: fit-content;
}
.ui-popover {
  background: var(--ui-surface); border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius); padding: 0.625rem 0.875rem;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.4);
  display: flex; flex-direction: column; gap: 0.375rem;
}
.ui-tooltip {
  position: absolute; z-index: 40; margin-top: 0.25rem; width: fit-content;
  background: var(--ui-surface-2); border: 1px solid var(--ui-border);
  border-radius: 0.375rem; padding: 0.25rem 0.625rem; font-size: 0.85rem;
}
.ui-toast-stack {
  position: fixed; top: 1rem; right: 1rem; z-index: 60;
  display: flex; flex-direction: column; align-items: flex-end; gap: 0.5rem;
}
.ui-toast {
  width: fit-content; padding: 0.5rem 0.875rem;
  background: var(--ui-surface); border: 1px solid var(--ui-border);
  border-left-width: 3px; border-radius: 0.375rem;
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.35);
}
.ui-toast.ui-tone-info { border-left-color: var(--ui-info); }
.ui-toast.ui-tone-success { border-left-color: var(--ui-success); }
.ui-toast.ui-tone-danger { border-left-color: var(--ui-danger); }
.ui-toast.ui-tone-warning { border-left-color: var(--ui-warning); }
.ui-progress-wrap { display: inline-flex; align-items: center; gap: 0.5rem; }
.ui-progress {
  appearance: none; -webkit-appearance: none;
  width: 12rem; height: 0.5rem; border: none;
  accent-color: var(--ui-accent); background: var(--ui-surface-2);
  border-radius: 0.25rem; overflow: hidden;
}
.ui-progress::-webkit-progress-bar { background: var(--ui-surface-2); border-radius: 0.25rem; }
.ui-progress::-webkit-progress-value { background: var(--ui-accent); border-radius: 0.25rem; }
.ui-progress::-moz-progress-bar { background: var(--ui-accent); border-radius: 0.25rem; }
.ui-progress-percent { color: var(--ui-muted); font-size: 0.85em; }
.ui-spinner {
  display: inline-block; width: 1rem; height: 1rem;
  border: 2px solid var(--ui-border-strong); border-top-color: var(--ui-accent);
  border-radius: 50%; animation: ui-spin 0.8s linear infinite;
}
@keyframes ui-spin { to { transform: rotate(360deg); } }
.ui-badge, .ui-tag {
  display: inline-flex; align-items: center; gap: 0.25rem; width: fit-content;
  padding: 0.125rem 0.625rem; border-radius: 999px;
  font-size: 0.8rem; font-weight: 600;
}
.ui-badge.ui-tone-accent, .ui-tag.ui-tone-accent { background: rgb(136 192 208 / 0.18); color: var(--ui-accent); }
.ui-badge.ui-tone-muted, .ui-tag.ui-tone-muted { background: rgb(102 112 132 / 0.22); color: var(--tui-bright-white); }
.ui-badge.ui-tone-danger, .ui-tag.ui-tone-danger { background: rgb(191 97 106 / 0.2); color: var(--tui-bright-red); }
.ui-badge.ui-tone-success, .ui-tag.ui-tone-success { background: rgb(163 190 140 / 0.2); color: var(--ui-success); }
.ui-badge.ui-tone-warning, .ui-tag.ui-tone-warning { background: rgb(235 203 139 / 0.2); color: var(--ui-warning); }
.ui-tag-remove {
  cursor: pointer; opacity: 0.7; padding: 0 0.125rem; border-radius: 50%;
  font-size: 1em; line-height: 1;
}
.ui-tag-remove:hover { opacity: 1; }
.ui-keyhint { color: var(--ui-muted); }
.ui-keyhint-sep { padding: 0 0.25rem; }
.ui-crumbs { display: flex; align-items: center; gap: 0.5rem; }
.ui-crumbs a { color: var(--ui-muted); }
.ui-crumbs a:hover { color: var(--ui-fg); text-decoration: none; }
.ui-crumbs-sep { color: var(--ui-muted); opacity: 0.6; }
.ui-pager { display: inline-flex; align-items: center; gap: 0.375rem; }
.ui-pager-step { padding: 0.125rem 0.625rem; line-height: 1.4; }
.ui-pager-page { min-width: 2rem; padding: 0.125rem 0.5rem; line-height: 1.4; text-align: center; }
.ui-pager-page.is-current { background: var(--ui-accent); color: var(--tui-bg); border-color: var(--ui-accent); cursor: default; }
.ui-pager-ellipsis { padding: 0 0.25rem; color: var(--ui-muted); }
.ui-steps { display: flex; align-items: center; gap: 1rem; list-style: none; padding: 0; }
.ui-steps li { display: flex; align-items: center; gap: 0.5rem; }
.ui-steps li + li::before {
  content: ''; width: 1.5rem; height: 1px; background: var(--ui-border-strong);
  margin-right: 0.5rem;
}
.ui-step-dot { width: 0.625rem; height: 0.625rem; border-radius: 50%; background: var(--ui-border-strong); }
.ui-steps .is-done .ui-step-dot { background: var(--ui-success); }
.ui-steps .is-current .ui-step-dot { background: var(--ui-accent); box-shadow: 0 0 0 3px rgb(136 192 208 / 0.25); }
.ui-steps .is-current { font-weight: 600; }
.ui-steps .is-upcoming { color: var(--ui-muted); }
.ui-table { border-collapse: collapse; width: fit-content; min-width: 20rem; }
.ui-table th {
  text-align: left; font-weight: 600; padding: 0.375rem 0.875rem;
  border-bottom: 1px solid var(--ui-border-strong);
}
.ui-table td { padding: 0.375rem 0.875rem; border-bottom: 1px solid var(--ui-border); }
.ui-table tbody tr:hover { background: var(--ui-surface); }
.ui-table tr.is-selected td { background: rgb(136 192 208 / 0.14); }
.ui-tree { width: fit-content; min-width: 14rem; }
.ui-tree summary { cursor: pointer; }\n.ui-tree-row { display: flex; align-items: center; gap: 0.375rem; text-align: left; justify-content: flex-start; width: 100%; }\nbutton.ui-tree-row { background: none; border: none; color: inherit; font: inherit; cursor: pointer; }
.ui-tree summary:hover, .ui-tree-leaf:hover { background: var(--ui-surface); }
.ui-tree-children { margin-left: 0.875rem; border-left: 1px solid var(--ui-border); padding-left: 0.5rem; }
.ui-tree .is-selected { background: rgb(136 192 208 / 0.14); font-weight: 600; }
.ui-timeline { list-style: none; padding: 0; display: flex; flex-direction: column; }
.ui-timeline li {
  position: relative; padding: 0 0 0.875rem 1.375rem;
  display: flex; flex-direction: column;
}
.ui-timeline li::before {
  content: ''; position: absolute; left: 0; top: 0.4rem;
  width: 0.625rem; height: 0.625rem; border-radius: 50%;
  background: var(--ui-info);
}
.ui-timeline li:not(:last-child)::after {
  content: ''; position: absolute; left: 0.28rem; top: 1.2rem; bottom: 0;
  width: 1px; background: var(--ui-border);
}
.ui-timeline li.ui-tone-success::before { background: var(--ui-success); }
.ui-timeline li.ui-tone-danger::before { background: var(--ui-danger); }
.ui-timeline li.ui-tone-warning::before { background: var(--ui-warning); }
.ui-timeline-detail { color: var(--ui-muted); font-size: 0.85em; }
.ui-virtual { border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
.ui-action { display: contents; }
button.ui-tab { cursor: pointer; }
.ui-crumbs .ui-crumb { color: var(--ui-muted); }
button.ui-crumb { cursor: pointer; }
button.ui-crumb:hover { color: var(--ui-fg); }
.ui-menu-item button:disabled { cursor: default; }
.ui-check:disabled, .ui-switch:disabled { cursor: default; }
.ui-modal { position: relative; }
.ui-dismiss {
  position: absolute; top: 0.5rem; right: 0.625rem; z-index: 1;
  cursor: pointer; color: var(--ui-muted); line-height: 1;
  padding: 0.125rem 0.375rem; border-radius: 0.25rem;
}
.ui-dismiss:hover { color: var(--ui-fg); background: var(--ui-surface-2); }
.ui-row { display: flex; align-items: center; gap: 0.5rem; }
.ui-icon { display: inline-block; flex: none; }
.ui-expander {
  width: 1em; flex: none; display: inline-flex; justify-content: center;
  color: var(--ui-muted);
}
.ui-expander::before { content: '\\25B8'; }
.ui-expander.is-open::before,
details[open] > summary .ui-expander::before { content: '\\25BE'; }
button.ui-expander { cursor: pointer; }
summary.ui-details-summary { list-style: none; }
summary.ui-details-summary::-webkit-details-marker { display: none; }
summary.ui-details-summary.ui-row { padding: 0.5rem 0.875rem; font-weight: 600; }
.ui-details-toggle {
  width: 100%; text-align: left; font-weight: 600; cursor: pointer;
  padding: 0.5rem 0.875rem; border-radius: var(--ui-radius);
}
.ui-details-toggle:hover { background: var(--ui-surface-2); }
.ui-tree summary { list-style: none; }
.ui-tree summary::-webkit-details-marker { display: none; }
.ui-tree-row { padding: 0.125rem 0.375rem; border-radius: 0.25rem; }
button.ui-tree-icon, button.ui-tree-name { cursor: pointer; text-align: left; font: inherit; }
button.ui-tree-icon:hover { transform: scale(1.1); }
button.ui-tree-name:hover, button.ui-tree-leaf:hover { background: var(--ui-surface); }
button.ui-tree-leaf { width: 100%; cursor: pointer; }
.ui-table .ui-row-select {
  display: block; width: 100%; text-align: inherit;
  cursor: pointer; padding: 0; color: inherit;
}
.ui-heading { font-weight: 700; line-height: 1.3; margin: 1.25rem 0 0.5rem; }
.ui-heading:first-child { margin-top: 0; }
.ui-heading-1 { font-size: 1.75rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--ui-border); }
.ui-heading-2 { font-size: 1.4rem; }
.ui-heading-3 { font-size: 1.15rem; }
.ui-heading-4 { font-size: 1rem; }
.ui-heading-5, .ui-heading-6 { font-size: 0.8rem; color: var(--ui-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.ui-link { color: var(--ui-accent); cursor: pointer; }
.ui-link:hover { text-decoration: underline; }
button.ui-link { background: none; border: none; padding: 0; font: inherit; }
.ui-blockquote {
  margin: 0.5rem 0; padding: 0.25rem 0 0.25rem 0.875rem;
  border-left: 3px solid var(--ui-border-strong); color: var(--ui-muted);
}
.ui-list { margin: 0.5rem 0; padding-left: 1.5rem; display: flex; flex-direction: column; gap: 0.25rem; }
.ui-code { margin: 0.5rem 0; }
.ui-code pre {
  margin: 0; background: var(--ui-surface); border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius); padding: 0.75rem 1rem; overflow-x: auto;
}
.ui-code code {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.85rem; line-height: 1.6;
}
.ui-code-line { display: flex; gap: 1rem; }
.ui-code-num { flex: none; width: 2.25rem; text-align: right; color: var(--ui-muted); user-select: none; }
.ui-code-content { white-space: pre; }
.ui-inline-code {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 0.875em;
  background: var(--ui-surface-2); border: 1px solid var(--ui-border);
  border-radius: 0.25rem; padding: 0.05rem 0.35rem;
}
.tok-keyword { color: var(--ui-accent); }
.tok-string { color: var(--ui-success); }
.tok-number { color: var(--ui-info); }
.tok-comment { color: var(--ui-muted); }
.tok-regexp { color: var(--ui-warning); }
.ui-code-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
  padding: 0.375rem 0.75rem; background: var(--ui-surface-2);
  border: 1px solid var(--ui-border); border-bottom: none;
  border-radius: var(--ui-radius) var(--ui-radius) 0 0;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.8rem; color: var(--ui-muted);
}
.ui-code-bar + pre { border-top-left-radius: 0; border-top-right-radius: 0; }
.ui-code-filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-code { position: relative; }
.ui-copy {
  opacity: 0; flex: none; background: var(--ui-surface);
  border: 1px solid var(--ui-border-strong); border-radius: 0.25rem;
  padding: 0.125rem 0.5rem; font: inherit; font-size: 0.8rem; color: inherit;
  cursor: pointer; transition: opacity 0.1s;
}
/* With no filename bar to sit in, the button floats over the code's top-right. */
.ui-code > .ui-copy { position: absolute; top: 0.375rem; right: 0.375rem; z-index: 1; }
.ui-code:hover .ui-copy, .ui-code:focus-within .ui-copy, .ui-copy:focus-visible { opacity: 1; }
.ui-copy.is-copied { opacity: 1; }
.ui-field { display: flex; flex-direction: column; gap: 0.25rem; width: fit-content; cursor: default; }
.ui-field-wrap { cursor: pointer; }
.ui-field-wrap :is(input, select, textarea, button) { cursor: auto; }
.ui-field-label { font-weight: 600; font-size: 0.85rem; }
.ui-field-required { color: var(--ui-danger); }
.ui-field-hint { color: var(--ui-muted); font-size: 0.8rem; }
.ui-field-error { color: var(--ui-danger); font-size: 0.8rem; }
.ui-fieldset {
  border: 1px solid var(--ui-border); border-radius: var(--ui-radius);
  padding: 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.625rem;
}
.ui-fieldset > legend { padding: 0 0.5ch; color: var(--ui-muted); font-weight: 600; }
.ui-icon-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2rem; height: 2rem; border-radius: 0.375rem;
  border: 1px solid var(--ui-border-strong); background: var(--ui-surface-2); cursor: pointer;
}
.ui-icon-button:hover:not(:disabled) { background: #2b3242; border-color: #4a5264; }
.ui-icon-button:disabled { opacity: 0.45; cursor: default; }
.ui-slider { width: 12rem; accent-color: var(--ui-accent); cursor: pointer; }
.ui-combo { position: relative; display: inline-flex; align-items: center; gap: 0.25rem; }
.ui-combo-toggle {
  border: 1px solid var(--ui-border-strong); background: var(--ui-surface-2);
  border-radius: 0.375rem; padding: 0.25rem 0.5rem; cursor: pointer; color: var(--ui-muted);
}
.ui-combo-popover { top: 100%; left: 0; margin-top: 0.25rem; }
.ui-card {
  display: flex; flex-direction: column; gap: 0.625rem;
  background: var(--ui-surface); border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius); overflow: hidden; width: fit-content; min-width: 16rem;
}
.ui-card-media { width: 100%; }
.ui-card-media img { display: block; width: 100%; max-height: 12rem; object-fit: cover; }
.ui-card-header { display: flex; flex-direction: column; gap: 0.125rem; padding: 0.875rem 1rem 0; }
.ui-card-title { font-size: 1rem; font-weight: 700; margin: 0; }
.ui-card-subtitle { font-size: 0.85rem; color: var(--ui-muted); margin: 0; }
.ui-card-body { padding: 0 1rem; color: var(--ui-fg); }
.ui-card-actions { display: flex; justify-content: flex-end; gap: 0.5rem; padding: 0 1rem 0.875rem; }
.ui-stat { display: flex; flex-direction: column; gap: 0.125rem; margin: 0; width: fit-content; }
.ui-stat dt { color: var(--ui-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
.ui-stat dd {
  margin: 0; font-size: 1.5rem; font-weight: 700;
  display: flex; align-items: baseline; gap: 0.5rem;
}
.ui-stat-hint { font-size: 0.8rem; font-weight: 400; color: var(--ui-muted); }
.ui-stat-trend { font-size: 1rem; }
.ui-stat-trend.ui-tone-success { color: var(--ui-success); }
.ui-stat-trend.ui-tone-danger { color: var(--ui-danger); }
.ui-stat-trend.ui-tone-muted { color: var(--ui-muted); }
.ui-status-dot {
  display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%;
  background: var(--ui-info);
}
.ui-status-dot.ui-tone-success { background: var(--ui-success); }
.ui-status-dot.ui-tone-danger { background: var(--ui-danger); }
.ui-status-dot.ui-tone-warning { background: var(--ui-warning); }
.ui-status-dot.ui-tone-muted { background: var(--ui-muted); }
.ui-status-dot.ui-tone-info { background: var(--ui-info); }
.ui-empty-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0.5rem; text-align: center; padding: 2.5rem 1.5rem; color: var(--ui-muted);
}
.ui-empty-state-icon { font-size: 1.75rem; opacity: 0.7; }
.ui-empty-state-title { margin: 0; font-weight: 600; color: var(--ui-fg); }
.ui-empty-state-desc { margin: 0; font-size: 0.85rem; }
.ui-empty-state-action { margin-top: 0.25rem; }
.ui-hover-card {
  position: absolute; z-index: 40; margin-top: 0.25rem; width: fit-content; max-width: 22rem;
  background: var(--ui-surface); border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius); padding: 0.625rem 0.875rem;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.4);
  display: flex; flex-direction: column; gap: 0.375rem;
}
.ui-hover-card-title { font-weight: 600; }
.ui-fab {
  position: sticky; bottom: 0.75rem; z-index: 20;
  display: flex; gap: 0.5rem; width: 100%; pointer-events: none;
}
.ui-fab > * { pointer-events: auto; }
.ui-fab-start { justify-content: flex-start; }
.ui-fab-center { justify-content: center; }
.ui-fab-end { justify-content: flex-end; }
.ui-calendar-wrap { display: inline-flex; flex-direction: column; gap: 0.5rem; width: fit-content; }
.ui-cal-nav { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.ui-cal-title { font-weight: 600; }
.ui-cal-step {
  border: 1px solid var(--ui-border-strong); background: var(--ui-surface-2);
  border-radius: 0.375rem; padding: 0.125rem 0.625rem; cursor: pointer; color: inherit;
}
.ui-cal-step:disabled { opacity: 0.45; cursor: default; }
.ui-calendar { border-collapse: collapse; }
.ui-calendar th { font-size: 0.75rem; color: var(--ui-muted); font-weight: 600; padding: 0.25rem 0.5rem; }
.ui-cal-cell { padding: 0.125rem; text-align: center; }
.ui-cal-day {
  width: 2rem; height: 2rem; border-radius: 50%; border: none; background: none;
  color: inherit; cursor: pointer; font: inherit;
}
.ui-cal-day:hover:not(:disabled) { background: var(--ui-surface-2); }
.ui-cal-day.is-outside { color: var(--ui-muted); opacity: 0.55; }
.ui-cal-day.is-today { box-shadow: inset 0 0 0 1px var(--ui-accent); }
.ui-cal-day.is-selected { background: var(--ui-accent); color: var(--tui-bg); font-weight: 700; }
.ui-cal-day:disabled { cursor: default; }
.ui-clock { display: inline-flex; align-items: baseline; gap: 0.625rem; }
.ui-clock-time {
  font-size: 2rem; font-weight: 700; font-variant-numeric: tabular-nums;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}
.ui-clock-label { color: var(--ui-muted); font-size: 0.85rem; }
.ui-color-picker { display: inline-flex; align-items: center; gap: 0.625rem; }
.ui-color-input {
  width: 2.25rem; height: 2.25rem; padding: 0.125rem; border-radius: 0.375rem;
  border: 1px solid var(--ui-border-strong); background: var(--ui-surface); cursor: pointer;
}
.ui-color-swatches { display: flex; flex-wrap: wrap; gap: 0.375rem; }
.ui-color-swatch {
  width: 1.5rem; height: 1.5rem; border-radius: 0.3rem; cursor: pointer;
  border: 2px solid transparent; padding: 0;
}
.ui-color-swatch.is-selected { border-color: var(--ui-fg); }
`;

/** Wrap transformed markup in a full HTML document with the palette shell. */
export function htmlPage(body: string, options: { title?: string } = {}): string {
  const title = options.title ?? 'fino ui';
  const head = h(
    'head',
    null,
    h('meta', { charset: 'utf-8' }),
    h('title', null, title),
    h('style', null, rawHtml(PAGE_CSS)),
  );
  const doc = h(
    'html',
    null,
    head,
    h('body', null, h('div', { className: 'ui-root' }, rawHtml(body))),
  );
  return `<!doctype html>${renderToHtml(doc)}`;
}
