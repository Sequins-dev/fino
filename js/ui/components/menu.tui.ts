/** Terminal lowerings for menu components. @internal */
import { h } from 'fino:ui';
import type { Props, UiKeyEvent } from 'fino:ui';
import { Box, Clickable, Input, Rule, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { dismissOnEscape, moveSelectedKey } from 'internal:ui/components/interaction';
import {
  ComboBox,
  MenuHeader,
  MenuList,
  MenuRow,
  MenuSeparator,
  Select,
  defaultComboBoxFilter,
  menuWindow,
} from 'internal:ui/components/menu';
import type { MenuItem } from 'internal:ui/components/menu';
import { Popover } from 'internal:ui/components/overlay';
import { applyTextEdit } from 'internal:ui/components/text-edit';
import { mapComponentLowering } from 'internal:ui/components/target';

mapComponentLowering(MenuRow, 'tui', (props) => {
  const { label, detail, glyph, marker, selected, disabled, onClick, id, ...rest } = props;
  return h(
    Clickable,
    {
      ...rest,
      id,
      direction: 'row',
      gap: 1,
      disabled,
      onClick,
      focusable: false,
    } as Props,
    h(
      Text,
      { style: selected === true ? [styles.accent, styles.bold] : [styles.dim] },
      selected ? (marker ?? '▸') : ' ',
    ),
    glyph === undefined ? null : h(Text, null, glyph),
    h(
      Text,
      { style: disabled === true ? [styles.dim] : selected === true ? [styles.bold] : [] },
      label,
    ),
    detail === undefined ? null : h(Text, { style: [styles.dim] }, detail),
  );
});

mapComponentLowering(MenuHeader, 'tui', (props) =>
  h(Text, { style: [styles.dim, styles.bold] }, props.label),
);

mapComponentLowering(MenuSeparator, 'tui', () => h(Rule, { style: [styles.dim] }));

mapComponentLowering(MenuList, 'tui', (props) => {
  const { items, selectedKey, top, maxRows, marker, onSelect, id, ...rest } = props;
  const { visible, remaining } = menuWindow(items, top, maxRows);
  return h(
    Box,
    { ...rest, direction: 'column', id } as Props,
    ...visible.map((item, index) => {
      if (item.kind === 'header') {
        return h(MenuHeader, { key: `h:${index}`, label: item.label });
      }
      if (item.kind === 'separator') return h(MenuSeparator, { key: `s:${index}` });
      return h(MenuRow, {
        key: item.key,
        id: id === undefined ? undefined : `${id}:${item.key}`,
        label: item.label,
        detail: item.detail,
        glyph: item.glyph,
        marker,
        selected: item.key === selectedKey,
        disabled: item.disabled,
        onClick:
          onSelect === undefined || item.disabled === true ? undefined : () => onSelect(item.key),
      });
    }),
    remaining > 0 ? h(Text, { style: [styles.dim] }, `… ${remaining} more`) : null,
  );
});

mapComponentLowering(Select, 'tui', (props) => {
  const {
    value,
    options,
    open,
    onOpenChange,
    onChange,
    placeholder,
    focused,
    disabled,
    id,
    ...rest
  } = props;
  const current = options.find((option) => option.key === value);
  const close = onOpenChange === undefined ? undefined : () => onOpenChange(false);
  const dismiss = dismissOnEscape(close);
  const handleKey = (event: UiKeyEvent): boolean => {
    if (disabled === true || event.ctrl === true || event.alt === true) return false;
    if (open && dismiss?.(event) === true) return true;
    if (event.key !== 'up' && event.key !== 'down') return false;
    const next = moveSelectedKey(options, value, event.key === 'down' ? 1 : -1);
    if (next !== null && next !== value) onChange?.(next);
    if (!open) onOpenChange?.(true);
    return true;
  };
  return h(
    Box,
    { ...rest, direction: 'column' } as Props,
    h(
      Clickable,
      {
        id,
        direction: 'row',
        gap: 1,
        disabled,
        onClick: onOpenChange === undefined ? undefined : () => onOpenChange(!open),
        onKey: handleKey,
      },
      h(
        Text,
        { style: current === undefined ? [styles.dim] : [] },
        current?.label ?? placeholder ?? 'Select…',
      ),
      h(Text, { style: focused === true ? [styles.accent] : [styles.dim] }, open ? '▴' : '▾'),
    ),
    h(
      Popover,
      { open, anchorId: id, onDismiss: close },
      h(MenuList, {
        items: options,
        selectedKey: value,
        id: `${id}:menu`,
        onSelect:
          onChange === undefined
            ? undefined
            : (key) => {
                onChange(key);
                close?.();
              },
      }),
    ),
  );
});

mapComponentLowering(ComboBox, 'tui', (props) => {
  const {
    value,
    options,
    open,
    onOpenChange,
    onInput,
    onSelect,
    activeKey,
    onActiveChange,
    placeholder,
    caret,
    selection,
    focused,
    disabled,
    filter,
    id,
    ...rest
  } = props;
  const filtered = (filter ?? defaultComboBoxFilter)(options, value);
  const close = onOpenChange === undefined ? undefined : () => onOpenChange(false);
  const dismiss = dismissOnEscape(close);
  const handleKey = (event: UiKeyEvent): boolean => {
    if (disabled === true || event.ctrl === true) return false;
    if (open && dismiss?.(event) === true) return true;
    if (event.key === 'down' || (event.key === 'up' && open)) {
      if (!open) onOpenChange?.(true);
      const next = moveSelectedKey(filtered, activeKey, event.key === 'down' ? 1 : -1);
      if (next !== activeKey) onActiveChange?.(next);
      return true;
    }
    if (event.key === 'enter' && open && activeKey !== null && activeKey !== undefined) {
      const option = filtered.find((entry) => entry.key === activeKey && entry.disabled !== true);
      if (option !== undefined) {
        onSelect?.(option.key);
        close?.();
        return true;
      }
    }
    const next = applyTextEdit({ value, caret: caret ?? value.length, selection }, event);
    if (next === null || onInput === undefined) return false;
    onInput(next.value, next.caret, next.selection);
    if (!open) onOpenChange?.(true);
    return true;
  };
  const items: readonly MenuItem[] =
    filtered.length > 0 ? filtered : [{ kind: 'header', label: 'No matches' }];
  return h(
    Box,
    { ...rest, direction: 'column' } as Props,
    h(
      Clickable,
      {
        id,
        onKey: handleKey,
        disabled,
        onClick: disabled === true ? undefined : () => onOpenChange?.(true),
      },
      h(Input, { value, placeholder, caret, selection, focused }),
    ),
    h(
      Popover,
      { open, anchorId: id, onDismiss: close },
      h(MenuList, {
        items,
        selectedKey: activeKey,
        id: `${id}:menu`,
        onSelect:
          onSelect === undefined
            ? undefined
            : (key) => {
                onSelect(key);
                close?.();
              },
      }),
    ),
  );
});
