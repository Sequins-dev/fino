/**
 * fino:ui/html — render host-neutral Fino VNodes to HTML strings.
 *
 * This module is the server-side serializer for `fino:ui` trees. It does not
 * retain component state or reconcile trees; each call walks the supplied VNode
 * and returns a complete HTML string. Use it for server-rendered pages, emails,
 * and server-driven UI regions that will be patched into a browser later.
 *
 * ## Design
 *
 * Text and attribute values are escaped with `fino:template`'s HTML escaping.
 * Boolean attributes render only when true, `className` maps to `class`, style
 * objects become CSS declarations, and function props throw because server HTML
 * cannot preserve event handlers. `rawHtml()` is the explicit escape hatch for
 * trusted markup.
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import { renderToHtml } from 'fino:ui/html';
 *
 * const html = renderToHtml(<button disabled>Save</button>);
 * ```
 */
import { escapeHtml } from 'fino:template';
import type { NormalizedChild, Props, Sink, VNode } from 'fino:ui';

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Element type carrying pre-rendered markup.
 *
 * The name is namespaced so it cannot collide with an HTML tag, and a host that
 * does not trust its trees can refuse this type by name.
 */
export const RAW_HTML_TYPE = 'ui:raw';

/**
 * Mark a trusted string as raw HTML.
 *
 * Raw HTML is inserted without escaping. Only pass strings produced by trusted
 * code or an HTML sanitizer.
 *
 * The result is an ordinary VNode holding plain JSON props, so pre-rendered
 * markup survives serialization the same as any other node: it can cross a
 * realm boundary, ride the portable protocol, and be rejected by name on a host
 * that will not inline markup.
 *
 * ```ts no_run
 * import { h } from 'fino:ui';
 * import { rawHtml, renderToHtml } from 'fino:ui/html';
 *
 * const html = renderToHtml(h('div', null, rawHtml('<span>ok</span>')));
 * ```
 */
export function rawHtml(html: string): VNode {
  return {
    type: RAW_HTML_TYPE,
    props: { html: String(html) },
    children: [],
    key: null,
  };
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function renderStyle(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('style prop must be a string or object');
  }
  const out: string[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined || raw === false) continue;
    out.push(`${kebab(key)}:${String(raw)}`);
  }
  return out.join(';');
}

function renderAttrs(props: Props): string {
  let out = '';
  for (const [rawName, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function')
      throw new TypeError(`Cannot serialize function prop "${rawName}" to HTML`);
    const name = rawName === 'className' ? 'class' : rawName;
    if (name === 'key' || name === 'children') continue;
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    const attrValue = name === 'style' ? renderStyle(value) : String(value);
    out += ` ${name}="${escapeHtml(attrValue)}"`;
  }
  return out;
}

function renderChild(child: NormalizedChild): string {
  if (typeof child === 'string') return escapeHtml(child);
  return renderToHtml(child);
}

/**
 * Render one Fino UI VNode to an HTML string.
 *
 * The serializer accepts trees produced by `h()` or the JSX runtime. Fragments
 * render their children without a wrapper. Void elements never receive closing
 * tags.
 *
 * Text and attribute values are escaped. Function-valued props throw because
 * they cannot be represented in static HTML; use server-driven actions or a
 * client runtime rather than embedding handlers.
 *
 * ```ts no_run
 * import { h } from 'fino:ui';
 * import { renderToHtml } from 'fino:ui/html';
 *
 * const html = renderToHtml(h('input', { name: 'q', value: 'a&b' }));
 * ```
 */
export function renderToHtml(vnode: VNode): string {
  if (vnode.type === RAW_HTML_TYPE) return String(vnode.props.html ?? '');
  if (vnode.type === 'fragment') return vnode.children.map(renderChild).join('');
  const attrs = renderAttrs(vnode.props);
  if (VOID_ELEMENTS.has(vnode.type)) return `<${vnode.type}${attrs}>`;
  return `<${vnode.type}${attrs}>${vnode.children.map(renderChild).join('')}</${vnode.type}>`;
}

/**
 * Sink that serializes each committed tree to an HTML string.
 *
 * Pair it with `renderStatic()` for a page built once, or with `createRoot()`
 * when a caller wants fresh markup on every state change.
 *
 * ```ts no_run
 * import { h, renderStatic } from 'fino:ui';
 * import { htmlSink } from 'fino:ui/html';
 *
 * const html = renderStatic(() => h('main', null, 'Ready'), htmlSink());
 * ```
 */
export function htmlSink(): Sink<string> {
  return {
    commit(tree: VNode): string {
      return renderToHtml(tree);
    },
  };
}
