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
import type { NormalizedChild, Props, VNode } from 'fino:ui';
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
  'wbr'
]);
const RAW_HTML = Symbol('fino.ui.html.raw');
export interface RawHtml {
  /**
  * Trusted markup payload consumed by `renderToHtml()`.
  *
  * The symbol key keeps this payload out of ordinary object enumeration.
  */
  readonly [RAW_HTML]: string;
}
/**
* Mark a trusted string as raw HTML.
*
* Raw HTML is inserted without escaping. Only pass strings produced by trusted
* code or an HTML sanitizer.
*
* ```ts no_run
* import { h } from 'fino:ui';
* import { rawHtml, renderToHtml } from 'fino:ui/html';
*
* const html = renderToHtml(h('div', null, rawHtml('<span>ok</span>')));
* ```
*/
export function rawHtml(html: string): RawHtml {
  return { [RAW_HTML]: String(html) };
}
function isRawHtml(value: unknown): value is RawHtml {
  return typeof value === 'object' && value !== null && RAW_HTML in value;
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
    if (typeof value === 'function') throw new TypeError(`Cannot serialize function prop "${rawName}" to HTML`);
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
function renderChild(child: NormalizedChild | RawHtml): string {
  if (isRawHtml(child)) return child[RAW_HTML];
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
export function renderToHtml(vnode: VNode | RawHtml): string {
  if (isRawHtml(vnode)) return vnode[RAW_HTML];
  if (vnode.type === 'fragment') return vnode.children.map(renderChild).join('');
  const attrs = renderAttrs(vnode.props);
  if (VOID_ELEMENTS.has(vnode.type)) return `<${vnode.type}${attrs}>`;
  return `<${vnode.type}${attrs}>${vnode.children.map(renderChild).join('')}</${vnode.type}>`;
}
