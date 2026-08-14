/**
 * fino:ui/components/html — the HTML render target for the component catalog.
 *
 * `toHtml()` transforms a tree of host-neutral primitives (`box`, `text`,
 * `clickable`, `layer`, …) into ordinary HTML VNodes: flexbox `div`s, styled
 * `span`s, `fieldset`/`legend` for titled borders, `button` for clickables.
 * The result serializes with `fino:ui/html`'s `renderToHtml()` — handler
 * props are dropped here, since static markup cannot carry them.
 *
 * Cell geometry maps to character units: widths in `ch`, heights in `lh`, so
 * the proportions a terminal renders survive on the web. `htmlPage()` wraps a
 * transformed tree in a document shell that defines the terminal palette as
 * CSS custom properties.
 *
 * ```ts no_run
 * import { toHtml, htmlPage } from 'fino:ui/components/html';
 * import { renderToHtml } from 'fino:ui/html';
 *
 * const markup = renderToHtml(toHtml(view()));
 * const page = htmlPage(markup, { title: 'Preview' });
 * ```
 */
import { h } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { EMPTY_STYLE, mergeStyle } from 'fino:tty/style';
import type { Color, Style } from 'fino:tty/style';
import { rawHtml, renderToHtml } from 'fino:ui/html';

const NAMED_CSS: Record<string, string> = {
  black: 'var(--tui-black)',
  red: 'var(--tui-red)',
  green: 'var(--tui-green)',
  yellow: 'var(--tui-yellow)',
  blue: 'var(--tui-blue)',
  magenta: 'var(--tui-magenta)',
  cyan: 'var(--tui-cyan)',
  white: 'var(--tui-white)',
  brightBlack: 'var(--tui-bright-black)',
  brightRed: 'var(--tui-bright-red)',
  brightGreen: 'var(--tui-bright-green)',
  brightYellow: 'var(--tui-bright-yellow)',
  brightBlue: 'var(--tui-bright-blue)',
  brightMagenta: 'var(--tui-bright-magenta)',
  brightCyan: 'var(--tui-bright-cyan)',
  brightWhite: 'var(--tui-bright-white)',
  default: 'inherit',
};

function cssColor(color: Color): string {
  if (typeof color === 'string') return NAMED_CSS[color] ?? 'inherit';
  if ('rgb' in color) return `rgb(${color.rgb[0]},${color.rgb[1]},${color.rgb[2]})`;
  return 'var(--tui-bright-black)';
}

function resolveStyle(props: Props): Style {
  let style = EMPTY_STYLE;
  const token = props.style;
  if (Array.isArray(token)) {
    for (const entry of token) style = mergeStyle(style, entry as Style);
  } else if (token && typeof token === 'object') {
    style = mergeStyle(style, token as Style);
  }
  const own: Record<string, unknown> = {};
  if (props.color !== undefined) own.fg = props.color;
  if (props.background !== undefined) own.bg = props.background;
  for (const attr of ['bold', 'dim', 'italic', 'underline', 'inverse', 'strike'] as const) {
    if (typeof props[attr] === 'boolean') own[attr] = props[attr];
  }
  return mergeStyle(style, own as Style);
}

function styleCss(style: Style, css: Record<string, string>): void {
  if (style.fg) css.color = cssColor(style.fg);
  if (style.bg) css.background = cssColor(style.bg);
  if (style.bold) css.fontWeight = 'bold';
  if (style.dim) css.opacity = '0.55';
  if (style.italic) css.fontStyle = 'italic';
  const deco: string[] = [];
  if (style.underline) deco.push('underline');
  if (style.strike) deco.push('line-through');
  if (deco.length > 0) css.textDecoration = deco.join(' ');
  if (style.inverse) {
    css.background = style.fg ? cssColor(style.fg) : 'var(--tui-fg)';
    css.color = style.bg ? cssColor(style.bg) : 'var(--tui-bg)';
  }
}

function num(props: Props, name: string): number | undefined {
  const value = props[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sizeCss(props: Props, css: Record<string, string>): void {
  const width = num(props, 'width');
  const height = num(props, 'height');
  if (width !== undefined) css.width = `${width}ch`;
  if (height !== undefined) css.height = `${height}lh`;
  const minWidth = num(props, 'minWidth');
  const maxWidth = num(props, 'maxWidth');
  const minHeight = num(props, 'minHeight');
  const maxHeight = num(props, 'maxHeight');
  if (minWidth !== undefined) css.minWidth = `${minWidth}ch`;
  if (maxWidth !== undefined) css.maxWidth = `${maxWidth}ch`;
  if (minHeight !== undefined) css.minHeight = `${minHeight}lh`;
  if (maxHeight !== undefined) css.maxHeight = `${maxHeight}lh`;
}

function flexChildCss(props: Props, css: Record<string, string>): void {
  const grow = num(props, 'grow') ?? num(props, 'flex');
  const shrink = num(props, 'shrink');
  const basis = num(props, 'basis');
  if (grow !== undefined || shrink !== undefined || basis !== undefined) {
    css.flex = `${grow ?? 0} ${shrink ?? 0} ${basis !== undefined ? `${basis}ch` : 'auto'}`;
  }
  const alignSelf = props.alignSelf;
  if (typeof alignSelf === 'string') {
    css.alignSelf =
      alignSelf === 'start' ? 'flex-start' : alignSelf === 'end' ? 'flex-end' : alignSelf;
  }
  const margin = num(props, 'margin');
  const marginX = num(props, 'marginX') ?? margin;
  const marginY = num(props, 'marginY') ?? margin;
  if (marginX !== undefined || marginY !== undefined) {
    css.margin = `${marginY ?? 0}lh ${marginX ?? 0}ch`;
  }
}

function justifyCss(value: unknown): string | undefined {
  if (value === 'center') return 'center';
  if (value === 'end') return 'flex-end';
  if (value === 'between') return 'space-between';
  if (value === 'start') return 'flex-start';
  return undefined;
}

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
    css.border = `1px solid ${props.borderColor ? cssColor(props.borderColor as Color) : 'var(--tui-border)'}`;
    css.borderRadius = border === 'round' ? '0.5rem' : '0';
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
  return children.map((child) => (typeof child === 'string' ? child : toHtml(child)));
}

/**
 * Transform a host-neutral primitive tree into HTML VNodes.
 *
 * Handler props (`onClick`, `onKey`, …) are dropped — static HTML cannot
 * carry functions. Nodes that are already HTML elements pass through with
 * their children transformed, so mixed trees keep working.
 */
export function toHtml(node: VNode): VNode {
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

const PAGE_CSS = `
:root {
  --tui-bg: #14161b; --tui-fg: #d8dee9; --tui-border: #3b4252;
  --tui-black: #3b4252; --tui-red: #bf616a; --tui-green: #a3be8c;
  --tui-yellow: #ebcb8b; --tui-blue: #81a1c1; --tui-magenta: #b48ead;
  --tui-cyan: #88c0d0; --tui-white: #d8dee9;
  --tui-bright-black: #667084; --tui-bright-red: #d08770;
  --tui-bright-green: #b5cea0; --tui-bright-yellow: #f0d399;
  --tui-bright-blue: #98b8d8; --tui-bright-magenta: #c9a3bc;
  --tui-bright-cyan: #9fd1de; --tui-bright-white: #eceff4;
}
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--tui-bg); color: var(--tui-fg);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 14px; line-height: 1.4; padding: 1rem;
}
.ui-root { position: relative; min-height: 90vh; }
button { border: none; background: none; padding: 0; }
fieldset { min-width: 0; padding: 0.25lh 1ch; }
legend { padding: 0 0.5ch; opacity: 0.8; }
input { background: transparent; border: 1px solid var(--tui-border); color: inherit; padding: 0 0.5ch; }
a { color: var(--tui-cyan); text-decoration: none; }
a:hover { text-decoration: underline; }
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
