/**
 * internal:ui/components/html-runtime — the parts of the web target a
 * component's own HTML rendering needs.
 *
 * The CSS bridge for `fino:tty/style` values, the small prop helpers, and the
 * action machinery that turns a handler prop into a server-driven form. A
 * component imports what it needs from here rather than from
 * `fino:ui/components/html`, which keeps the walker, the stylesheet, and the
 * syntax highlighter out of a tree that only wanted a `<span>`.
 *
 * Nothing here transforms children: a component returns its children as it
 * received them and the walker lowers them afterwards, which is what keeps
 * this module free of a cycle back to the walker.
 *
 * @internal
 */
import { Fragment, h } from 'fino:ui';
import type { Child, NormalizedChild, Props, VNode } from 'fino:ui';
import { EMPTY_STYLE, mergeStyle } from 'fino:tty/style';
import type { Color, Style } from 'fino:tty/style';

export const NAMED_CSS: Record<string, string> = {
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

export function cssColor(color: Color): string {
  if (typeof color === 'string') return NAMED_CSS[color] ?? 'inherit';
  if ('rgb' in color) return `rgb(${color.rgb[0]},${color.rgb[1]},${color.rgb[2]})`;
  return 'var(--tui-bright-black)';
}

export function resolveStyle(props: Props): Style {
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

export function styleCss(style: Style, css: Record<string, string>): void {
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

export function num(props: Props, name: string): number | undefined {
  const value = props[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function sizeCss(props: Props, css: Record<string, string>): void {
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

export function flexChildCss(props: Props, css: Record<string, string>): void {
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

export function borderShorthand(
  style: unknown,
  rounded: boolean,
  color: string,
): { border: string; radius: string } {
  const radius = rounded ? '0.5rem' : '0';
  switch (style) {
    case 'heavy':
      return { border: `3px solid ${color}`, radius };
    case 'double':
      return { border: `4px double ${color}`, radius };
    case 'ascii':
      return { border: `1px dashed ${color}`, radius };
    default:
      return { border: `1px solid ${color}`, radius };
  }
}

export function justifyCss(value: unknown): string | undefined {
  if (value === 'center') return 'center';
  if (value === 'end') return 'flex-end';
  if (value === 'between') return 'space-between';
  if (value === 'start') return 'flex-start';
  return undefined;
}

/** Row height in CSS pixels for anything measured in terminal rows on the web. */
export const VIRTUAL_ROW_PX = 24;

export function emptyNode(): VNode {
  return { type: 'fragment', props: {}, children: [], key: null };
}

// Normalize a raw `Child`-typed prop (e.g. `Card`'s `actions`, `EmptyState`'s
// `action`) the same way JSX children are normalized — flattening arrays and
// dropping `null`/`undefined`/booleans — so it can be transformed and
// spliced into markup like any other child list. `h(Fragment, …)` already
// does exactly this normalization; reusing it here avoids reimplementing it.
export function slotChildren(value: unknown): NormalizedChild[] {
  return h(Fragment, null, value as Child).children;
}

export function idAttr(id: unknown): Props {
  return typeof id === 'string' ? { id } : {};
}

export function tone(variant: unknown, fallback: string): string {
  return `ui-tone-${typeof variant === 'string' ? variant : fallback}`;
}


export interface ActionCollector {
  set(id: string, invoke: (value?: string) => void): unknown;
}

/** Options accepted by `toHtml`. */
export interface ToHtmlOptions {
  /** Collect handler invocations by action id; enables interactive markup. */
  actions?: ActionCollector;
  /** Hidden fields carried by every no-JS GET fallback form. */
  fields?: Record<string, string>;
  /**
   * `fino:ui/web` action descriptor. When given, interactive elements emit
   * POST forms carrying it as their `action` prop — the web client submits
   * them as JSON envelopes and patches the DOM from the SSE response, with
   * no navigation. Without it, forms are plain GET round trips.
   */
  action?: unknown;
}

export interface ActionState {
  collector: ActionCollector;
  fields: Record<string, string>;
  ref: unknown;
  next: number;
}

export let actions: ActionState | null = null;

export function register(invoke: (value?: string) => void): string {
  const id = `a${actions!.next++}`;
  actions!.collector.set(id, invoke);
  return id;
}

export interface FormOptions {
  /** Action id carried as a hidden `do` field (value-bearing forms). */
  act?: string;
  /** Submit when a control changes (auto-submit idiom per wire mode). */
  change?: boolean;
}

export function actionForm(opts: FormOptions, ...children: NormalizedChild[]): VNode {
  const hidden =
    opts.act !== undefined ? [h('input', { type: 'hidden', name: 'do', value: opts.act })] : [];
  if (actions!.ref !== undefined && actions!.ref !== null) {
    // The web client reads the envelope from these reserved fields when a
    // form was server-rendered rather than mounted from a portable tree.
    const ref = actions!.ref as {
      url: string;
      view: string;
      revision: number;
      request: string;
      action?: string;
    };
    // The client's submit/change listeners intercept only forms whose
    // data-fi-action is truthy; without it the browser navigates natively
    // and the CSRF gate rejects the post.
    const props: Props = {
      action: ref.url,
      method: 'post',
      className: 'ui-action',
      'data-fi-action': ref.action ?? 'invoke',
    };
    if (opts.change === true) props['data-fi-change'] = '1';
    return h(
      'form',
      props,
      h('input', { type: 'hidden', name: '_view', value: ref.view }),
      h('input', { type: 'hidden', name: '_ver', value: String(ref.revision) }),
      h('input', { type: 'hidden', name: '_nonce', value: ref.request }),
      ...hidden,
      ...children,
    );
  }
  return h(
    'form',
    { method: 'get', className: 'ui-action' },
    ...Object.entries(actions!.fields).map(([name, value]) =>
      h('input', { type: 'hidden', name, value }),
    ),
    ...hidden,
    ...children,
  );
}

export const RESUBMIT = 'this.form.submit()';

// In web-action mode the client's change listener drives submission; the
// inline handler would bypass it (form.submit() skips submit events).
export function changeAttrs(): Props {
  return actions!.ref !== undefined && actions!.ref !== null ? {} : { onchange: RESUBMIT };
}

export function handlerOf<T>(value: unknown): T | undefined {
  return typeof value === 'function' ? (value as T) : undefined;
}

export const ARIA_CONTROL_TYPES = new Set(['input', 'select', 'textarea']);

// Finds the first native form control among a field's transformed children
// and merges `attrs` onto it — the only way to wire `aria-invalid`/
// `aria-describedby` onto a control `Field` does not own and cannot know the
// shape of. Stops at the first match, matching the "the control" (singular)
// framing of one field around one control.
/**
 * Lower a child list the way the active target would.
 *
 * Almost nothing needs this: a component hands its children back untouched and
 * the walker lowers them afterwards. `Field` is the exception — it rewrites the
 * *first native control* among its descendants to carry `aria-invalid` and
 * `aria-describedby`, and it can only recognise one by element name, which
 * exists only after lowering. The walker injects itself here rather than being
 * imported, because importing it would close a cycle back through the module
 * that owns every component's markup.
 */
let childTransform: ((children: NormalizedChild[]) => NormalizedChild[]) | null = null;

export function setChildTransform(fn: (children: NormalizedChild[]) => NormalizedChild[]): void {
  childTransform = fn;
}

export function lowerChildren(children: NormalizedChild[]): NormalizedChild[] {
  return childTransform === null ? children : childTransform(children);
}

export function injectFirstControlAria(
  nodes: NormalizedChild[],
  attrs: Props,
): { nodes: NormalizedChild[]; applied: boolean } {
  let applied = false;
  const out = nodes.map((node) => {
    if (applied || typeof node === 'string') return node;
    if (ARIA_CONTROL_TYPES.has(node.type)) {
      applied = true;
      return { ...node, props: { ...node.props, ...attrs } };
    }
    const nested = injectFirstControlAria(node.children, attrs);
    if (!nested.applied) return node;
    applied = true;
    return { ...node, children: nested.nodes };
  });
  return { nodes: out, applied };
}

export function inlineStyleAttrs(rest: Props, id: unknown): Props {
  const css: Record<string, string> = {};
  styleCss(resolveStyle(rest as Props), css);
  const attrs: Props = { ...idAttr(id) };
  if (Object.keys(css).length > 0) attrs.style = css;
  return attrs;
}

export const SAFE_HREF_SCHEME = /^(?:https?|mailto|tel):/i;
export const SAFE_HREF_RELATIVE = /^(?:\/|\.\/|\.\.\/|#|\?)/;

/**
 * Validate a `Link` `href` before it reaches markup. Browsers ignore ASCII
 * control characters (tabs, newlines, NUL) inside a URL scheme, so
 * `java\tscript:` parses as `javascript:` — control characters are stripped
 * first so that bypass can't slip past the scheme check. Returns the
 * cleaned href when it is `http(s):`, `mailto:`, `tel:`, or a relative form
 * (`/…`, `./…`, `../…`, `#…`, `?…`); anything else — including unrecognized
 * schemes — returns `undefined`.
 */
export function safeHref(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- stripping is the point
  const cleaned = raw.replace(/[\x00-\x1f\x7f]+/g, '').trim();
  if (cleaned.length === 0) return undefined;
  if (SAFE_HREF_RELATIVE.test(cleaned) || SAFE_HREF_SCHEME.test(cleaned)) return cleaned;
  return undefined;
}

// `Link` is the one catalog component allowed to navigate: a bare `href`
// becomes a real anchor, once it passes `safeHref`. With `onActivate` (and
// no collector wiring an action) it degrades to a link-styled, inert-looking
// button — same as any other handler-less control. With both, the href
// rides on the anchor for right-click/open-in-new-tab, but an inline
// handler intercepts the click and submits the action form instead of
// navigating. A rejected href never reaches markup — the link still renders

/**
 * Run `fn` with an action context installed.
 *
 * The context is ambient rather than threaded because a lowering deep in a
 * tree needs `register()` without every intermediate signature carrying it.
 * Ids are assigned in visit order and re-derived by rendering the same tree
 * again, so the walk order is part of the contract.
 */
export function withActions<T>(state: ActionState | null, fn: () => T): T {
  if (state === null) return fn();
  const previous = actions;
  actions = state;
  try {
    return fn();
  } finally {
    actions = previous;
  }
}

/** Whether an action context is installed, i.e. whether markup may be interactive. */
export function actionsActive(): boolean {
  return actions !== null;
}
