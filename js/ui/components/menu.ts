/**
 * Host-neutral menu, select, and combobox components.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import type { FlexChildProps, StyleProps, TextSelection, UiKeyEvent } from 'fino:ui/components';
import { moveSelectedKey } from 'internal:ui/components/interaction';

/** Entries accepted by {@link MenuList} and {@link ListSelection}. */
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

/** Whether a menu item can receive selection. */
export function isSelectableMenuItem(item: MenuItem): item is Extract<MenuItem, { key: string }> {
  return (item.kind === undefined || item.kind === 'item') && item.disabled !== true;
}

/** Deterministic menu window shared by HTML and terminal lowerings. */
export function menuWindow(
  items: readonly MenuItem[],
  top?: number,
  maxRows?: number,
): { visible: readonly MenuItem[]; remaining: number } {
  const start = Math.max(0, Math.floor(top ?? 0));
  const end =
    maxRows === undefined
      ? items.length
      : Math.min(items.length, start + Math.max(1, Math.floor(maxRows)));
  return { visible: items.slice(start, end), remaining: Math.max(0, items.length - end) };
}

function selectable(items: readonly MenuItem[]): Array<Extract<MenuItem, { key: string }>> {
  return items.filter(isSelectableMenuItem);
}

/**
 * Stateful menu-list selection with disabled/header skipping and a viewport
 * that follows the selected row.
 */
export class ListSelection {
  #items: MenuItem[] = [];
  #selected: string | null = null;
  #top = 0;
  #maxRows: number;

  constructor(options: { maxRows?: number } = {}) {
    this.#maxRows = normalizeMaxRows(options.maxRows);
  }

  /** Replace the visible row budget and re-snap the selection window. */
  setMaxRows(rows: number): void {
    this.#maxRows = normalizeMaxRows(rows);
    this.#snap();
  }

  /** Replace menu items, retaining a still-selectable key by default. */
  setItems(items: readonly MenuItem[], options: { keepKey?: boolean } = {}): void {
    this.#items = [...items];
    const keys = selectable(this.#items).map((item) => item.key);
    if (!(options.keepKey !== false && this.#selected !== null && keys.includes(this.#selected))) {
      this.#selected = keys[0] ?? null;
    }
    this.#snap();
  }

  /** Current immutable item view. */
  get items(): readonly MenuItem[] {
    return this.#items;
  }

  /** Current selected key, or null when nothing is selectable. */
  get selectedKey(): string | null {
    return this.#selected;
  }

  /** Current selected item. */
  get selected(): MenuItem | undefined {
    return this.#items.find((item) => isSelectableMenuItem(item) && item.key === this.#selected);
  }

  /** First visible item index. */
  get top(): number {
    return this.#top;
  }

  /** Maximum visible rows. */
  get maxRows(): number {
    return this.#maxRows;
  }

  /** Select an enabled item by key. */
  selectKey(key: string): boolean {
    if (!this.#items.some((item) => isSelectableMenuItem(item) && item.key === key)) return false;
    if (key === this.#selected) return false;
    this.#selected = key;
    this.#snap();
    return true;
  }

  /** Move through enabled items without wrapping. */
  move(delta: number): boolean {
    const next = moveSelectedKey(selectable(this.#items), this.#selected, delta);
    if (next === null || next === this.#selected) return false;
    this.#selected = next;
    this.#snap();
    return true;
  }

  /** Move by one visible page. */
  movePage(direction: 1 | -1): boolean {
    const page = Number.isFinite(this.#maxRows) ? Math.max(1, this.#maxRows - 1) : 10;
    return this.move(direction * page);
  }

  /** Route standard vertical list-navigation keys. */
  handleKey(event: UiKeyEvent): boolean {
    if (event.ctrl === true || event.alt === true) return false;
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
      (item) => isSelectableMenuItem(item) && item.key === this.#selected,
    );
    if (index === -1) {
      this.#top = 0;
      return;
    }
    if (index < this.#top) this.#top = index;
    if (index >= this.#top + this.#maxRows) this.#top = index - this.#maxRows + 1;
    const lastTop = Math.max(0, this.#items.length - this.#maxRows);
    this.#top = Math.max(0, Math.min(this.#top, lastTop));
  }
}

function normalizeMaxRows(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(rows));
}

/** Props accepted by {@link MenuRow}. */
export interface MenuRowProps extends StyleProps, FlexChildProps, Props {
  label: string;
  detail?: string;
  glyph?: string;
  marker?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

/** One selectable menu row. */
export function MenuRow(props: MenuRowProps): VNode {
  return h('ui:menu-row', props);
}

/** Props accepted by {@link MenuHeader}. */
export interface MenuHeaderProps extends StyleProps, FlexChildProps, Props {
  label: string;
}

/** Section heading inside a menu. */
export function MenuHeader(props: MenuHeaderProps): VNode {
  return h('ui:menu-header', props);
}

/** Divider inside a menu. */
export function MenuSeparator(props: StyleProps & FlexChildProps & Props = {}): VNode {
  return h('ui:menu-separator', props);
}

/** Props accepted by {@link MenuList}. */
export interface MenuListProps extends StyleProps, FlexChildProps, Props {
  items: readonly MenuItem[];
  selectedKey?: string | null;
  /** First visible row when windowing. */
  top?: number;
  /** Maximum visible rows. */
  maxRows?: number;
  marker?: string;
  onSelect?: (key: string) => void;
}

/** Menu rendered from data with optional windowing. */
export function MenuList(props: MenuListProps): VNode {
  return h('ui:menu-list', props);
}

/** One option in {@link Select} or {@link ComboBox}. */
export interface SelectOption {
  key: string;
  label: string;
  disabled?: boolean;
}

/** Props accepted by {@link Select}. */
export interface SelectProps extends StyleProps, FlexChildProps, Props {
  value: string | null;
  options: readonly SelectOption[];
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onChange?: (key: string) => void;
  placeholder?: string;
  focused?: boolean;
  disabled?: boolean;
  /** Stable trigger id used to anchor the option surface. */
  id: string;
}

/** Controlled select trigger with an anchored option list. */
export function Select(props: SelectProps): VNode {
  return h('ui:select', props);
}

/** One option in a {@link ComboBox} list. */
export type ComboBoxOption = SelectOption;

/** Default case-insensitive substring filter for combobox options. */
export function defaultComboBoxFilter(
  options: readonly ComboBoxOption[],
  query: string,
): ComboBoxOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...options];
  return options.filter((option) => option.label.toLowerCase().includes(needle));
}

/** Props accepted by {@link ComboBox}. */
export interface ComboBoxProps extends StyleProps, FlexChildProps, Props {
  value: string;
  options: readonly ComboBoxOption[];
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onInput?: (value: string, caret?: number, selection?: TextSelection | null) => void;
  onSelect?: (key: string) => void;
  activeKey?: string | null;
  onActiveChange?: (key: string | null) => void;
  placeholder?: string;
  caret?: number;
  selection?: TextSelection | null;
  focused?: boolean;
  disabled?: boolean;
  filter?: (options: readonly ComboBoxOption[], query: string) => ComboBoxOption[];
  /** Stable trigger id used to anchor the result surface. */
  id: string;
}

/** Editable text field with a filtered, anchored option list. */
export function ComboBox(props: ComboBoxProps): VNode {
  return h('ui:combo-box', props);
}
