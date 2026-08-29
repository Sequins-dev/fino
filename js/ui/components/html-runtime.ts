/**
 * Shared HTML-target mechanics for component-family lowerings.
 *
 * This module owns style conversion and server-action wiring so semantic
 * families do not implement parallel form protocols.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { EMPTY_STYLE, mergeStyle } from 'fino:tty/style';
import type { Color, Style } from 'fino:tty/style';

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

/** Convert a terminal color to its HTML CSS equivalent. */
export function cssColor(color: Color): string {
  if (typeof color === 'string') return NAMED_CSS[color] ?? 'inherit';
  if ('rgb' in color) return `rgb(${color.rgb[0]},${color.rgb[1]},${color.rgb[2]})`;
  return 'var(--tui-bright-black)';
}

/** Merge token and individual style props into one terminal-style value. */
export function resolveStyle(props: Props): Style {
  let style = EMPTY_STYLE;
  const token = props.style;
  if (Array.isArray(token)) {
    for (const entry of token) style = mergeStyle(style, entry as Style);
  } else if (token && typeof token === 'object') {
    style = mergeStyle(style, token as Style);
  }
  const own: Style = {};
  if (props.color !== undefined) own.fg = props.color as Color;
  if (props.background !== undefined) own.bg = props.background as Color;
  for (const attr of ['bold', 'dim', 'italic', 'underline', 'inverse', 'strike'] as const) {
    if (typeof props[attr] === 'boolean') own[attr] = props[attr];
  }
  return mergeStyle(style, own);
}

/** Apply a terminal style value to a mutable CSS declaration object. */
export function styleCss(style: Style, css: Record<string, string>): void {
  if (style.fg) css.color = cssColor(style.fg);
  if (style.bg) css.background = cssColor(style.bg);
  if (style.bold) css.fontWeight = 'bold';
  if (style.dim) css.opacity = '0.55';
  if (style.italic) css.fontStyle = 'italic';
  const decorations: string[] = [];
  if (style.underline) decorations.push('underline');
  if (style.strike) decorations.push('line-through');
  if (decorations.length > 0) css.textDecoration = decorations.join(' ');
  if (style.inverse) {
    css.background = style.fg ? cssColor(style.fg) : 'var(--tui-fg)';
    css.color = style.bg ? cssColor(style.bg) : 'var(--tui-bg)';
  }
}

/** Return a finite numeric prop, or undefined. */
export function num(props: Props, name: string): number | undefined {
  const value = props[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Apply character/line-sized dimensions to CSS. */
export function sizeCss(props: Props, css: Record<string, string>): void {
  for (const [name, unit] of [
    ['width', 'ch'],
    ['height', 'lh'],
    ['minWidth', 'ch'],
    ['maxWidth', 'ch'],
    ['minHeight', 'lh'],
    ['maxHeight', 'lh'],
  ] as const) {
    const value = num(props, name);
    if (value !== undefined) css[name] = `${value}${unit}`;
  }
}

/** Apply flex-child sizing, alignment, and margins to CSS. */
export function flexChildCss(props: Props, css: Record<string, string>): void {
  const grow = num(props, 'grow') ?? num(props, 'flex');
  const shrink = num(props, 'shrink');
  const basis = num(props, 'basis');
  if (grow !== undefined || shrink !== undefined || basis !== undefined) {
    css.flex = `${grow ?? 0} ${shrink ?? 0} ${basis === undefined ? 'auto' : `${basis}ch`}`;
  }
  if (props.alignSelf === 'start') css.alignSelf = 'flex-start';
  else if (props.alignSelf === 'end') css.alignSelf = 'flex-end';
  else if (typeof props.alignSelf === 'string') css.alignSelf = props.alignSelf;
  const margin = num(props, 'margin');
  const marginX = num(props, 'marginX') ?? margin;
  const marginY = num(props, 'marginY') ?? margin;
  if (marginX !== undefined || marginY !== undefined) {
    css.margin = `${marginY ?? 0}lh ${marginX ?? 0}ch`;
  }
}

/** Map a primitive justification value to CSS. */
export function justifyCss(value: unknown): string | undefined {
  if (value === 'center') return 'center';
  if (value === 'end') return 'flex-end';
  if (value === 'between') return 'space-between';
  if (value === 'start') return 'flex-start';
  return undefined;
}

/** Return an id attribute only for a string id. */
export function idAttr(id: unknown): Props {
  return typeof id === 'string' ? { id } : {};
}

/** Collector receiving stable action ids during an interactive HTML walk. */
export interface ActionCollector {
  /** Associate an action id with the callback invoked by a later request. */
  set(id: string, invoke: (value?: string) => void): unknown;
}

/** Options accepted by the HTML component target. */
export interface ToHtmlOptions {
  /** Collect handler invocations by action id and enable interactive markup. */
  actions?: ActionCollector;
  /** Hidden fields carried by every no-JavaScript GET fallback form. */
  fields?: Record<string, string>;
  /** `fino:ui/web` server-action descriptor. */
  action?: unknown;
}

/** Ambient action context installed for one HTML traversal. */
export interface ActionState {
  collector: ActionCollector;
  fields: Record<string, string>;
  ref: unknown;
  next: number;
}

let actions: ActionState | null = null;

/** Run a transform with the supplied action context. */
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

/** Whether interactive action collection is active. */
export function actionsActive(): boolean {
  return actions !== null;
}

/** Register an action in deterministic traversal order. */
export function registerAction(invoke: (value?: string) => void): string {
  if (actions === null) throw new Error('Cannot register an HTML action outside toHtml()');
  const id = `a${actions.next++}`;
  actions.collector.set(id, invoke);
  return id;
}

/** Options controlling a server-action form wrapper. */
export interface ActionFormOptions {
  act?: string;
  change?: boolean;
}

/** Wrap native markup in the active GET or server-action form protocol. */
export function actionForm(options: ActionFormOptions, ...children: NormalizedChild[]): VNode {
  if (actions === null) throw new Error('Cannot create an HTML action form outside toHtml()');
  const hidden =
    options.act === undefined
      ? []
      : [h('input', { type: 'hidden', name: 'do', value: options.act })];
  if (actions.ref !== undefined && actions.ref !== null) {
    const ref = actions.ref as {
      url: string;
      view: string;
      revision: number;
      request: string;
      action?: string;
    };
    const props: Props = {
      action: ref.url,
      method: 'post',
      className: 'ui-action',
      'data-fi-action': ref.action ?? 'invoke',
    };
    if (options.change === true) props['data-fi-change'] = '1';
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
    ...Object.entries(actions.fields).map(([name, value]) =>
      h('input', { type: 'hidden', name, value }),
    ),
    ...hidden,
    ...children,
  );
}

function withProps(node: VNode, props: Props): VNode {
  return { ...node, props: { ...node.props, ...props } };
}

/**
 * Apply the shared controlled-native-input contract.
 *
 * With an action collector, the control submits its `value` through the one
 * action protocol. Without one it remains a native local control. A missing
 * handler or explicit disable makes it inert in either mode.
 */
export function controlledNativeInput(
  control: VNode,
  onValue: ((value?: string) => void) | undefined,
  options: { disabled?: boolean; before?: NormalizedChild[] } = {},
): VNode {
  const enabled = options.disabled !== true && onValue !== undefined;
  if (!enabled) return withProps(control, { disabled: true });
  if (!actionsActive()) return control;
  const act = registerAction(onValue);
  const attrs: Props = { name: 'value' };
  if (actions!.ref === undefined || actions!.ref === null) attrs.onchange = 'this.form.submit()';
  return actionForm({ act, change: true }, ...(options.before ?? []), withProps(control, attrs));
}

/**
 * Apply the shared click-action contract to a native button.
 *
 * Interactive walks submit the registered action; static walks preserve a
 * local button only when a handler exists.
 */
export function nativeAction(
  button: VNode,
  invoke: (() => void) | undefined,
  disabled = false,
): VNode {
  const enabled = !disabled && invoke !== undefined;
  if (!enabled) return withProps(button, { disabled: true, type: 'button' });
  if (!actionsActive()) return withProps(button, { type: 'button' });
  const act = registerAction(() => invoke());
  return actionForm({}, withProps(button, { name: 'do', value: act }));
}
