/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/menu.tui — terminal forms for menu rows, selects, and combo boxes.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { Box, Clickable, Input, Layer, Rule, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { applyTextEdit } from 'internal:ui/components/text-edit';
import { MenuHeader, MenuSeparator, defaultComboBoxFilter } from 'internal:ui/components/menu';
import { ComboBox, MenuList, MenuRow, Select } from 'internal:ui/components/menu';
import type {
  ComboBoxProps,
  MenuListProps,
  MenuRowProps,
  SelectProps,
} from 'internal:ui/components/menu';

mapRenderTargetLowering(MenuRow, 'tui', (all: MenuRowProps): VNode => {
  const { children = [], ...props } = all as MenuRowProps & { children?: NormalizedChild[] };
  const { label, detail, glyph, marker, selected, disabled, onClick, id } = props;
  const mark = selected ? (marker ?? '▸') : ' ';
  return (
    <Clickable
      id={id}
      direction="row"
      gap={1}
      disabled={disabled}
      onClick={onClick}
      focusable={false}
    >
      <Text style={selected ? [styles.accent, styles.bold] : [styles.dim]}>{mark}</Text>
      {glyph !== undefined ? <Text>{glyph}</Text> : null}
      <Text style={disabled ? [styles.dim] : selected ? [styles.bold] : []}>{label}</Text>
      {detail !== undefined ? <Text style={[styles.dim]}>{detail}</Text> : null}
    </Clickable>
  );
});

mapRenderTargetLowering(MenuList, 'tui', (all: MenuListProps): VNode => {
  const { children = [], ...props } = all as MenuListProps & { children?: NormalizedChild[] };
  const { items, selectedKey, top, maxRows, marker, onSelect, id } = props;
  const start = top ?? 0;
  const end = maxRows !== undefined ? start + maxRows : items.length;
  const visible = items.slice(start, end);
  const remaining = items.length - end;
  return (
    <Box direction="column" id={id}>
      {visible.map((item, index) => {
        if (item.kind === 'header') return <MenuHeader key={`h${index}`} label={item.label} />;
        if (item.kind === 'separator') return <MenuSeparator key={`s${index}`} />;
        return (
          <MenuRow
            key={item.key}
            id={id !== undefined ? `${id}:${item.key}` : undefined}
            label={item.label}
            detail={item.detail}
            glyph={item.glyph}
            marker={marker}
            selected={item.key === selectedKey}
            disabled={item.disabled}
            onClick={onSelect && !item.disabled ? () => onSelect(item.key) : undefined}
          />
        );
      })}
      {remaining > 0 ? <Text style={[styles.dim]}>{`… ${remaining} more`}</Text> : null}
    </Box>
  );
});

mapRenderTargetLowering(Select, 'tui', (all: SelectProps): VNode => {
  const { children = [], ...props } = all as SelectProps & { children?: NormalizedChild[] };
  const { value, options, open, onOpenChange, onChange, placeholder, focused, id } =
    props;
  const current = options.find((option) => option.key === value);
  const label = current?.label ?? placeholder ?? 'Select…';
  return (
    <Box direction="column">
      <Clickable
        id={id}
        direction="row"
        gap={1}
        onClick={() => onOpenChange(!open)}
        onKey={(event) => {
          if (event.ctrl || event.alt) return false;
          if (event.key === 'escape' && open) {
            onOpenChange(false);
            return true;
          }
          if (event.key === 'up' || event.key === 'down') {
            const keys = options.filter((option) => !option.disabled).map((option) => option.key);
            if (keys.length === 0) return false;
            const index = value === null ? -1 : keys.indexOf(value);
            const next =
              event.key === 'down'
                ? keys[Math.min(keys.length - 1, index + 1)]
                : keys[Math.max(0, index === -1 ? 0 : index - 1)];
            if (next !== undefined && next !== value) onChange(next);
            return true;
          }
          return false;
        }}
      >
        <Text style={current ? [] : [styles.dim]}>{label}</Text>
        <Text style={focused ? [styles.accent] : [styles.dim]}>{open ? '▴' : '▾'}</Text>
      </Clickable>
      {open ? (
        <Layer anchorId={id}>
          <Box border paddingX={1}>
            <MenuList
              items={options}
              selectedKey={value}
              id={`${id}:menu`}
              onSelect={(key) => {
                onChange(key);
                onOpenChange(false);
              }}
            />
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
});

mapRenderTargetLowering(ComboBox, 'tui', (all: ComboBoxProps): VNode => {
  const { children = [], ...props } = all as ComboBoxProps & { children?: NormalizedChild[] };
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
  } = props;
  const filtered = (filter ?? defaultComboBoxFilter)(options, value);
  const selectable = filtered.filter((option) => option.disabled !== true);
  const moveActive = (delta: number): void => {
    if (onActiveChange === undefined || selectable.length === 0) return;
    const at = activeKey ? selectable.findIndex((option) => option.key === activeKey) : -1;
    const start = at === -1 ? (delta > 0 ? -1 : 0) : at;
    const next = Math.max(0, Math.min(selectable.length - 1, start + delta));
    onActiveChange(selectable[next]!.key);
  };
  const editKey = (event: UiKeyEvent): boolean => {
    if (event.ctrl) return false;
    if (event.key === 'escape' && open) {
      onOpenChange(false);
      return true;
    }
    if (event.key === 'down') {
      if (!open) onOpenChange(true);
      moveActive(1);
      return true;
    }
    if (event.key === 'up' && open) {
      moveActive(-1);
      return true;
    }
    if (event.key === 'enter' && open && activeKey !== undefined && activeKey !== null) {
      onSelect(activeKey);
      onOpenChange(false);
      return true;
    }
    const next = applyTextEdit({ value, caret: caret ?? value.length, selection }, event);
    if (next === null) return false;
    if (!open) onOpenChange(true);
    onInput(next.value, next.caret, next.selection);
    return true;
  };
  const items: MenuItem[] =
    filtered.length > 0 ? filtered : [{ kind: 'header', label: 'No matches' }];
  return (
    <Box direction="column">
      <Clickable
        id={id}
        onKey={editKey}
        disabled={disabled}
        onClick={disabled === true ? undefined : () => onOpenChange(true)}
      >
        <Input
          value={value}
          placeholder={placeholder}
          caret={caret}
          selection={selection}
          focused={focused}
        />
      </Clickable>
      {open ? (
        <Layer anchorId={id}>
          <Box border paddingX={1}>
            <MenuList
              items={items}
              selectedKey={activeKey}
              id={`${id}:menu`}
              onSelect={(key) => {
                onSelect(key);
                onOpenChange(false);
              }}
            />
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
});

mapRenderTargetLowering(MenuHeader, 'tui', (props: { label: string }): VNode => (
  <Text style={[styles.dim, styles.bold]}>{props.label}</Text>
));
mapRenderTargetLowering(MenuSeparator, 'tui', (): VNode => <Rule style={[styles.dim]} />);
