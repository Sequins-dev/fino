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
import { h } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { EMPTY_STYLE, mergeStyle } from 'fino:tty/style';
import type { Color, Style } from 'fino:tty/style';
import { rawHtml, renderToHtml } from 'fino:ui/html';
import type {
  BadgeProps,
  BreadcrumbsProps,
  ButtonProps,
  CheckboxProps,
  ContextMenuProps,
  DetailsProps,
  FileTreeNode,
  FileTreeProps,
  KeyHintProps,
  MenuItem,
  MenuListProps,
  MenuRowProps,
  ModalProps,
  PaginationProps,
  PanelProps,
  PopoverProps,
  ProgressBarProps,
  RadioGroupProps,
  RadioProps,
  SelectProps,
  StepsProps,
  SwitchProps,
  TabItem,
  TabListProps,
  TableProps,
  TabsProps,
  TagProps,
  TextInputProps,
  TimelineProps,
  ToastProps,
  ToastStackProps,
  TooltipProps,
} from 'fino:ui/components';

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

function borderShorthand(style: unknown, color: string): { border: string; radius?: string } {
  switch (style) {
    case 'round':
      return { border: `1px solid ${color}`, radius: '0.5rem' };
    case 'heavy':
      return { border: `3px solid ${color}` };
    case 'double':
      return { border: `4px double ${color}` };
    case 'ascii':
      return { border: `1px dashed ${color}` };
    default:
      return { border: `1px solid ${color}` };
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
    const name = typeof border === 'string' ? border : props.borderStyle;
    const color = props.borderColor ? cssColor(props.borderColor as Color) : 'var(--tui-border)';
    const spec = borderShorthand(name, color);
    css.border = spec.border;
    css.borderRadius = spec.radius ?? '0';
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

function emptyNode(): VNode {
  return { type: 'fragment', props: {}, children: [], key: null };
}

function idAttr(id: unknown): Props {
  return typeof id === 'string' ? { id } : {};
}

function tone(variant: unknown, fallback: string): string {
  return `ui-tone-${typeof variant === 'string' ? variant : fallback}`;
}

/** Collector receiving `id → invoke` pairs during an interactive transform. */
export interface ActionCollector {
  set(id: string, invoke: (value?: string) => void): unknown;
}

/** Options accepted by `toHtml`. */
export interface ToHtmlOptions {
  /** Collect handler invocations by action id; enables interactive markup. */
  actions?: ActionCollector;
  /** Hidden fields carried by every action form (story key, control args, …). */
  fields?: Record<string, string>;
}

interface ActionState {
  collector: ActionCollector;
  fields: Record<string, string>;
  next: number;
}

let actions: ActionState | null = null;

function register(invoke: (value?: string) => void): string {
  const id = `a${actions!.next++}`;
  actions!.collector.set(id, invoke);
  return id;
}

function actionForm(extra: Record<string, string> | null, ...children: NormalizedChild[]): VNode {
  const fields = { ...actions!.fields, ...extra };
  return h(
    'form',
    { method: 'get', className: 'ui-action' },
    ...Object.entries(fields).map(([name, value]) => h('input', { type: 'hidden', name, value })),
    ...children,
  );
}

const RESUBMIT = 'this.form.submit()';

function handlerOf<T>(value: unknown): T | undefined {
  return typeof value === 'function' ? (value as T) : undefined;
}

function panelHtml(node: VNode): VNode {
  const { title, id, border, borderStyle } = node.props as PanelProps;
  const css: Record<string, string> = {};
  sizeCss(node.props, css);
  flexChildCss(node.props, css);
  const styleName = typeof border === 'string' ? border : borderStyle;
  if (typeof styleName === 'string') {
    const spec = borderShorthand(styleName, 'var(--ui-border)');
    css.border = spec.border;
    if (spec.radius !== undefined) css.borderRadius = spec.radius;
  }
  const attrs: Props = { className: 'ui-panel', ...idAttr(id) };
  if (Object.keys(css).length > 0) attrs.style = css;
  return h(
    'section',
    attrs,
    title !== undefined ? h('header', { className: 'ui-panel-title' }, title) : null,
    ...transformChildren(node.children),
  );
}

function buttonHtml(node: VNode): VNode {
  const { label, onClick, disabled, id } = node.props as ButtonProps;
  const click = handlerOf<() => void>(onClick);
  const enabled = disabled !== true && click !== undefined;
  if (actions !== null && enabled) {
    const act = register(() => click!());
    return actionForm(
      null,
      h('button', { className: 'ui-button', name: 'do', value: act, ...idAttr(id) }, label),
    );
  }
  const attrs: Props = { className: 'ui-button', type: 'button', ...idAttr(id) };
  if (!enabled) attrs.disabled = true;
  return h('button', attrs, label);
}

function choiceHtml(kind: 'checkbox' | 'radio', node: VNode): VNode {
  const props = node.props as CheckboxProps & RadioProps & SwitchProps;
  const isSwitch = node.type === 'ui:switch';
  const checked =
    kind === 'checkbox'
      ? isSwitch
        ? props.on === true
        : props.checked === true
      : props.selected === true;
  const change =
    kind === 'radio'
      ? handlerOf<() => void>(props.onSelect)
      : handlerOf<(next: boolean) => void>(props.onChange);
  const enabled = props.disabled !== true && change !== undefined;
  const input: Props = { type: kind, className: isSwitch ? 'ui-switch' : 'ui-check' };
  if (checked) input.checked = true;
  const control = (field: Props): VNode =>
    h(
      'label',
      {
        className: `ui-choice${props.disabled === true ? ' is-disabled' : ''}`,
        ...idAttr(props.id),
      },
      h('input', field),
      props.label !== undefined ? h('span', null, props.label) : null,
    );
  if (actions !== null && enabled) {
    const act =
      kind === 'radio'
        ? register(() => (change as () => void)())
        : register((value) => (change as (next: boolean) => void)(value === 'true'));
    const field: Props = { ...input, name: 'value', value: 'true', onchange: RESUBMIT };
    return actionForm(
      { do: act },
      ...(kind === 'checkbox'
        ? [h('input', { type: 'hidden', name: 'value', value: 'false' })]
        : []),
      control(field),
    );
  }
  if (!enabled) input.disabled = true;
  return control(input);
}

function radioGroupHtml(node: VNode): VNode {
  const { value, options, onChange, id } = node.props as RadioGroupProps;
  const change = handlerOf<(key: string) => void>(onChange);
  const interactive = actions !== null && change !== undefined;
  const name = interactive ? 'value' : typeof id === 'string' ? id : 'ui-radio';
  const group = h(
    'div',
    { className: 'ui-radio-group', role: 'radiogroup', ...idAttr(id) },
    ...options.map((option) => {
      const input: Props = { type: 'radio', className: 'ui-check', name, value: option.key };
      if (option.key === value) input.checked = true;
      if (option.disabled === true || change === undefined) input.disabled = true;
      else if (interactive) input.onchange = RESUBMIT;
      return h(
        'label',
        { className: `ui-choice${option.disabled === true ? ' is-disabled' : ''}` },
        h('input', input),
        h('span', null, option.label),
      );
    }),
  );
  if (interactive) {
    const act = register((key) => {
      if (typeof key === 'string' && key.length > 0) change!(key);
    });
    return actionForm({ do: act }, group);
  }
  return group;
}

function textInputHtml(node: VNode): VNode {
  const { value, placeholder, id } = node.props as TextInputProps;
  // The semantic contract carries only key events, which a form round trip
  // cannot deliver — the field is never interactive in HTML.
  const attrs: Props = {
    className: 'ui-field',
    type: 'text',
    value: value ?? '',
    disabled: true,
    ...idAttr(id),
  };
  if (placeholder !== undefined) attrs.placeholder = placeholder;
  return h('input', attrs);
}

function selectHtml(node: VNode): VNode {
  const { value, options, placeholder, onChange, id } = node.props as SelectProps;
  const change = handlerOf<(key: string) => void>(onChange);
  const entries: VNode[] = [];
  if (value === null) {
    entries.push(
      h('option', { value: '', selected: true, disabled: true }, placeholder ?? 'Select…'),
    );
  }
  for (const option of options) {
    const attrs: Props = { value: option.key };
    if (option.key === value) attrs.selected = true;
    if (option.disabled === true) attrs.disabled = true;
    entries.push(h('option', attrs, option.label));
  }
  if (actions !== null && change !== undefined) {
    const act = register((key) => {
      if (typeof key === 'string' && key.length > 0) change(key);
    });
    return actionForm(
      { do: act },
      h(
        'select',
        { className: 'ui-field', name: 'value', onchange: RESUBMIT, ...idAttr(id) },
        ...entries,
      ),
    );
  }
  const attrs: Props = { className: 'ui-field', ...idAttr(id) };
  if (change === undefined) attrs.disabled = true;
  return h('select', attrs, ...entries);
}

function detailsHtml(node: VNode): VNode {
  const { title, open, onToggle, id } = node.props as DetailsProps;
  const toggle = handlerOf<(next: boolean) => void>(onToggle);
  const attrs: Props = { className: 'ui-details', ...idAttr(id) };
  if (open === true) attrs.open = true;
  const body = h('div', { className: 'ui-details-body' }, ...transformChildren(node.children));
  if (actions !== null && toggle !== undefined) {
    // The summary is one big submit button: clicks round-trip instead of
    // toggling natively, so the server's open state never desyncs.
    const act = register(() => toggle(open !== true));
    return h(
      'details',
      attrs,
      h(
        'summary',
        { className: 'ui-details-summary' },
        actionForm(
          null,
          h('button', { className: 'ui-details-toggle', name: 'do', value: act }, title),
        ),
      ),
      body,
    );
  }
  return h('details', attrs, h('summary', null, title), body);
}

function tabStrip(items: TabItem[], value: string, onChange: unknown): VNode {
  const change = handlerOf<(key: string) => void>(onChange);
  const entries = items.map((item) => {
    const className =
      'ui-tab' +
      (item.key === value ? ' is-active' : '') +
      (item.disabled === true ? ' is-disabled' : '');
    const switchable = change !== undefined && item.key !== value && item.disabled !== true;
    if (actions !== null && switchable) {
      const act = register(() => change!(item.key));
      return h('button', { className, name: 'do', value: act }, item.label);
    }
    if (switchable) return h('a', { href: '#', className }, item.label);
    return h('span', { className }, item.label);
  });
  const nav = h('nav', { className: 'ui-tabs' }, ...entries);
  return actions !== null && change !== undefined ? actionForm(null, nav) : nav;
}

function tabListHtml(node: VNode): VNode {
  const { items, value, onChange } = node.props as TabListProps;
  return tabStrip(items, value, onChange);
}

function tabsHtml(node: VNode): VNode {
  const { items, value, onChange } = node.props as TabsProps;
  return h(
    'div',
    { className: 'ui-tabs-wrap' },
    tabStrip(items, value, onChange),
    h('div', { className: 'ui-tab-panel' }, ...transformChildren(node.children)),
  );
}

function menuRowContent(item: {
  label: string;
  detail?: string;
  glyph?: string;
}): NormalizedChild[] {
  const out: NormalizedChild[] = [];
  if (item.glyph !== undefined) out.push(h('span', { className: 'ui-menu-glyph' }, item.glyph));
  out.push(h('span', null, item.label));
  if (item.detail !== undefined) out.push(h('span', { className: 'ui-menu-detail' }, item.detail));
  return out;
}

function menuUl(
  items: readonly MenuItem[],
  selectedKey: string | null | undefined,
  props: { top?: number; maxRows?: number; id?: string; onSelect?: unknown },
): VNode {
  const select = handlerOf<(key: string) => void>(props.onSelect);
  const start = props.top ?? 0;
  const end = props.maxRows !== undefined ? start + props.maxRows : items.length;
  const visible = items.slice(start, end);
  const remaining = items.length - end;
  const list = h(
    'ul',
    { className: 'ui-menu', ...idAttr(props.id) },
    ...visible.map((item) => {
      if (item.kind === 'header') return h('li', { className: 'ui-menu-header' }, item.label);
      if (item.kind === 'separator') return h('li', { className: 'ui-menu-sep' }, h('hr'));
      const selected = item.key === selectedKey;
      const disabled = item.disabled === true;
      const button: Props = {};
      if (actions !== null && select !== undefined && !disabled) {
        button.name = 'do';
        button.value = register(() => select(item.key));
      } else {
        button.type = 'button';
        if (disabled || select === undefined) button.disabled = true;
      }
      return h(
        'li',
        {
          className:
            'ui-menu-item' + (selected ? ' is-selected' : '') + (disabled ? ' is-disabled' : ''),
        },
        h('button', button, ...menuRowContent(item)),
      );
    }),
    remaining > 0 ? h('li', { className: 'ui-menu-more' }, `… ${remaining} more`) : null,
  );
  return actions !== null && select !== undefined ? actionForm(null, list) : list;
}

function menuListHtml(node: VNode): VNode {
  const { items, selectedKey, top, maxRows, onSelect, id } = node.props as MenuListProps;
  return menuUl(items, selectedKey, { top, maxRows, id, onSelect });
}

function menuRowHtml(node: VNode): VNode {
  const { label, detail, glyph, selected, disabled, onClick, id } = node.props as MenuRowProps;
  const click = handlerOf<() => void>(onClick);
  const button: Props = { ...idAttr(id) };
  const row = (content: VNode): VNode =>
    h(
      'div',
      {
        className:
          'ui-menu-item' +
          (selected === true ? ' is-selected' : '') +
          (disabled === true ? ' is-disabled' : ''),
      },
      content,
    );
  if (actions !== null && click !== undefined && disabled !== true) {
    button.name = 'do';
    button.value = register(() => click());
    return row(actionForm(null, h('button', button, ...menuRowContent({ label, detail, glyph }))));
  }
  button.type = 'button';
  if (disabled === true || click === undefined) button.disabled = true;
  return row(h('button', button, ...menuRowContent({ label, detail, glyph })));
}

function dismissButton(onDismiss: unknown): VNode | null {
  const dismiss = handlerOf<() => void>(onDismiss);
  if (actions === null || dismiss === undefined) return null;
  const act = register(() => dismiss());
  return actionForm(
    null,
    h('button', { className: 'ui-dismiss', name: 'do', value: act, 'aria-label': 'Dismiss' }, '×'),
  );
}

function modalHtml(node: VNode): VNode {
  const { title, onDismiss } = node.props as ModalProps;
  return h(
    'div',
    { className: 'ui-overlay' },
    h(
      'div',
      { className: 'ui-modal', role: 'dialog', 'aria-modal': 'true' },
      dismissButton(onDismiss),
      title !== undefined ? h('header', { className: 'ui-modal-title' }, title) : null,
      ...transformChildren(node.children),
    ),
  );
}

function contextMenuHtml(node: VNode): VNode {
  const { items, selectedKey, onSelect, onDismiss, id } = node.props as ContextMenuProps;
  return h(
    'div',
    { className: 'ui-context-menu' },
    dismissButton(onDismiss),
    menuUl(items, selectedKey, { id, onSelect }),
  );
}

function popoverHtml(node: VNode): VNode {
  const { open, onDismiss } = node.props as PopoverProps;
  if (open !== true) return emptyNode();
  return h(
    'div',
    { className: 'ui-popover' },
    dismissButton(onDismiss),
    ...transformChildren(node.children),
  );
}

function tooltipHtml(node: VNode): VNode {
  const { text, open } = node.props as TooltipProps;
  if (open !== true) return emptyNode();
  return h('span', { className: 'ui-tooltip', role: 'tooltip' }, text);
}

function toastHtml(node: VNode): VNode {
  const { message, variant } = node.props as ToastProps;
  return h('div', { className: `ui-toast ${tone(variant, 'info')}` }, message);
}

function toastStackHtml(node: VNode): VNode {
  const { toasts } = node.props as ToastStackProps;
  if (toasts.length === 0) return emptyNode();
  return h(
    'div',
    { className: 'ui-toast-stack' },
    ...toasts.map((entry) =>
      h('div', { className: `ui-toast ${tone(entry.variant, 'info')}` }, entry.message),
    ),
  );
}

function progressHtml(node: VNode): VNode {
  const { value, showPercent, id } = node.props as ProgressBarProps;
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return h(
    'span',
    { className: 'ui-progress-wrap', ...idAttr(id) },
    h('progress', { className: 'ui-progress', max: '100', value: String(percent) }),
    showPercent === true ? h('span', { className: 'ui-progress-percent' }, `${percent}%`) : null,
  );
}

function spinnerHtml(node: VNode): VNode {
  return h('span', {
    className: 'ui-spinner',
    role: 'status',
    'aria-label': 'loading',
    ...idAttr(node.props.id),
  });
}

function badgeHtml(node: VNode): VNode {
  const { label, variant, id } = node.props as BadgeProps;
  return h('span', { className: `ui-badge ${tone(variant, 'accent')}`, ...idAttr(id) }, label);
}

function keyHintHtml(node: VNode): VNode {
  const { keys, separator, id } = node.props as KeyHintProps;
  const sep = separator ?? ' · ';
  const parts: NormalizedChild[] = [];
  keys.forEach((hint, index) => {
    if (index > 0) parts.push(h('span', { className: 'ui-keyhint-sep' }, sep));
    parts.push(h('kbd', null, hint.key));
    parts.push(` ${hint.label}`);
  });
  return h('span', { className: 'ui-keyhint', ...idAttr(id) }, ...parts);
}

function tagHtml(node: VNode): VNode {
  const { label, onRemove, color, id } = node.props as TagProps;
  const remove = handlerOf<() => void>(onRemove);
  let remover: VNode | null = null;
  if (remove !== undefined && actions !== null) {
    const act = register(() => remove());
    remover = actionForm(
      null,
      h(
        'button',
        { className: 'ui-tag-remove', name: 'do', value: act, 'aria-label': `Remove ${label}` },
        '×',
      ),
    );
  } else if (remove !== undefined) {
    remover = h(
      'button',
      { type: 'button', className: 'ui-tag-remove', 'aria-label': `Remove ${label}` },
      '×',
    );
  }
  return h('span', { className: `ui-tag ${tone(color, 'accent')}`, ...idAttr(id) }, label, remover);
}

function breadcrumbsHtml(node: VNode): VNode {
  const { items, onNavigate, id } = node.props as BreadcrumbsProps;
  const navigate = handlerOf<(key: string) => void>(onNavigate);
  const nav = h(
    'nav',
    { className: 'ui-crumbs', 'aria-label': 'breadcrumbs', ...idAttr(id) },
    ...items.flatMap((item, index) => {
      let entry: VNode;
      if (index === items.length - 1) {
        entry = h('strong', null, item.label);
      } else if (actions !== null && navigate !== undefined) {
        const act = register(() => navigate(item.key));
        entry = h('button', { className: 'ui-crumb', name: 'do', value: act }, item.label);
      } else if (navigate !== undefined) {
        entry = h('a', { href: '#', className: 'ui-crumb' }, item.label);
      } else {
        entry = h('span', { className: 'ui-crumb' }, item.label);
      }
      return index > 0 ? [h('span', { className: 'ui-crumbs-sep' }, '/'), entry] : [entry];
    }),
  );
  return actions !== null && navigate !== undefined ? actionForm(null, nav) : nav;
}

function paginationHtml(node: VNode): VNode {
  const { page, pages, onChange, id } = node.props as PaginationProps;
  const change = handlerOf<(page: number) => void>(onChange);
  const step = (target: number, blocked: boolean, label: string): VNode => {
    const attrs: Props = { className: 'ui-button ui-pager-step' };
    if (actions !== null && change !== undefined && !blocked) {
      attrs.name = 'do';
      attrs.value = register(() => change(target));
    } else {
      attrs.type = 'button';
      if (blocked || change === undefined) attrs.disabled = true;
    }
    return h('button', attrs, label);
  };
  const nav = h(
    'nav',
    { className: 'ui-pager', ...idAttr(id) },
    step(page - 1, page <= 1, '‹'),
    h('span', null, `${page} / ${pages}`),
    step(page + 1, page >= pages, '›'),
  );
  return actions !== null && change !== undefined ? actionForm(null, nav) : nav;
}

function stepsHtml(node: VNode): VNode {
  const { steps, current, id } = node.props as StepsProps;
  const at = steps.findIndex((step) => step.key === current);
  return h(
    'ol',
    { className: 'ui-steps', ...idAttr(id) },
    ...steps.map((step, index) => {
      const state =
        at !== -1 && index < at ? 'is-done' : index === at ? 'is-current' : 'is-upcoming';
      return h(
        'li',
        { className: state },
        h('span', { className: 'ui-step-dot' }),
        h('span', null, step.label),
      );
    }),
  );
}

function tableHtml(node: VNode): VNode {
  const { columns, rows, selectedIndex } = node.props as TableProps;
  const cellStyle = (align: 'start' | 'end' | undefined): Props =>
    align === 'end' ? { style: { textAlign: 'right' } } : {};
  return h(
    'table',
    { className: 'ui-table', ...idAttr(node.props.id) },
    h(
      'thead',
      null,
      h('tr', null, ...columns.map((column) => h('th', cellStyle(column.align), column.header))),
    ),
    h(
      'tbody',
      null,
      ...rows.map((row, index) =>
        h(
          'tr',
          index === selectedIndex ? { className: 'is-selected' } : {},
          ...columns.map((column) => h('td', cellStyle(column.align), row[column.key] ?? '')),
        ),
      ),
    ),
  );
}

function treeNodesHtml(
  nodes: FileTreeNode[],
  expanded: string[],
  selectedKey: string | null | undefined,
): VNode[] {
  return nodes.map((entry) => {
    const selected = entry.key === selectedKey;
    if (entry.children !== undefined) {
      const attrs: Props = { className: 'ui-tree-dir' };
      if (expanded.includes(entry.key)) attrs.open = true;
      return h(
        'details',
        attrs,
        h('summary', selected ? { className: 'is-selected' } : {}, entry.label),
        h(
          'div',
          { className: 'ui-tree-children' },
          ...treeNodesHtml(entry.children, expanded, selectedKey),
        ),
      );
    }
    return h('div', { className: `ui-tree-leaf${selected ? ' is-selected' : ''}` }, entry.label);
  });
}

function fileTreeHtml(node: VNode): VNode {
  const { nodes, expanded, selectedKey, id } = node.props as FileTreeProps;
  return h(
    'div',
    { className: 'ui-tree', ...idAttr(id) },
    ...treeNodesHtml(nodes, expanded ?? [], selectedKey),
  );
}

function timelineHtml(node: VNode): VNode {
  const { entries, id } = node.props as TimelineProps;
  return h(
    'ol',
    { className: 'ui-timeline', ...idAttr(id) },
    ...entries.map((entry) =>
      h(
        'li',
        { className: tone(entry.variant, 'info') },
        h('span', { className: 'ui-timeline-title' }, entry.title),
        entry.detail !== undefined
          ? h('span', { className: 'ui-timeline-detail' }, entry.detail)
          : null,
      ),
    ),
  );
}

const NATIVE: Record<string, (node: VNode) => VNode> = {
  'ui:panel': panelHtml,
  'ui:button': buttonHtml,
  'ui:checkbox': (node) => choiceHtml('checkbox', node),
  'ui:switch': (node) => choiceHtml('checkbox', node),
  'ui:radio': (node) => choiceHtml('radio', node),
  'ui:radio-group': radioGroupHtml,
  'ui:text-input': textInputHtml,
  'ui:select': selectHtml,
  'ui:details': detailsHtml,
  'ui:tab-list': tabListHtml,
  'ui:tabs': tabsHtml,
  'ui:menu-list': menuListHtml,
  'ui:menu-row': menuRowHtml,
  'ui:menu-header': (node) =>
    h('div', { className: 'ui-menu-header' }, (node.props as { label: string }).label),
  'ui:menu-separator': () => h('hr', { className: 'ui-menu-sep' }),
  'ui:modal': modalHtml,
  'ui:context-menu': contextMenuHtml,
  'ui:popover': popoverHtml,
  'ui:tooltip': tooltipHtml,
  'ui:toast': toastHtml,
  'ui:toast-stack': toastStackHtml,
  'ui:progress': progressHtml,
  'ui:spinner': spinnerHtml,
  'ui:badge': badgeHtml,
  'ui:key-hint': keyHintHtml,
  'ui:tag': tagHtml,
  'ui:breadcrumbs': breadcrumbsHtml,
  'ui:pagination': paginationHtml,
  'ui:steps': stepsHtml,
  'ui:table': tableHtml,
  'ui:file-tree': fileTreeHtml,
  'ui:timeline': timelineHtml,
};

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
  if (options.actions !== undefined && actions === null) {
    actions = { collector: options.actions, fields: options.fields ?? {}, next: 0 };
    try {
      return transformNode(node);
    } finally {
      actions = null;
    }
  }
  return transformNode(node);
}

function transformNode(node: VNode): VNode {
  const native = NATIVE[node.type];
  if (native) return native(node);
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
.ui-pager { display: inline-flex; align-items: center; gap: 0.75rem; }
.ui-pager-step { padding: 0.125rem 0.625rem; line-height: 1.4; }
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
.ui-tree summary { cursor: pointer; padding: 0.125rem 0.375rem; border-radius: 0.25rem; }
.ui-tree summary:hover, .ui-tree-leaf:hover { background: var(--ui-surface); }
.ui-tree-children { margin-left: 0.875rem; border-left: 1px solid var(--ui-border); padding-left: 0.5rem; }
.ui-tree-leaf { padding: 0.125rem 0.375rem 0.125rem 1.375rem; border-radius: 0.25rem; }
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
summary.ui-details-summary { list-style: none; padding: 0; }
summary.ui-details-summary::-webkit-details-marker { display: none; }
.ui-details-toggle {
  display: flex; justify-content: space-between; align-items: center; gap: 0.75rem;
  width: 100%; text-align: left; font-weight: 600; cursor: pointer;
  padding: 0.5rem 0.875rem; border-radius: var(--ui-radius);
}
.ui-details-toggle:hover { background: var(--ui-surface-2); }
.ui-details-toggle::after { content: '+'; color: var(--ui-muted); }
.ui-details[open] > summary .ui-details-toggle::after { content: '\\2212'; }
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
