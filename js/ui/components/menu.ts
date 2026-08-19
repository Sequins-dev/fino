/**
 * internal:ui/components/menu — menu rows and the two controls built on them:
 * `Select` and `ComboBox`, plus the `ListSelection` model.
 *
 * @internal
 */
import { h, type Props, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  changeAttrs,
  handlerOf,
  register,
} from 'internal:ui/components/html-runtime';
import type { TextSelection, UiKeyEvent } from 'internal:ui/components/primitives';

/** Entries accepted by `MenuList` and `ListSelection`. */
export type MenuItem =
  | {
      kind?: 'item';
      key: string;
      label: string;
      detail?: string;
      glyph?: string;
      disabled?: boolean;
    }
  | { kind: 'header'; label: string }
  | { kind: 'separator' };

function isSelectable(item: MenuItem): item is Extract<MenuItem, { key: string }> {
  return (
    (item.kind === undefined || item.kind === 'item') && !('disabled' in item && item.disabled)
  );
}

/**
 * Selection model for menu lists: a selected key, header-skipping movement,
 * and a scroll window that follows the selection. Lives outside the tree —
 * component functions cannot hold state across renders.
 */
export class ListSelection {
  #items: MenuItem[] = [];
  #selected: string | null = null;
  #top = 0;
  #maxRows: number;

  constructor(options: { maxRows?: number } = {}) {
    this.#maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  }

  setMaxRows(rows: number): void {
    this.#maxRows = rows;
    this.#snap();
  }

  setItems(items: MenuItem[], options: { keepKey?: boolean } = {}): void {
    this.#items = items;
    const keys = items.filter(isSelectable).map((item) => item.key);
    if (!(options.keepKey !== false && this.#selected !== null && keys.includes(this.#selected))) {
      this.#selected = keys[0] ?? null;
    }
    this.#snap();
  }

  get items(): readonly MenuItem[] {
    return this.#items;
  }

  get selectedKey(): string | null {
    return this.#selected;
  }

  get selected(): MenuItem | undefined {
    return this.#items.find((item) => isSelectable(item) && item.key === this.#selected);
  }

  get top(): number {
    return this.#top;
  }

  get maxRows(): number {
    return this.#maxRows;
  }

  selectKey(key: string): boolean {
    const found = this.#items.find((item) => isSelectable(item) && item.key === key);
    if (!found) return false;
    this.#selected = key;
    this.#snap();
    return true;
  }

  move(delta: number): boolean {
    const keys = this.#items.filter(isSelectable).map((item) => item.key);
    if (keys.length === 0) return false;
    const current = this.#selected === null ? -1 : keys.indexOf(this.#selected);
    const next = Math.max(0, Math.min(keys.length - 1, (current === -1 ? 0 : current) + delta));
    if (keys[next] === this.#selected) return false;
    this.#selected = keys[next]!;
    this.#snap();
    return true;
  }

  movePage(direction: 1 | -1): boolean {
    const page = Number.isFinite(this.#maxRows) ? Math.max(1, this.#maxRows - 1) : 10;
    return this.move(direction * page);
  }

  /** Route a key event: up/down/pageup/pagedown/home/end move the selection. */
  handleKey(event: UiKeyEvent): boolean {
    if (event.ctrl || event.alt) return false;
    switch (event.key) {
      case 'up':
        return this.move(-1);
      case 'down':
        return this.move(1);
      case 'pageup':
        return this.movePage(-1);
      case 'pagedown':
        return this.movePage(1);
      case 'home':
        return this.move(-this.#items.length);
      case 'end':
        return this.move(this.#items.length);
      default:
        return false;
    }
  }

  #snap(): void {
    if (!Number.isFinite(this.#maxRows)) {
      this.#top = 0;
      return;
    }
    const index = this.#items.findIndex(
      (item) => isSelectable(item) && item.key === this.#selected,
    );
    if (index === -1) return;
    if (index < this.#top) this.#top = index;
    if (index >= this.#top + this.#maxRows) this.#top = index - this.#maxRows + 1;
    this.#top = Math.max(0, Math.min(this.#top, Math.max(0, this.#items.length - this.#maxRows)));
  }
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

/**
 * The shared `<ul>` a menu renders as.
 *
 * Exported because `ContextMenu` builds its own popover around the same list
 * rather than nesting a `MenuList` inside a `Layer` — the two would each want
 * to own the surrounding element.
 */
export function menuUl(
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
      if (actionsActive() && select !== undefined && !disabled) {
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
  return actionsActive() && select !== undefined ? actionForm({}, list) : list;
}

/** Props accepted by `MenuRow`. */
export interface MenuRowProps extends Props {
  label: string;
  detail?: string;
  glyph?: string;
  marker?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  id?: string;
}
/** One selectable menu row: optional glyph, label, dim detail. */
export function MenuRow(all: MenuRowProps): VNode {
  const { children = [], ...props } = all as MenuRowProps & { children?: NormalizedChild[] };
  const { label, detail, glyph, selected, disabled, onClick, id } = props;
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
  if (actionsActive() && click !== undefined && disabled !== true) {
    button.name = 'do';
    button.value = register(() => click());
    return row(actionForm({}, h('button', button, ...menuRowContent({ label, detail, glyph }))));
  }
  button.type = 'button';
  if (disabled === true || click === undefined) button.disabled = true;
  return row(h('button', button, ...menuRowContent({ label, detail, glyph })));
}

/** Section heading inside a menu. */
export function MenuHeader(props: { label: string } & Props): VNode {
  return h('div', { className: 'ui-menu-header' }, props.label);
}

/** Divider inside a menu. */
export function MenuSeparator(): VNode {
  return h('hr', { className: 'ui-menu-sep' });
}

/** Props accepted by `MenuList`. */
export interface MenuListProps extends Props {
  items: readonly MenuItem[];
  selectedKey?: string | null;
  /** First visible row when windowing; pair with `maxRows`. */
  top?: number;
  maxRows?: number;
  marker?: string;
  onSelect?: (key: string) => void;
  /** Row ids become `${id}:${key}` for hit routing. */
  id?: string;
}
/** Menu rendered from data: rows, headers, separators, windowed by `top`/`maxRows`. */
export function MenuList(all: MenuListProps): VNode {
  const { children = [], ...props } = all as MenuListProps & { children?: NormalizedChild[] };
  const { items, selectedKey, top, maxRows, onSelect, id } = props;
  return menuUl(items, selectedKey, { top, maxRows, id, onSelect });
}

/** Props accepted by `Select`. */
export interface SelectProps extends Props {
  value: string | null;
  options: Array<{ key: string; label: string; disabled?: boolean }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (key: string) => void;
  placeholder?: string;
  focused?: boolean;
  /** Required for anchoring the popover to the trigger. */
  id: string;
}
/** Select box: a trigger and an option list that opens beneath it. */
export function Select(all: SelectProps): VNode {
  const { children = [], ...props } = all as SelectProps & { children?: NormalizedChild[] };
  const { value, options, placeholder, onChange, id } = props;
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
  if (actionsActive() && change !== undefined) {
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

/** One option in a `ComboBox` list. */
export interface ComboBoxOption {
  key: string;
  label: string;
  disabled?: boolean;
}

/**
 * Default `ComboBox` filter: a case-insensitive substring match over
 * `label`. An empty (or whitespace-only) query keeps every option.
 */
export function defaultComboBoxFilter(
  options: readonly ComboBoxOption[],
  query: string,
): ComboBoxOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...options];
  return options.filter((option) => option.label.toLowerCase().includes(needle));
}

/** Props accepted by `ComboBox`. */
export interface ComboBoxProps extends Props {
  /** The typed text — free-form, not necessarily an option's label or key. */
  value: string;
  options: readonly ComboBoxOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Typed-text change from editing, via `applyTextEdit` in the terminal. */
  onInput: (value: string, caret?: number, selection?: TextSelection | null) => void;
  onSelect: (key: string) => void;
  /**
   * The row highlighted while browsing the open list with arrow keys.
   * Separate from `value`, which is free-typed text rather than a picked
   * option — unlike `Select`, where the selected key doubles as the
   * highlighted row, `ComboBox` has no such value to borrow, so browsing
   * needs its own piece of state.
   */
  activeKey?: string | null;
  onActiveChange?: (key: string | null) => void;
  placeholder?: string;
  caret?: number;
  selection?: TextSelection | null;
  focused?: boolean;
  disabled?: boolean;
  /** Overrides the default substring match; see `defaultComboBoxFilter`. */
  filter?: (options: readonly ComboBoxOption[], query: string) => ComboBoxOption[];
  /** Required for anchoring the popover to the input. */
  id: string;
}
/**
 * Text input filtering a selectable list: typing narrows `options` (through
 * `filter`, defaulting to `defaultComboBoxFilter`) and opens an anchored
 * list beneath the input, built on `MenuList` the same way `Select` anchors
 * its popover.
 */
export function ComboBox(all: ComboBoxProps): VNode {
  const { children = [], ...props } = all as ComboBoxProps & { children?: NormalizedChild[] };
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
  } = props;
  const input = handlerOf<(value: string) => void>(onInput);
  const openChange = handlerOf<(open: boolean) => void>(onOpenChange);
  const filtered = (filter ?? defaultComboBoxFilter)(options, value ?? '');
  const attrs: Props = { className: 'ui-field', type: 'text', value: value ?? '' };
  if (placeholder !== undefined) attrs.placeholder = placeholder;
  let field: VNode;
  if (actionsActive() && input !== undefined && disabled !== true) {
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
  if (actionsActive() && openChange !== undefined && disabled !== true) {
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
