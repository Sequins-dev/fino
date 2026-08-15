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
import { defaultComboBoxFilter, fileIcon, iconForm, paginationRange } from 'fino:ui/components';
import { highlightLines } from 'fino:format/typescript';
import type {
  BadgeProps,
  BlockquoteProps,
  BoldProps,
  BreadcrumbsProps,
  ButtonProps,
  CheckboxProps,
  CodeProps,
  ComboBoxProps,
  ContextMenuProps,
  DetailsProps,
  ExpanderPosition,
  ExpanderProps,
  FieldProps,
  FieldsetProps,
  FileTreeNode,
  FileTreeProps,
  HeadingProps,
  IconButtonProps,
  IconProps,
  InlineCodeProps,
  ItalicProps,
  KeyHintProps,
  LinkProps,
  ListProps,
  MenuItem,
  MenuListProps,
  MenuRowProps,
  ModalProps,
  NumberInputProps,
  PaginationProps,
  PanelProps,
  PopoverProps,
  ProgressBarProps,
  RadioGroupProps,
  RadioProps,
  SelectProps,
  SliderProps,
  StepsProps,
  SwitchProps,
  TabItem,
  TabListProps,
  TableProps,
  TabsProps,
  TagProps,
  TextAreaProps,
  TextInputProps,
  TimelineProps,
  ToastProps,
  ToastStackProps,
  TooltipProps,
  VirtualListProps,
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

function borderShorthand(
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

interface ActionState {
  collector: ActionCollector;
  fields: Record<string, string>;
  ref: unknown;
  next: number;
}

let actions: ActionState | null = null;

function register(invoke: (value?: string) => void): string {
  const id = `a${actions!.next++}`;
  actions!.collector.set(id, invoke);
  return id;
}

interface FormOptions {
  /** Action id carried as a hidden `do` field (value-bearing forms). */
  act?: string;
  /** Submit when a control changes (auto-submit idiom per wire mode). */
  change?: boolean;
}

function actionForm(opts: FormOptions, ...children: NormalizedChild[]): VNode {
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

const RESUBMIT = 'this.form.submit()';

// In web-action mode the client's change listener drives submission; the
// inline handler would bypass it (form.submit() skips submit events).
function changeAttrs(): Props {
  return actions!.ref !== undefined && actions!.ref !== null ? {} : { onchange: RESUBMIT };
}

function handlerOf<T>(value: unknown): T | undefined {
  return typeof value === 'function' ? (value as T) : undefined;
}

function panelHtml(node: VNode): VNode {
  const { title, id, border, borderStyle, rounded } = node.props as PanelProps;
  const css: Record<string, string> = {};
  sizeCss(node.props, css);
  flexChildCss(node.props, css);
  const styleName = typeof border === 'string' ? border : borderStyle;
  if (typeof styleName === 'string' || rounded !== undefined) {
    const spec = borderShorthand(styleName, rounded === true, 'var(--ui-border)');
    css.border = spec.border;
    css.borderRadius = spec.radius;
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

const ARIA_CONTROL_TYPES = new Set(['input', 'select', 'textarea']);

// Finds the first native form control among a field's transformed children
// and merges `attrs` onto it — the only way to wire `aria-invalid`/
// `aria-describedby` onto a control `Field` does not own and cannot know the
// shape of. Stops at the first match, matching the "the control" (singular)
// framing of one field around one control.
function injectFirstControlAria(
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

function fieldHtml(node: VNode): VNode {
  const { label, hint, error, required, htmlFor, id } = node.props as FieldProps;
  const hintId = id !== undefined ? `${id}-hint` : undefined;
  const errorId = id !== undefined ? `${id}-error` : undefined;
  const describedBy = [
    hint !== undefined ? hintId : undefined,
    error !== undefined ? errorId : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  const controlAttrs: Props = {};
  if (error !== undefined) controlAttrs['aria-invalid'] = 'true';
  if (describedBy.length > 0) controlAttrs['aria-describedby'] = describedBy.join(' ');
  let kids = transformChildren(node.children);
  if (Object.keys(controlAttrs).length > 0) kids = injectFirstControlAria(kids, controlAttrs).nodes;
  const labelText = h(
    'span',
    { className: 'ui-field-label' },
    label,
    required === true
      ? h('span', { className: 'ui-field-required', 'aria-hidden': 'true' }, ' *')
      : null,
  );
  const body = [
    ...kids,
    hint !== undefined ? h('small', { className: 'ui-field-hint', id: hintId }, hint) : null,
    error !== undefined
      ? h('small', { className: 'ui-field-error', role: 'alert', id: errorId }, error)
      : null,
  ];
  if (typeof htmlFor === 'string') {
    return h(
      'div',
      { className: 'ui-field', ...idAttr(id) },
      h('label', { className: 'ui-field-label-row', for: htmlFor }, labelText),
      ...body,
    );
  }
  return h('label', { className: 'ui-field ui-field-wrap', ...idAttr(id) }, labelText, ...body);
}

function fieldsetHtml(node: VNode): VNode {
  const { legend, id } = node.props as FieldsetProps;
  return h(
    'fieldset',
    { className: 'ui-fieldset', ...idAttr(id) },
    h('legend', null, legend),
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
      {},
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
    const field: Props = { ...input, name: 'value', value: 'true', ...changeAttrs() };
    return actionForm(
      { act, change: true },
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
      else if (interactive) Object.assign(input, changeAttrs());
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
    return actionForm({ act, change: true }, group);
  }
  return group;
}

function textInputHtml(node: VNode): VNode {
  const { value, placeholder, onChange, onSubmit, password, id } = node.props as TextInputProps;
  const change = handlerOf<(value: string, caret?: number) => void>(onChange);
  const submit = handlerOf<(value: string) => void>(onSubmit);
  const attrs: Props = {
    className: 'ui-field',
    type: password === true ? 'password' : 'text',
    value: value ?? '',
    ...idAttr(id),
  };
  if (placeholder !== undefined) attrs.placeholder = placeholder;
  if (actions !== null && (change !== undefined || submit !== undefined)) {
    // Change-submit and Enter-submit are the same GET round trip; Enter's
    // natural form submission is what makes onSubmit win when both exist.
    const act = register((next) => {
      const text = next ?? '';
      if (submit !== undefined) submit(text);
      else change!(text);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('input', attrs));
  }
  if (change === undefined && submit === undefined) attrs.disabled = true;
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
      { act, change: true },
      h(
        'select',
        { className: 'ui-field', name: 'value', ...changeAttrs(), ...idAttr(id) },
        ...entries,
      ),
    );
  }
  const attrs: Props = { className: 'ui-field', ...idAttr(id) };
  if (change === undefined) attrs.disabled = true;
  return h('select', attrs, ...entries);
}

function numberInputHtml(node: VNode): VNode {
  const { value, min, max, step, onChange, disabled, id } = node.props as NumberInputProps;
  const change = handlerOf<(value: number) => void>(onChange);
  const attrs: Props = {
    className: 'ui-field',
    type: 'number',
    value: String(value),
    ...idAttr(id),
  };
  if (min !== undefined) attrs.min = String(min);
  if (max !== undefined) attrs.max = String(max);
  if (step !== undefined) attrs.step = String(step);
  if (actions !== null && change !== undefined && disabled !== true) {
    const act = register((next) => {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) change(parsed);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('input', attrs));
  }
  if (change === undefined || disabled === true) attrs.disabled = true;
  return h('input', attrs);
}

function textAreaHtml(node: VNode): VNode {
  const { value, rows, onChange, id } = node.props as TextAreaProps;
  const change = handlerOf<(value: string, caret?: number) => void>(onChange);
  const attrs: Props = { className: 'ui-field', rows: String(rows ?? 4), ...idAttr(id) };
  if (actions !== null && change !== undefined) {
    const act = register((next) => change(next ?? ''));
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('textarea', attrs, value ?? ''));
  }
  if (change === undefined) attrs.disabled = true;
  return h('textarea', attrs, value ?? '');
}

function sliderHtml(node: VNode): VNode {
  const { value, min, max, step, onChange, orientation, disabled, id } = node.props as SliderProps;
  const change = handlerOf<(value: number) => void>(onChange);
  const attrs: Props = {
    className: 'ui-field ui-slider',
    type: 'range',
    value: String(value),
    min: String(min ?? 0),
    max: String(max ?? 100),
    ...idAttr(id),
  };
  if (step !== undefined) attrs.step = String(step);
  if (orientation === 'vertical') attrs.style = { writingMode: 'vertical-lr', direction: 'rtl' };
  if (actions !== null && change !== undefined && disabled !== true) {
    const act = register((next) => {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) change(parsed);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('input', attrs));
  }
  if (change === undefined || disabled === true) attrs.disabled = true;
  return h('input', attrs);
}

function comboBoxHtml(node: VNode): VNode {
  const {
    value,
    options,
    open,
    onOpenChange,
    onInput,
    onSelect,
    activeKey,
    placeholder,
    filter,
    disabled,
    id,
  } = node.props as ComboBoxProps;
  const input = handlerOf<(value: string) => void>(onInput);
  const openChange = handlerOf<(open: boolean) => void>(onOpenChange);
  const filtered = (filter ?? defaultComboBoxFilter)(options, value ?? '');
  const attrs: Props = { className: 'ui-field', type: 'text', value: value ?? '' };
  if (placeholder !== undefined) attrs.placeholder = placeholder;
  let field: VNode;
  if (actions !== null && input !== undefined && disabled !== true) {
    const act = register((next) => {
      input(next ?? '');
      openChange?.(true);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    field = actionForm({ act, change: true }, h('input', attrs));
  } else {
    if (input === undefined || disabled === true) attrs.disabled = true;
    field = h('input', attrs);
  }
  let toggle: VNode | null = null;
  if (actions !== null && openChange !== undefined && disabled !== true) {
    const act = register(() => openChange(open !== true));
    toggle = actionForm(
      {},
      h(
        'button',
        {
          className: 'ui-combo-toggle',
          name: 'do',
          value: act,
          'aria-label': open === true ? 'Close options' : 'Open options',
        },
        open === true ? '▴' : '▾',
      ),
    );
  }
  const popover =
    open === true
      ? h(
          'div',
          { className: 'ui-popover ui-combo-popover' },
          menuUl(
            filtered.length > 0 ? filtered : [{ kind: 'header', label: 'No matches' } as MenuItem],
            activeKey ?? null,
            { onSelect },
          ),
        )
      : null;
  return h('div', { className: 'ui-combo', ...idAttr(id) }, field, toggle, popover);
}

function iconButtonHtml(node: VNode): VNode {
  const { icon, label, onClick, disabled, icons, id } = node.props as IconButtonProps;
  const click = handlerOf<() => void>(onClick);
  const enabled = disabled !== true && click !== undefined;
  const glyph = h(
    'span',
    { className: 'ui-icon', 'aria-hidden': 'true' },
    iconForm(icon, 'html', icons),
  );
  if (actions !== null && enabled) {
    const act = register(() => click!());
    return actionForm(
      {},
      h(
        'button',
        { className: 'ui-icon-button', name: 'do', value: act, 'aria-label': label, ...idAttr(id) },
        glyph,
      ),
    );
  }
  const attrs: Props = {
    className: 'ui-icon-button',
    type: 'button',
    'aria-label': label,
    ...idAttr(id),
  };
  if (!enabled) attrs.disabled = true;
  return h('button', attrs, glyph);
}

function iconHtml(node: VNode): VNode {
  const { name, label, icons, id } = node.props as IconProps;
  const attrs: Props = { className: 'ui-icon', ...idAttr(id) };
  if (label !== undefined) attrs.title = label;
  else attrs['aria-hidden'] = 'true';
  return h('span', attrs, iconForm(name, 'html', icons));
}

function expanderMark(open: boolean): VNode {
  return h('span', {
    className: `ui-expander${open ? ' is-open' : ''}`,
    'aria-hidden': 'true',
  });
}

function expanderHtml(node: VNode): VNode {
  const { open, onToggle, disabled, id } = node.props as ExpanderProps;
  const toggle = handlerOf<(next: boolean) => void>(onToggle);
  if (actions !== null && toggle !== undefined && disabled !== true) {
    const act = register(() => toggle(open !== true));
    return actionForm(
      {},
      h('button', {
        className: `ui-expander${open === true ? ' is-open' : ''}`,
        name: 'do',
        value: act,
        'aria-label': open === true ? 'Collapse' : 'Expand',
        ...idAttr(id),
      }),
    );
  }
  const mark = expanderMark(open === true);
  if (typeof id === 'string') mark.props.id = id;
  return mark;
}

function summaryRow(title: string, open: boolean, where: ExpanderPosition): NormalizedChild[] {
  const out: NormalizedChild[] = [];
  if (where === 'start') out.push(expanderMark(open));
  out.push(h('span', { className: 'ui-details-title' }, title));
  if (where === 'end') out.push(expanderMark(open));
  return out;
}

function detailsHtml(node: VNode): VNode {
  const { title, open, onToggle, expander, id } = node.props as DetailsProps;
  const where: ExpanderPosition = expander ?? 'start';
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
          {},
          h(
            'button',
            { className: 'ui-details-toggle ui-row', name: 'do', value: act },
            ...summaryRow(title, open === true, where),
          ),
        ),
      ),
      body,
    );
  }
  return h(
    'details',
    attrs,
    h(
      'summary',
      { className: 'ui-details-summary ui-row' },
      ...summaryRow(title, open === true, where),
    ),
    body,
  );
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
  return actions !== null && change !== undefined ? actionForm({}, nav) : nav;
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
  return actions !== null && select !== undefined ? actionForm({}, list) : list;
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
    return row(actionForm({}, h('button', button, ...menuRowContent({ label, detail, glyph }))));
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
    {},
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
      {},
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
  return actions !== null && navigate !== undefined ? actionForm({}, nav) : nav;
}

function paginationHtml(node: VNode): VNode {
  const { page, pages, onChange, siblings, id } = node.props as PaginationProps;
  const change = handlerOf<(page: number) => void>(onChange);
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  const range = paginationRange(current, total, siblings);
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
  const pageButton = (target: number): VNode => {
    const isCurrent = target === current;
    const attrs: Props = {
      className: `ui-button ui-pager-page${isCurrent ? ' is-current' : ''}`,
    };
    if (isCurrent) attrs['aria-current'] = 'page';
    if (actions !== null && change !== undefined && !isCurrent) {
      attrs.name = 'do';
      attrs.value = register(() => change(target));
    } else {
      attrs.type = 'button';
      if (isCurrent || change === undefined) attrs.disabled = true;
    }
    return h('button', attrs, String(target));
  };
  const nav = h(
    'nav',
    { className: 'ui-pager', ...idAttr(id) },
    step(current - 1, current <= 1, '‹'),
    ...range.map((entry) =>
      entry === 'ellipsis' ? h('span', { className: 'ui-pager-ellipsis' }, '…') : pageButton(entry),
    ),
    step(current + 1, current >= total, '›'),
  );
  return actions !== null && change !== undefined ? actionForm({}, nav) : nav;
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
  const { columns, rows, selectedIndex, onSelectRow } = node.props as TableProps;
  const select = handlerOf<(index: number) => void>(onSelectRow);
  const interactive = actions !== null && select !== undefined;
  const cellStyle = (align: 'start' | 'end' | undefined): Props =>
    align === 'end' ? { style: { textAlign: 'right' } } : {};
  const table = h(
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
      ...rows.map((row, index) => {
        // Every cell of a row shares one action id: a <tr> cannot be a
        // button, so each cell's content is a full-width submit button.
        const act = interactive ? register(() => select!(index)) : null;
        return h(
          'tr',
          index === selectedIndex ? { className: 'is-selected' } : {},
          ...columns.map((column) => {
            const text = row[column.key] ?? '';
            return h(
              'td',
              cellStyle(column.align),
              act !== null
                ? h('button', { className: 'ui-row-select', name: 'do', value: act }, text)
                : text,
            );
          }),
        );
      }),
    ),
  );
  return interactive ? actionForm({}, table) : table;
}

interface TreeContext {
  icons?: Record<string, string>;
  folderIcons?: { open: string; closed: string };
  toggle?: (key: string) => void;
  select?: (key: string) => void;
}

function treeNodesHtml(
  nodes: FileTreeNode[],
  expanded: string[],
  selectedKey: string | null | undefined,
  ctx: TreeContext,
): VNode[] {
  return nodes.map((entry) => {
    const selected = entry.key === selectedKey;
    const dir = entry.children !== undefined;
    const open = dir && expanded.includes(entry.key);
    const glyph = iconForm(fileIcon(entry, ctx.icons, open, ctx.folderIcons), 'html');
    if (dir) {
      const attrs: Props = { className: 'ui-tree-dir' };
      if (open) attrs.open = true;
      // The icon IS the expander: it toggles, the name selects. With no
      // select handler the name toggles too, so the whole row expands.
      // Registered in visual order so ids follow the markup.
      const toggleId =
        actions !== null && ctx.toggle !== undefined
          ? register(() => ctx.toggle!(entry.key))
          : null;
      const selectId =
        actions !== null && ctx.select !== undefined
          ? register(() => ctx.select!(entry.key))
          : null;
      const children = h(
        'div',
        { className: 'ui-tree-children' },
        ...treeNodesHtml(entry.children!, expanded, selectedKey, ctx),
      );
      const icon =
        toggleId !== null
          ? h(
              'button',
              {
                className: 'ui-tree-icon',
                name: 'do',
                value: toggleId,
                'aria-label': open ? 'Collapse' : 'Expand',
              },
              glyph,
            )
          : h('span', { className: 'ui-tree-icon' }, glyph);
      const nameAct = selectId ?? toggleId;
      const name =
        nameAct !== null
          ? h('button', { className: 'ui-tree-name', name: 'do', value: nameAct }, entry.label)
          : h('span', { className: 'ui-tree-name' }, entry.label);
      return h(
        'details',
        attrs,
        h('summary', { className: `ui-tree-row${selected ? ' is-selected' : ''}` }, icon, name),
        children,
      );
    }
    const content = [
      h('span', { className: 'ui-tree-icon' }, glyph),
      h('span', { className: 'ui-tree-name' }, entry.label),
    ];
    if (actions !== null && ctx.select !== undefined) {
      const act = register(() => ctx.select!(entry.key));
      return h(
        'button',
        {
          className: `ui-tree-leaf ui-tree-row${selected ? ' is-selected' : ''}`,
          name: 'do',
          value: act,
        },
        ...content,
      );
    }
    return h(
      'div',
      { className: `ui-tree-leaf ui-tree-row${selected ? ' is-selected' : ''}` },
      ...content,
    );
  });
}

function fileTreeHtml(node: VNode): VNode {
  const { nodes, expanded, selectedKey, icons, folderIcons, onToggle, onSelect, id } =
    node.props as FileTreeProps;
  const toggle = handlerOf<(key: string) => void>(onToggle);
  const select = handlerOf<(key: string) => void>(onSelect);
  const ctx: TreeContext = { icons, folderIcons, toggle, select };
  const tree = h(
    'div',
    { className: 'ui-tree', ...idAttr(id) },
    ...treeNodesHtml(nodes, expanded ?? [], selectedKey, ctx),
  );
  return actions !== null && (toggle !== undefined || select !== undefined)
    ? actionForm({}, tree)
    : tree;
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

// Fixed row height (px) for `ui:virtual-list` in the HTML target. The
// container's height and its top/bottom spacers all size off this same
// constant, and it rides along as `data-fi-row-height` so the client can
// convert a scroll container's `scrollTop` back into the row-offset unit
// `VirtualScroll` works in — see internal:ui/web/client's scroll listener.
const VIRTUAL_ROW_PX = 24;

function virtualSpacerHtml(rows: number): VNode {
  return h('div', {
    style: { height: `${rows * VIRTUAL_ROW_PX}px`, flex: '0 0 auto' },
    'aria-hidden': 'true',
  });
}

/**
 * `ui:virtual-list` on the web: there is no wheel event to hook, so instead
 * of `onMouse` this wires `onScroll` to a real scrollable `<div>` — marked
 * `data-fi-scroll` with its row height, and (when interactive) wrapped in an
 * action form carrying a hidden `value` field the client fills in with the
 * scrolled-to row before submitting. Without an `onScroll` handler the
 * container renders inert, same as any other handler-less control.
 */
function virtualListHtml(node: VNode): VNode {
  const {
    height,
    window: slice,
    offset,
    onMouse: _onMouse,
    onScroll,
    id,
    ...rest
  } = node.props as VirtualListProps;
  const scroll = handlerOf<(offset: number) => void>(onScroll);
  const css: Record<string, string> = {
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
  };
  sizeCss(rest, css);
  flexChildCss(rest, css);
  styleCss(resolveStyle(rest as Props), css);
  css.height = `${Math.max(1, Math.floor(height)) * VIRTUAL_ROW_PX}px`;
  const children = transformChildren(node.children);
  const attrs: Props = { className: 'ui-virtual', style: css, ...idAttr(id) };
  const interactive = actions !== null && scroll !== undefined;
  if (interactive) {
    attrs['data-fi-scroll'] = '1';
    attrs['data-fi-row-height'] = String(VIRTUAL_ROW_PX);
  }
  const container = h(
    'div',
    attrs,
    slice.topPad > 0 ? virtualSpacerHtml(slice.topPad) : null,
    ...children,
    slice.bottomPad > 0 ? virtualSpacerHtml(slice.bottomPad) : null,
  );
  if (!interactive) return container;
  const act = register((value) => scroll!(Number(value ?? 0)));
  return actionForm(
    { act, change: true },
    h('input', { type: 'hidden', name: 'value', value: String(Math.max(0, Math.floor(offset))) }),
    container,
  );
}

function headingHtml(node: VNode): VNode {
  const { level, id } = node.props as HeadingProps;
  const lvl = Math.min(6, Math.max(1, Math.floor((level as number | undefined) ?? 1)));
  return h(
    `h${lvl}`,
    { className: `ui-heading ui-heading-${lvl}`, ...idAttr(id) },
    ...transformChildren(node.children),
  );
}

function inlineStyleAttrs(rest: Props, id: unknown): Props {
  const css: Record<string, string> = {};
  styleCss(resolveStyle(rest as Props), css);
  const attrs: Props = { ...idAttr(id) };
  if (Object.keys(css).length > 0) attrs.style = css;
  return attrs;
}

function boldHtml(node: VNode): VNode {
  const { id, ...rest } = node.props as BoldProps;
  return h('strong', inlineStyleAttrs(rest as Props, id), ...transformChildren(node.children));
}

function italicHtml(node: VNode): VNode {
  const { id, ...rest } = node.props as ItalicProps;
  return h('em', inlineStyleAttrs(rest as Props, id), ...transformChildren(node.children));
}

// Schemes and relative forms an <a href> may carry. Anything else — most
// dangerously `javascript:`/`vbscript:`/`data:` — is app-controlled content
// (chat messages, agent output, file metadata) that must never reach a live
// anchor, so it is dropped rather than escaped.
const SAFE_HREF_SCHEME = /^(?:https?|mailto|tel):/i;
const SAFE_HREF_RELATIVE = /^(?:\/|\.\/|\.\.\/|#|\?)/;

/**
 * Validate a `Link` `href` before it reaches markup. Browsers ignore ASCII
 * control characters (tabs, newlines, NUL) inside a URL scheme, so
 * `java\tscript:` parses as `javascript:` — control characters are stripped
 * first so that bypass can't slip past the scheme check. Returns the
 * cleaned href when it is `http(s):`, `mailto:`, `tel:`, or a relative form
 * (`/…`, `./…`, `../…`, `#…`, `?…`); anything else — including unrecognized
 * schemes — returns `undefined`.
 */
function safeHref(raw: unknown): string | undefined {
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
// its text, styled, just without a `href` attribute.
function linkHtml(node: VNode): VNode {
  const { href, onActivate, id } = node.props as LinkProps;
  const activate = handlerOf<() => void>(onActivate);
  const kids = transformChildren(node.children);
  const safe = safeHref(href);
  const hasHref = safe !== undefined;
  if (activate !== undefined) {
    if (actions !== null) {
      const act = register(() => activate());
      if (hasHref) {
        return actionForm(
          { act },
          h(
            'a',
            {
              className: 'ui-link',
              href: safe,
              onclick: 'event.preventDefault();this.form.requestSubmit();',
              ...idAttr(id),
            },
            ...kids,
          ),
        );
      }
      return actionForm(
        {},
        h('button', { className: 'ui-link', name: 'do', value: act, ...idAttr(id) }, ...kids),
      );
    }
    return hasHref
      ? h('a', { className: 'ui-link', href: safe, ...idAttr(id) }, ...kids)
      : h('button', { className: 'ui-link', type: 'button', ...idAttr(id) }, ...kids);
  }
  if (hasHref) return h('a', { className: 'ui-link', href: safe, ...idAttr(id) }, ...kids);
  return h('span', { className: 'ui-link', ...idAttr(id) }, ...kids);
}

function blockquoteHtml(node: VNode): VNode {
  const { id } = node.props as BlockquoteProps;
  return h(
    'blockquote',
    { className: 'ui-blockquote', ...idAttr(id) },
    ...transformChildren(node.children),
  );
}

function listHtml(node: VNode): VNode {
  const { ordered, items, id } = node.props as ListProps;
  const tag = ordered === true ? 'ol' : 'ul';
  return h(
    tag,
    { className: 'ui-list', ...idAttr(id) },
    ...items.map((item, index) => transformNode(h('li', { key: String(index) }, item))),
  );
}

const CODE_TOK: Record<'keyword' | 'string' | 'number' | 'comment' | 'regexp', string> = {
  keyword: 'tok-keyword',
  string: 'tok-string',
  number: 'tok-number',
  comment: 'tok-comment',
  regexp: 'tok-regexp',
};

function codeHtml(node: VNode): VNode {
  const {
    code: source,
    language,
    showLineNumbers,
    filename,
    copyable,
    id,
  } = node.props as CodeProps;
  const lines = highlightLines(source, language);
  const codeClass =
    typeof language === 'string' && language.length > 0 ? `language-${language}` : undefined;
  const body = lines.map((runs, index) =>
    h(
      'span',
      { className: 'ui-code-line' },
      showLineNumbers === true ? h('span', { className: 'ui-code-num' }, String(index + 1)) : null,
      h(
        'span',
        { className: 'ui-code-content' },
        ...runs.map((run) =>
          run.cls ? h('span', { className: CODE_TOK[run.cls] }, run.text) : run.text,
        ),
      ),
    ),
  );
  const pre = h(
    'pre',
    null,
    h('code', codeClass !== undefined ? { className: codeClass } : null, ...body),
  );
  // The copy button reads its sibling <code>'s textContent client-side
  // (internal:ui/web/client's `[data-fi-copy]` listener) rather than
  // duplicating the (potentially large) source into a data-* attribute.
  const bar =
    filename !== undefined || copyable === true
      ? h(
          'figcaption',
          { className: 'ui-code-bar' },
          h('span', { className: 'ui-code-filename' }, filename ?? ''),
          copyable === true
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ui-copy',
                  'aria-label': 'Copy code',
                  'data-fi-copy': '1',
                },
                'Copy',
              )
            : null,
        )
      : null;
  return h('figure', { className: 'ui-code', ...idAttr(id) }, bar, pre);
}

function inlineCodeHtml(node: VNode): VNode {
  const { id, ...rest } = node.props as InlineCodeProps;
  const attrs = inlineStyleAttrs(rest as Props, id);
  attrs.className = 'ui-inline-code';
  return h('code', attrs, ...transformChildren(node.children));
}

const NATIVE: Record<string, (node: VNode) => VNode> = {
  'ui:panel': panelHtml,
  'ui:field': fieldHtml,
  'ui:fieldset': fieldsetHtml,
  'ui:button': buttonHtml,
  'ui:icon-button': iconButtonHtml,
  'ui:checkbox': (node) => choiceHtml('checkbox', node),
  'ui:switch': (node) => choiceHtml('checkbox', node),
  'ui:radio': (node) => choiceHtml('radio', node),
  'ui:radio-group': radioGroupHtml,
  'ui:text-input': textInputHtml,
  'ui:text-area': textAreaHtml,
  'ui:number-input': numberInputHtml,
  'ui:slider': sliderHtml,
  'ui:combobox': comboBoxHtml,
  'ui:select': selectHtml,
  'ui:details': detailsHtml,
  'ui:expander': expanderHtml,
  'ui:icon': iconHtml,
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
  'ui:virtual-list': virtualListHtml,
  'ui:heading': headingHtml,
  'ui:bold': boldHtml,
  'ui:italic': italicHtml,
  'ui:link': linkHtml,
  'ui:blockquote': blockquoteHtml,
  'ui:list': listHtml,
  'ui:code': codeHtml,
  'ui:inline-code': inlineCodeHtml,
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
    actions = {
      collector: options.actions,
      fields: options.fields ?? {},
      ref: options.action ?? null,
      next: 0,
    };
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
.ui-copy {
  opacity: 0; flex: none; background: var(--ui-surface);
  border: 1px solid var(--ui-border-strong); border-radius: 0.25rem;
  padding: 0.125rem 0.5rem; font: inherit; color: inherit; cursor: pointer;
  transition: opacity 0.1s;
}
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
