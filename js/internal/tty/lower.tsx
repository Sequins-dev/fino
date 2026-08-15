/** @jsxImportSource fino:ui */
/**
 * internal:tty/lower — lower semantic `ui:*` nodes to terminal primitives.
 *
 * The component catalog (`fino:ui/components`) emits purely semantic nodes: a
 * checkbox is `ui:checkbox` carrying `checked`/`label`/`onChange`, with no
 * presentation attached. This module owns the terminal look: each semantic
 * node lowers to the box/text/clickable composition the layout engine paints
 * (`[x]`, `●`, `▸`, `[ label ]`, `──●`, …), forwarding handlers onto the
 * lowered `Clickable`s. `fino:tty/tui` runs `lowerTui()` over every tree
 * before layout and reconciliation, so the retained tree and the event
 * dispatcher only ever see primitives.
 */
import { h, createSignal } from 'fino:ui';
import { timeout as loopTimeout } from '../runtime/loop.ts';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { stringWidth } from 'fino:tty/frame';
import { highlightLines } from 'fino:format/typescript';
import {
  applyTextAreaEdit,
  applyTextEdit,
  Box,
  Clickable,
  defaultComboBoxFilter,
  Expander,
  fileIcon,
  iconForm,
  Input,
  Layer,
  MenuHeader,
  MenuList,
  MenuRow,
  MenuSeparator,
  Panel,
  Radio,
  Rule,
  SPINNER_FRAMES,
  TabList,
  Text,
  Toast,
  paginationRange,
  styles,
} from 'fino:ui/components';
import type {
  BadgeProps,
  BlockquoteProps,
  BoldProps,
  BreadcrumbsProps,
  ButtonProps,
  CardProps,
  CheckboxProps,
  CodeProps,
  ComboBoxProps,
  ContextMenuProps,
  DetailsProps,
  EmptyStateProps,
  ExpanderProps,
  FieldProps,
  FieldsetProps,
  FileTreeNode,
  FileTreeProps,
  FloatingActionBarProps,
  HeadingProps,
  HoverCardProps,
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
  SpinnerProps,
  StatProps,
  StatusDotProps,
  StatusDotStatus,
  StepsProps,
  SwitchProps,
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
  Trend,
  UiKeyEvent,
  UiMouseEvent,
  VirtualListProps,
} from 'fino:ui/components';
import type { Style } from 'fino:tty/style';

type Composer = (props: Props, children: NormalizedChild[]) => VNode;

function panel(props: Props, children: NormalizedChild[]): VNode {
  const { title, ...rest } = props as PanelProps;
  return h(
    'box',
    {
      border: true,
      paddingX: 1,
      direction: 'column',
      ...rest,
      ...(title !== undefined ? { borderTitle: title } : {}),
    },
    children,
  );
}

function field(props: Props, children: NormalizedChild[]): VNode {
  const { label, hint, error, required, htmlFor: _htmlFor, id, ...rest } = props as FieldProps;
  return (
    <Box direction="column" id={id} {...rest}>
      <Box direction="row">
        <Text style={[styles.bold]}>{label}</Text>
        {required === true ? <Text style={[styles.danger, styles.bold]}>{' *'}</Text> : null}
      </Box>
      {children}
      {hint !== undefined ? <Text style={[styles.dim]}>{hint}</Text> : null}
      {error !== undefined ? <Text style={[styles.danger]}>{error}</Text> : null}
    </Box>
  );
}

function fieldset(props: Props, children: NormalizedChild[]): VNode {
  const { legend, ...rest } = props as FieldsetProps;
  return (
    <Box border paddingX={1} direction="column" borderTitle={legend} {...rest}>
      {children}
    </Box>
  );
}

function button(props: Props): VNode {
  const { label, onClick, focused, disabled, id, ...rest } = props as ButtonProps;
  return (
    <Clickable id={id} onClick={onClick} disabled={disabled} {...rest}>
      <Text
        style={disabled ? [styles.dim] : focused ? [styles.bold, styles.inverse] : []}
      >{`[ ${label} ]`}</Text>
    </Clickable>
  );
}

function checkbox(props: Props): VNode {
  const { checked, label, onChange, focused, disabled, id, ...rest } = props as CheckboxProps;
  return (
    <Clickable
      id={id}
      direction="row"
      gap={1}
      disabled={disabled}
      onClick={onChange ? () => onChange(!checked) : undefined}
      {...rest}
    >
      <Text style={disabled ? [styles.dim] : focused ? [styles.bold, styles.accent] : []}>
        {checked ? '[x]' : '[ ]'}
      </Text>
      {label !== undefined ? <Text dim={disabled}>{label}</Text> : null}
    </Clickable>
  );
}

function radio(props: Props): VNode {
  const { selected, label, onSelect, focused, disabled, id, ...rest } = props as RadioProps;
  return (
    <Clickable id={id} direction="row" gap={1} disabled={disabled} onClick={onSelect} {...rest}>
      <Text style={disabled ? [styles.dim] : focused ? [styles.bold, styles.accent] : []}>
        {selected ? '●' : '○'}
      </Text>
      {label !== undefined ? <Text dim={disabled}>{label}</Text> : null}
    </Clickable>
  );
}

function radioGroup(props: Props): VNode {
  const { value, options, onChange, direction, gap, focusedKey, id, ...rest } =
    props as RadioGroupProps;
  return (
    <Box id={id} direction={direction ?? 'column'} gap={gap ?? 0} {...rest}>
      {options.map((option) => (
        <Radio
          key={option.key}
          id={id !== undefined ? `${id}:${option.key}` : undefined}
          selected={option.key === value}
          label={option.label}
          disabled={option.disabled}
          focused={option.key === focusedKey}
          onSelect={onChange ? () => onChange(option.key) : undefined}
        />
      ))}
    </Box>
  );
}

function switchNode(props: Props): VNode {
  const { on, label, onChange, focused, disabled, id, ...rest } = props as SwitchProps;
  return (
    <Clickable
      id={id}
      direction="row"
      gap={1}
      disabled={disabled}
      onClick={onChange ? () => onChange(!on) : undefined}
      {...rest}
    >
      <Text
        style={
          disabled
            ? [styles.dim]
            : on
              ? [styles.success, ...(focused ? [styles.bold] : [])]
              : [styles.muted, ...(focused ? [styles.bold] : [])]
        }
      >
        {on ? '──●' : '●──'}
      </Text>
      {label !== undefined ? <Text dim={disabled}>{label}</Text> : null}
    </Clickable>
  );
}

function textInput(props: Props): VNode {
  const {
    value,
    placeholder,
    caret,
    selection,
    focused,
    onKey,
    onChange,
    onSubmit,
    password,
    id,
    ...rest
  } = props as TextInputProps;
  const editKey =
    onChange !== undefined || onSubmit !== undefined
      ? (event: Parameters<NonNullable<TextInputProps['onKey']>>[0]): boolean | void => {
          if (onKey?.(event) === true) return true;
          if (event.key === 'enter' && !event.ctrl && !event.alt) {
            if (onSubmit === undefined) return false;
            onSubmit(value);
            return true;
          }
          if (onChange === undefined) return false;
          const next = applyTextEdit({ value, caret: caret ?? value.length, selection }, event);
          if (next === null) return false;
          onChange(next.value, next.caret, next.selection);
          return true;
        }
      : onKey;
  // Masking happens only at paint: the caret and selection indices are
  // computed against the real `value`, so a same-length run of `•` keeps
  // that math correct without the reducer ever seeing the masked form.
  const shown = password === true ? '•'.repeat(value.length) : value;
  return (
    <Clickable id={id} onKey={editKey} {...rest}>
      <Input
        value={shown}
        placeholder={placeholder}
        caret={caret}
        selection={selection}
        focused={focused}
      />
    </Clickable>
  );
}

function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let out = value;
  if (max !== undefined) out = Math.min(out, max);
  if (min !== undefined) out = Math.max(out, min);
  return out;
}

function numberInput(props: Props): VNode {
  const { value, min, max, step, onChange, focused, disabled, id, ...rest } =
    props as NumberInputProps;
  const s = step ?? 1;
  const canDec = onChange !== undefined && disabled !== true && (min === undefined || value > min);
  const canInc = onChange !== undefined && disabled !== true && (max === undefined || value < max);
  const stepBy = (delta: number): void => onChange!(clampNumber(value + delta, min, max));
  return (
    <Clickable
      id={id}
      direction="row"
      gap={1}
      disabled={disabled}
      onKey={
        onChange !== undefined && disabled !== true
          ? (event) => {
              if (event.ctrl || event.alt) return false;
              if (event.key === 'left' || event.key === 'down') {
                stepBy(-s);
                return true;
              }
              if (event.key === 'right' || event.key === 'up') {
                stepBy(s);
                return true;
              }
              return false;
            }
          : undefined
      }
      {...rest}
    >
      <Clickable
        id={id !== undefined ? `${id}:dec` : undefined}
        focusable={false}
        disabled={!canDec}
        onClick={canDec ? () => stepBy(-s) : undefined}
      >
        <Text style={canDec ? [styles.accent] : [styles.dim]}>‹</Text>
      </Clickable>
      <Text style={disabled === true ? [styles.dim] : focused === true ? [styles.bold] : []}>
        {String(value)}
      </Text>
      <Clickable
        id={id !== undefined ? `${id}:inc` : undefined}
        focusable={false}
        disabled={!canInc}
        onClick={canInc ? () => stepBy(s) : undefined}
      >
        <Text style={canInc ? [styles.accent] : [styles.dim]}>›</Text>
      </Clickable>
    </Clickable>
  );
}

function textArea(props: Props): VNode {
  const { value, caret, selection, rows, focused, onChange, onSubmit, onKey, id, ...rest } =
    props as TextAreaProps;
  const editKey =
    onChange !== undefined || onSubmit !== undefined
      ? (event: Parameters<NonNullable<TextAreaProps['onKey']>>[0]): boolean | void => {
          if (onKey?.(event) === true) return true;
          if (event.key === 'enter' && event.ctrl === true && !event.alt) {
            if (onSubmit === undefined) return false;
            onSubmit(value);
            return true;
          }
          if (onChange === undefined) return false;
          const next = applyTextAreaEdit({ value, caret: caret ?? value.length, selection }, event);
          if (next === null) return false;
          onChange(next.value, next.caret, next.selection);
          return true;
        }
      : onKey;
  return (
    <Clickable id={id} onKey={editKey} {...rest}>
      <Box border paddingX={1} height={(rows ?? 4) + 2}>
        <Text wrap={false} caret={focused === true ? (caret ?? value.length) : undefined}>
          {value}
        </Text>
      </Box>
    </Clickable>
  );
}

function slider(props: Props): VNode {
  const { value, min, max, step, onChange, orientation, width, focused, disabled, id, ...rest } =
    props as SliderProps;
  const lo = min ?? 0;
  const hi = max ?? 100;
  const s = step ?? 1;
  const span = Math.max(1e-9, hi - lo);
  const vertical = orientation === 'vertical';
  const cells = Math.max(3, width ?? (vertical ? 8 : 20));
  const fraction = Math.max(0, Math.min(1, (clampNumber(value, lo, hi) - lo) / span));
  const handleAt = Math.round(fraction * (cells - 1));
  const enabled = onChange !== undefined && disabled !== true;
  const commit = (frac: number): void => {
    const raw = lo + Math.max(0, Math.min(1, frac)) * span;
    onChange!(clampNumber(Math.round(raw / s) * s, lo, hi));
  };
  const onMouse = enabled
    ? (event: UiMouseEvent): boolean => {
        if (event.action !== 'press' && event.action !== 'drag') return false;
        const local = vertical ? event.localY : event.localX;
        if (local === undefined) return false;
        commit(vertical ? 1 - local / (cells - 1) : local / (cells - 1));
        return true;
      }
    : undefined;
  const onKey = enabled
    ? (event: UiKeyEvent): boolean => {
        if (event.ctrl || event.alt) return false;
        if (event.key === 'left' || event.key === 'down') {
          onChange!(clampNumber(value - s, lo, hi));
          return true;
        }
        if (event.key === 'right' || event.key === 'up') {
          onChange!(clampNumber(value + s, lo, hi));
          return true;
        }
        return false;
      }
    : undefined;
  const trackStyle = disabled === true ? [styles.dim] : focused === true ? [styles.accent] : [];
  if (vertical) {
    const rows = Array.from({ length: cells }, (_, row) => cells - 1 - row === handleAt);
    return (
      <Clickable
        id={id}
        direction="column"
        disabled={disabled}
        onMouse={onMouse}
        onKey={onKey}
        {...rest}
      >
        {rows.map((isHandle, index) => (
          <Text key={String(index)} style={trackStyle}>
            {isHandle ? '●' : '│'}
          </Text>
        ))}
      </Clickable>
    );
  }
  const track = Array.from({ length: cells }, (_, i) => (i === handleAt ? '●' : '─')).join('');
  return (
    <Clickable id={id} disabled={disabled} onMouse={onMouse} onKey={onKey} {...rest}>
      <Text style={trackStyle}>{track}</Text>
    </Clickable>
  );
}

function iconNode(props: Props): VNode {
  const { name, label: _label, icons, id, ...rest } = props as IconProps;
  return (
    <Text id={id} {...rest}>
      {iconForm(name, 'tui', icons)}
    </Text>
  );
}

function expanderNode(props: Props): VNode {
  const { open, onToggle, disabled, id, style, ...rest } = props as ExpanderProps;
  const glyph = iconForm(open ? 'chevron-down' : 'chevron-right', 'tui');
  if (onToggle === undefined) {
    return (
      <Text id={id} style={style} {...rest}>
        {glyph}
      </Text>
    );
  }
  return (
    <Clickable
      id={id}
      focusable={false}
      disabled={disabled}
      onClick={() => onToggle(!open)}
      {...rest}
    >
      <Text style={style}>{glyph}</Text>
    </Clickable>
  );
}

function details(props: Props, children: NormalizedChild[]): VNode {
  const { title, open, onToggle, expander, focused, id, ...rest } = props as DetailsProps;
  const where = expander ?? 'start';
  const summaryStyle = focused ? [styles.bold, styles.accent] : [styles.bold];
  const marker = <Expander open={open} style={summaryStyle} />;
  return (
    <Box direction="column" {...rest}>
      <Clickable
        id={id}
        direction="row"
        gap={1}
        onClick={onToggle ? () => onToggle(!open) : undefined}
      >
        {where === 'start' ? marker : null}
        <Text style={summaryStyle}>{title}</Text>
        {where === 'end' ? marker : null}
      </Clickable>
      {open ? (
        <Box direction="column" paddingX={2}>
          {children}
        </Box>
      ) : null}
    </Box>
  );
}

function tabList(props: Props): VNode {
  const { items, value, onChange, id, ...rest } = props as TabListProps;
  return (
    <Box direction="row" gap={2} {...rest}>
      {items.map((item) => (
        <Clickable
          key={item.key}
          id={id !== undefined ? `${id}:${item.key}` : undefined}
          disabled={item.disabled}
          onClick={onChange && item.key !== value ? () => onChange(item.key) : undefined}
        >
          <Text
            style={
              item.disabled
                ? [styles.dim]
                : item.key === value
                  ? [styles.bold, styles.underline]
                  : [styles.dim]
            }
          >
            {item.label}
          </Text>
        </Clickable>
      ))}
    </Box>
  );
}

function tabs(props: Props, children: NormalizedChild[]): VNode {
  const rest = props as TabsProps;
  return (
    <Box direction="column" gap={1}>
      <TabList {...rest} />
      <Box direction="column">{children}</Box>
    </Box>
  );
}

function menuRow(props: Props): VNode {
  const { label, detail, glyph, marker, selected, disabled, onClick, id } = props as MenuRowProps;
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
}

function menuHeader(props: Props): VNode {
  return <Text style={[styles.dim, styles.bold]}>{(props as { label: string }).label}</Text>;
}

function menuSeparator(): VNode {
  return <Rule style={[styles.dim]} />;
}

function menuList(props: Props): VNode {
  const { items, selectedKey, top, maxRows, marker, onSelect, id } = props as MenuListProps;
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
}

function modal(props: Props, children: NormalizedChild[]): VNode {
  const { title, onDismiss, width, height } = props as ModalProps;
  return (
    <Layer backdrop width={width} height={height}>
      <Clickable
        direction="column"
        focusable={false}
        captureKeys
        onKey={
          onDismiss
            ? (event) => {
                if (event.key === 'escape') {
                  onDismiss();
                  return true;
                }
                return false;
              }
            : undefined
        }
      >
        <Panel title={title}>{children}</Panel>
      </Clickable>
    </Layer>
  );
}

function contextMenu(props: Props): VNode {
  const { at, items, selectedKey, onSelect, onDismiss, id } = props as ContextMenuProps;
  return (
    <Box>
      <Layer anchor={{ x: 0, y: -1 }} width={9999} height={9999} transparent>
        <Clickable
          focusable={false}
          width={9999}
          height={9999}
          onMouse={(event) => {
            if (event.action === 'press') {
              onDismiss();
              return true;
            }
            return false;
          }}
        />
      </Layer>
      <Layer anchor={at}>
        <Clickable
          focusable={false}
          captureKeys
          onKey={(event) => {
            if (event.key === 'escape') {
              onDismiss();
              return true;
            }
            return false;
          }}
        >
          <Box border paddingX={1}>
            <MenuList items={items} selectedKey={selectedKey} onSelect={onSelect} id={id} />
          </Box>
        </Clickable>
      </Layer>
    </Box>
  );
}

function select(props: Props): VNode {
  const { value, options, open, onOpenChange, onChange, placeholder, focused, id } =
    props as SelectProps;
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
}

function comboBox(props: Props): VNode {
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
  } = props as ComboBoxProps;
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
}

function iconButton(props: Props): VNode {
  const {
    icon,
    label: _label,
    onClick,
    focused,
    disabled,
    icons,
    id,
    ...rest
  } = props as IconButtonProps;
  return (
    <Clickable id={id} onClick={onClick} disabled={disabled} {...rest}>
      <Text
        style={
          disabled === true ? [styles.dim] : focused === true ? [styles.bold, styles.accent] : []
        }
      >
        {iconForm(icon, 'tui', icons)}
      </Text>
    </Clickable>
  );
}

function badge(props: Props): VNode {
  const { label, variant, ...rest } = props as BadgeProps;
  return (
    <Text style={[styles[variant ?? 'accent'], styles.inverse]} {...rest}>{` ${label} `}</Text>
  );
}

function spinner(props: Props): VNode {
  const { tick, frames, ...rest } = props as SpinnerProps;
  const set = frames !== undefined && frames.length > 0 ? frames : SPINNER_FRAMES;
  const frame = set[((tick % set.length) + set.length) % set.length]!;
  return (
    <Text style={[styles.accent]} {...rest}>
      {frame}
    </Text>
  );
}

function progressBar(props: Props): VNode {
  const { value, width, showPercent, id, ...rest } = props as ProgressBarProps;
  const cells = Math.max(1, width ?? 20);
  const fraction = Math.max(0, Math.min(1, value));
  const filled = Math.round(fraction * cells);
  return (
    <Box direction="row" id={id} {...rest}>
      <Text style={[styles.accent]}>{'█'.repeat(filled)}</Text>
      <Text style={[styles.muted]}>{'░'.repeat(cells - filled)}</Text>
      {showPercent ? <Text style={[styles.dim]}>{` ${Math.round(fraction * 100)}%`}</Text> : null}
    </Box>
  );
}

function keyHint(props: Props): VNode {
  const { keys, separator, id, ...rest } = props as KeyHintProps;
  const sep = separator ?? ' · ';
  const parts: VNode[] = [];
  keys.forEach((hint, index) => {
    if (index > 0) {
      parts.push(
        <Text key={`s${index}`} style={[styles.dim]}>
          {sep}
        </Text>,
      );
    }
    parts.push(
      <Text key={`k${index}`} style={[styles.bold]}>
        {hint.key}
      </Text>,
    );
    parts.push(<Text key={`l${index}`} style={[styles.dim]}>{` ${hint.label}`}</Text>);
  });
  return (
    <Box direction="row" id={id} {...rest}>
      {parts}
    </Box>
  );
}

function tag(props: Props): VNode {
  const { label, onRemove, color, id, ...rest } = props as TagProps;
  const tone = styles[color ?? 'accent'];
  return (
    <Box direction="row" id={id} {...rest}>
      <Text style={[tone, styles.inverse]}>{` ${label} `}</Text>
      {onRemove ? (
        <Clickable
          id={id !== undefined ? `${id}:remove` : undefined}
          focusable={false}
          onClick={onRemove}
        >
          <Text style={[tone, styles.inverse]}>{'× '}</Text>
        </Clickable>
      ) : null}
    </Box>
  );
}

function breadcrumbs(props: Props): VNode {
  const { items, onNavigate, id, ...rest } = props as BreadcrumbsProps;
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      {items.flatMap((item, index) => {
        const node =
          index === items.length - 1 ? (
            <Text key={item.key} style={[styles.bold]}>
              {item.label}
            </Text>
          ) : (
            <Clickable
              key={item.key}
              id={id !== undefined ? `${id}:${item.key}` : undefined}
              focusable={false}
              onClick={onNavigate ? () => onNavigate(item.key) : undefined}
            >
              <Text style={[styles.dim]}>{item.label}</Text>
            </Clickable>
          );
        const separator = (
          <Text key={`sep:${item.key}`} style={[styles.dim]}>
            /
          </Text>
        );
        return index > 0 ? [separator, node] : [node];
      })}
    </Box>
  );
}

function pagination(props: Props): VNode {
  const { page, pages, onChange, siblings, id, ...rest } = props as PaginationProps;
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  const atStart = current <= 1;
  const atEnd = current >= total;
  const range = paginationRange(current, total, siblings);
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      <Clickable
        id={id !== undefined ? `${id}:prev` : undefined}
        focusable={false}
        disabled={atStart}
        onClick={atStart ? undefined : () => onChange(current - 1)}
      >
        <Text style={atStart ? [styles.dim] : [styles.accent]}>‹</Text>
      </Clickable>
      {range.map((entry, index) =>
        entry === 'ellipsis' ? (
          <Text key={`ellipsis:${index}`} style={[styles.dim]}>
            …
          </Text>
        ) : (
          <Clickable
            key={String(entry)}
            id={id !== undefined ? `${id}:${entry}` : undefined}
            focusable={false}
            disabled={entry === current}
            onClick={entry === current ? undefined : () => onChange(entry)}
          >
            <Text style={entry === current ? [styles.bold, styles.accent] : [styles.dim]}>
              {String(entry)}
            </Text>
          </Clickable>
        ),
      )}
      <Clickable
        id={id !== undefined ? `${id}:next` : undefined}
        focusable={false}
        disabled={atEnd}
        onClick={atEnd ? undefined : () => onChange(current + 1)}
      >
        <Text style={atEnd ? [styles.dim] : [styles.accent]}>›</Text>
      </Clickable>
    </Box>
  );
}

function virtualList(props: Props, children: NormalizedChild[]): VNode {
  const {
    height,
    window: slice,
    offset,
    onMouse,
    onScroll: _onScroll,
    ...rest
  } = props as VirtualListProps;
  return h(
    'clickable',
    { direction: 'column', height, onMouse, focusable: false, ...rest },
    h(
      'scrollview',
      { height, offset },
      slice.topPad > 0 ? h('spacer', { height: slice.topPad }) : null,
      children,
      slice.bottomPad > 0 ? h('spacer', { height: slice.bottomPad }) : null,
    ),
  );
}

function steps(props: Props): VNode {
  const { steps: entries, current, id, ...rest } = props as StepsProps;
  const at = entries.findIndex((step) => step.key === current);
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      {entries.flatMap((step, index) => {
        const state = at !== -1 && index < at ? 'done' : index === at ? 'current' : 'upcoming';
        const dot = (
          <Text
            key={`d:${step.key}`}
            style={
              state === 'done'
                ? [styles.success]
                : state === 'current'
                  ? [styles.bold, styles.accent]
                  : [styles.dim]
            }
          >
            {state === 'upcoming' ? '○' : '●'}
          </Text>
        );
        const label = (
          <Text
            key={`l:${step.key}`}
            style={state === 'current' ? [styles.bold] : state === 'upcoming' ? [styles.dim] : []}
          >
            {step.label}
          </Text>
        );
        const joint = (
          <Text key={`j:${step.key}`} style={[styles.dim]}>
            ──
          </Text>
        );
        return index > 0 ? [joint, dot, label] : [dot, label];
      })}
    </Box>
  );
}

function popover(props: Props, children: NormalizedChild[]): VNode {
  const { open, anchorId, onDismiss } = props as PopoverProps;
  return (
    <Box>
      {open ? (
        <Layer anchorId={anchorId}>
          <Clickable
            direction="column"
            focusable={false}
            captureKeys
            onKey={
              onDismiss
                ? (event) => {
                    if (event.key === 'escape') {
                      onDismiss();
                      return true;
                    }
                    return false;
                  }
                : undefined
            }
          >
            <Box border paddingX={1} direction="column">
              {children}
            </Box>
          </Clickable>
        </Layer>
      ) : null}
    </Box>
  );
}

function tooltip(props: Props): VNode {
  const { text, open, anchorId } = props as TooltipProps;
  return (
    <Box>
      {open ? (
        <Layer anchorId={anchorId}>
          <Box border paddingX={1} style={[styles.dim]}>
            <Text>{text}</Text>
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
}

function toast(props: Props): VNode {
  const { message, variant } = props as ToastProps;
  return (
    <Box border borderColor={styles[variant ?? 'info'].fg}>
      <Text>{` ${message} `}</Text>
    </Box>
  );
}

function toastStack(props: Props): VNode {
  const { toasts } = props as ToastStackProps;
  return (
    <Box>
      {toasts.length > 0 ? (
        <Layer anchor={{ x: 9999, y: -1 }} placement="bottom-end" transparent>
          <Box direction="column" align="end">
            {toasts.map((entry) => (
              <Toast key={entry.id} message={entry.message} variant={entry.variant} />
            ))}
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
}

function table(props: Props): VNode {
  const { columns, rows, selectedIndex, onSelectRow, id, ...rest } = props as TableProps;
  const widths = columns.map((column) => {
    if (column.width !== undefined) return column.width;
    let widest = stringWidth(column.header);
    for (const row of rows) widest = Math.max(widest, stringWidth(row[column.key] ?? ''));
    return widest;
  });
  const cells = (row: Record<string, string>): VNode[] =>
    columns.map((column, index) => (
      <Text
        key={column.key}
        width={widths[index]}
        align={column.align}
        truncate={column.width !== undefined}
      >
        {row[column.key] ?? ''}
      </Text>
    ));
  return (
    <Box direction="column" id={id} {...rest}>
      <Box direction="row" gap={1}>
        {columns.map((column, index) => (
          <Text
            key={column.key}
            width={widths[index]}
            align={column.align}
            truncate={column.width !== undefined}
            style={[styles.bold]}
          >
            {column.header}
          </Text>
        ))}
      </Box>
      <Rule style={[styles.dim]} />
      {rows.map((row, index) =>
        onSelectRow ? (
          <Clickable
            key={`${index}`}
            id={id !== undefined ? `${id}:${index}` : undefined}
            direction="row"
            gap={1}
            focusable={false}
            style={index === selectedIndex ? [styles.inverse] : []}
            onClick={() => onSelectRow(index)}
          >
            {cells(row)}
          </Clickable>
        ) : (
          <Box
            key={`${index}`}
            direction="row"
            gap={1}
            style={index === selectedIndex ? [styles.inverse] : []}
          >
            {cells(row)}
          </Box>
        ),
      )}
    </Box>
  );
}

function fileTree(props: Props): VNode {
  const { nodes, expanded, selectedKey, icons, folderIcons, onToggle, onSelect, id, ...rest } =
    props as FileTreeProps;
  const rows: VNode[] = [];
  const visit = (node: FileTreeNode, depth: number): void => {
    const dir = node.children !== undefined;
    const open = dir && expanded.includes(node.key);
    const selected = node.key === selectedKey;
    const glyph = iconForm(fileIcon(node, icons, open, folderIcons), 'tui');
    // The icon IS the expander: a directory's icon toggles it, the rest of
    // the row selects. With no select handler the whole row toggles.
    const rowClick =
      onSelect !== undefined
        ? () => onSelect(node.key)
        : dir && onToggle !== undefined
          ? () => onToggle(node.key)
          : undefined;
    rows.push(
      <Clickable
        key={node.key}
        id={id !== undefined ? `${id}:${node.key}` : undefined}
        direction="row"
        focusable={false}
        style={selected ? [styles.bold, styles.inverse] : []}
        onClick={rowClick}
      >
        {depth > 0 ? <Text>{' '.repeat(depth * 2)}</Text> : null}
        {dir ? (
          <Clickable
            id={id !== undefined ? `${id}:${node.key}:toggle` : undefined}
            focusable={false}
            onClick={onToggle ? () => onToggle(node.key) : undefined}
          >
            <Text>{glyph}</Text>
          </Clickable>
        ) : (
          <Text>{glyph}</Text>
        )}
        <Text>{` ${node.label}`}</Text>
      </Clickable>,
    );
    if (open) for (const child of node.children!) visit(child, depth + 1);
  };
  for (const node of nodes) visit(node, 0);
  return (
    <Box direction="column" id={id} {...rest}>
      {rows}
    </Box>
  );
}

function timeline(props: Props): VNode {
  const { entries, id, ...rest } = props as TimelineProps;
  return (
    <Box direction="column" id={id} {...rest}>
      {entries.flatMap((entry, index) => {
        const last = index === entries.length - 1;
        const rows = [
          <Box key={entry.key} direction="row" gap={1}>
            <Text style={[styles[entry.variant ?? 'info']]}>●</Text>
            <Text>{entry.title}</Text>
          </Box>,
        ];
        if (entry.detail !== undefined) {
          rows.push(
            <Text key={`${entry.key}:detail`} style={[styles.dim]}>
              {`${last ? ' ' : '│'}  ${entry.detail}`}
            </Text>,
          );
        }
        // A connector row between segments, so entries breathe instead of
        // stacking flush against each other.
        if (!last) {
          rows.push(
            <Text key={`${entry.key}:gap`} style={[styles.dim]}>
              {'│'}
            </Text>,
          );
        }
        return rows;
      })}
    </Box>
  );
}

function heading(props: Props, children: NormalizedChild[]): VNode {
  const { level, id, ...rest } = props as HeadingProps;
  const lvl = Math.min(6, Math.max(1, Math.floor(level ?? 1)));
  const style = [styles.bold, ...(lvl <= 2 ? [styles.accent] : [])];
  const text = (
    <Text id={id} style={style} {...rest}>
      {children}
    </Text>
  );
  if (lvl !== 1) return text;
  return (
    <Box direction="column">
      {text}
      <Rule style={[styles.dim]} />
    </Box>
  );
}

function bold(props: Props, children: NormalizedChild[]): VNode {
  const { id, ...rest } = props as BoldProps;
  return (
    <Text id={id} {...rest} bold>
      {children}
    </Text>
  );
}

function italic(props: Props, children: NormalizedChild[]): VNode {
  const { id, ...rest } = props as ItalicProps;
  return (
    <Text id={id} {...rest} italic>
      {children}
    </Text>
  );
}

// `Link` is the one catalog component allowed to navigate. With `onActivate`
// it becomes a focusable Clickable, same as any other click-like control.
// An `href`-only link would ideally emit an OSC 8 terminal hyperlink
// (`\x1b]8;;URL\x1b\\text\x1b]8;;\x1b\\`), but that can't survive this
// pipeline: `Text` content routes through fino:tty/frame's `parseAnsi`
// whenever it contains an escape byte, and `parseAnsi` intentionally
// discards non-SGR sequences — OSC included — to keep `Segment` text free of
// embedded control codes (see frame.ts). So an `href`-only `Link` renders as
// styled, underlined, non-interactive text instead.
function link(props: Props, children: NormalizedChild[]): VNode {
  const { href: _href, onActivate, id, ...rest } = props as LinkProps;
  const style = [styles.accent, styles.underline];
  if (onActivate !== undefined) {
    return (
      <Clickable id={id} onClick={onActivate} {...rest}>
        <Text style={style}>{children}</Text>
      </Clickable>
    );
  }
  return (
    <Text id={id} style={style} {...rest}>
      {children}
    </Text>
  );
}

// Each child gets its own gutter row, so a quote built from several `Text`
// lines carries `│` beside every one of them — matching Markdown's `>` on
// every quoted line. A single child that word-wraps internally still only
// carries one gutter for that block: how many rows it wraps to is a
// layout-time decision made after this composer runs, and repeating the
// gutter per wrapped row would mean teaching the frame/cell layer about a
// tiling left border, which is out of scope for a component lowering.
function blockquote(props: Props, children: NormalizedChild[]): VNode {
  const { id, ...rest } = props as BlockquoteProps;
  return (
    <Box direction="column" id={id} {...rest}>
      {children.map((child, index) => (
        <Box key={String(index)} direction="row" gap={1}>
          <Text style={[styles.dim]}>│</Text>
          <Box direction="column" grow={1} style={[styles.dim]}>
            {child}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function list(props: Props): VNode {
  const { ordered, items, id, ...rest } = props as ListProps;
  const width = (ordered ? `${items.length}.` : '•').length;
  return (
    <Box direction="column" id={id} {...rest}>
      {items.map((item, index) => (
        <Box key={String(index)} direction="row" gap={1}>
          <Text width={width} align="end" style={[styles.dim]}>
            {ordered ? `${index + 1}.` : '•'}
          </Text>
          <Box direction="column" grow={1}>
            {typeof item === 'string' || typeof item === 'number' ? <Text wrap>{item}</Text> : item}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

const CODE_TONE = {
  keyword: styles.accent,
  string: styles.success,
  number: styles.info,
  comment: styles.muted,
  regexp: styles.warning,
} as const;

function code(props: Props): VNode {
  const {
    code: source,
    language,
    showLineNumbers,
    filename,
    copyable,
    onCopy,
    id,
    ...rest
  } = props as CodeProps;
  const rows = highlightLines(source, language);
  const gutterWidth = String(rows.length).length;
  const bar =
    filename !== undefined || copyable === true ? (
      <Box direction="column">
        <Box direction="row" justify="between">
          <Text style={[styles.dim]}>{filename ?? ''}</Text>
          {copyable === true ? (
            <Clickable
              id={id !== undefined ? `${id}:copy` : undefined}
              focusable={false}
              onClick={onCopy ? () => onCopy(source) : undefined}
            >
              <Text style={[styles.dim]}>⧉ copy</Text>
            </Clickable>
          ) : null}
        </Box>
        <Rule style={[styles.dim]} />
      </Box>
    ) : null;
  return (
    <Box direction="column" border paddingX={1} id={id} {...rest}>
      {bar}
      {rows.map((runs, index) => (
        <Box key={String(index)} direction="row" gap={showLineNumbers ? 1 : 0} minHeight={1}>
          {showLineNumbers ? (
            <Text width={gutterWidth} align="end" style={[styles.dim]}>
              {String(index + 1)}
            </Text>
          ) : null}
          <Box direction="row">
            {runs.map((run, runIndex) => (
              <Text key={String(runIndex)} style={run.cls ? [CODE_TONE[run.cls]] : []}>
                {run.text}
              </Text>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function inlineCode(props: Props, children: NormalizedChild[]): VNode {
  const { id, ...rest } = props as InlineCodeProps;
  return (
    <Text id={id} {...rest} style={[styles.dim, styles.inverse]}>
      {children}
    </Text>
  );
}

function card(props: Props, children: NormalizedChild[]): VNode {
  const { title, subtitle, image, actions, id, ...rest } = props as CardProps;
  return (
    <Box border direction="column" paddingX={1} id={id} {...rest}>
      {image !== undefined ? <Text style={[styles.dim]}>{`[ ${image.alt} ]`}</Text> : null}
      {title !== undefined ? <Text bold>{title}</Text> : null}
      {subtitle !== undefined ? <Text style={[styles.dim]}>{subtitle}</Text> : null}
      {children}
      {actions !== undefined ? (
        <Box direction="row" gap={1} justify="end">
          {actions}
        </Box>
      ) : null}
    </Box>
  );
}

const TREND_GLYPH: Record<Trend, string> = { up: '▲', down: '▼', flat: '–' };
const TREND_TONE: Record<Trend, Style> = {
  up: styles.success,
  down: styles.danger,
  flat: styles.muted,
};

function stat(props: Props): VNode {
  const { label, value, hint, trend, id, ...rest } = props as StatProps;
  return (
    <Box direction="column" id={id} {...rest}>
      <Text style={[styles.dim]}>{label}</Text>
      <Box direction="row" gap={1}>
        <Text bold>{value}</Text>
        {trend !== undefined ? <Text style={[TREND_TONE[trend]]}>{TREND_GLYPH[trend]}</Text> : null}
      </Box>
      {hint !== undefined ? <Text style={[styles.dim]}>{hint}</Text> : null}
    </Box>
  );
}

const STATUS_TONE: Record<StatusDotStatus, Style> = {
  ok: styles.success,
  busy: styles.info,
  error: styles.danger,
  idle: styles.muted,
  warning: styles.warning,
};

function statusDot(props: Props): VNode {
  const { status, label, id, ...rest } = props as StatusDotProps;
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      <Text style={[STATUS_TONE[status]]}>●</Text>
      {label !== undefined ? <Text>{label}</Text> : null}
    </Box>
  );
}

function emptyState(props: Props): VNode {
  const { icon, title, description, action, icons, id, ...rest } = props as EmptyStateProps;
  return (
    <Box direction="column" align="center" justify="center" gap={1} id={id} {...rest}>
      {icon !== undefined ? <Text style={[styles.dim]}>{iconForm(icon, 'tui', icons)}</Text> : null}
      <Text bold align="center">
        {title}
      </Text>
      {description !== undefined ? (
        <Text style={[styles.dim]} align="center">
          {description}
        </Text>
      ) : null}
      {action !== undefined ? (
        <Box direction="row" justify="center">
          {action}
        </Box>
      ) : null}
    </Box>
  );
}

function hoverCard(props: Props, children: NormalizedChild[]): VNode {
  const { open, anchorId, title } = props as HoverCardProps;
  return (
    <Box>
      {open ? (
        <Layer anchorId={anchorId}>
          <Box border paddingX={1} direction="column" gap={1}>
            {title !== undefined ? <Text bold>{title}</Text> : null}
            {children}
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
}

// `Layer` has no notion of "this node's own enclosing container" — anchoring
// always means anchoring to a known hit id (the container must expose one
// via `anchorId`), and its placement model offers only start/end alignment
// relative to that anchor point, never centering. `top-start`/`top-end`
// (rather than `bottom-start`/`bottom-end`) land the bar just inside the
// anchor's bottom edge instead of pushed below it entirely — the closest
// approximation of "floating over the container's bottom" the engine
// currently supports. `'bottom-center'` has no anchored-center counterpart
// to fall back on, so it renders with the same left alignment as
// `'top-start'` here; the web target centers it for real with flexbox.
function floatingActionBar(props: Props, children: NormalizedChild[]): VNode {
  const { placement, anchorId } = props as FloatingActionBarProps;
  return (
    <Layer anchorId={anchorId} placement={placement === 'bottom-end' ? 'top-end' : 'top-start'}>
      <Box border paddingX={1} direction="row" gap={1}>
        {children}
      </Box>
    </Layer>
  );
}

const COMPOSERS: Record<string, Composer> = {
  'ui:panel': panel,
  'ui:field': field,
  'ui:fieldset': fieldset,
  'ui:button': button,
  'ui:icon-button': iconButton,
  'ui:checkbox': checkbox,
  'ui:radio': radio,
  'ui:radio-group': radioGroup,
  'ui:switch': switchNode,
  'ui:text-input': textInput,
  'ui:text-area': textArea,
  'ui:number-input': numberInput,
  'ui:slider': slider,
  'ui:combobox': comboBox,
  'ui:details': details,
  'ui:expander': expanderNode,
  'ui:icon': iconNode,
  'ui:tab-list': tabList,
  'ui:tabs': tabs,
  'ui:menu-row': menuRow,
  'ui:menu-header': menuHeader,
  'ui:menu-separator': menuSeparator,
  'ui:menu-list': menuList,
  'ui:modal': modal,
  'ui:context-menu': contextMenu,
  'ui:select': select,
  'ui:badge': badge,
  'ui:spinner': spinner,
  'ui:progress': progressBar,
  'ui:key-hint': keyHint,
  'ui:tag': tag,
  'ui:breadcrumbs': breadcrumbs,
  'ui:pagination': pagination,
  'ui:steps': steps,
  'ui:popover': popover,
  'ui:tooltip': tooltip,
  'ui:toast': toast,
  'ui:toast-stack': toastStack,
  'ui:table': table,
  'ui:file-tree': fileTree,
  'ui:timeline': timeline,
  'ui:virtual-list': virtualList,
  'ui:heading': heading,
  'ui:bold': bold,
  'ui:italic': italic,
  'ui:link': link,
  'ui:blockquote': blockquote,
  'ui:list': list,
  'ui:code': code,
  'ui:inline-code': inlineCode,
  'ui:card': card,
  'ui:stat': stat,
  'ui:status-dot': statusDot,
  'ui:empty-state': emptyState,
  'ui:hover-card': hoverCard,
  'ui:floating-action-bar': floatingActionBar,
};

/**
 * Lower a semantic tree to terminal primitives.
 *
 * Semantic `ui:*` nodes are replaced by their terminal compositions —
 * recursively, since compositions may nest further semantic nodes — and
 * primitive nodes pass through with their children lowered. Keys survive
 * onto the lowered roots, so reconciliation sees the same identity the
 * semantic tree declared.
 */
export function lowerTui(node: VNode): VNode {
  const compose = COMPOSERS[node.type];
  if (compose) {
    const composed = compose(node.props, node.children);
    return lowerTui(node.key === null ? composed : { ...composed, key: node.key });
  }
  let changed = false;
  const children = node.children.map((child) => {
    if (typeof child === 'string') return child;
    const lowered = lowerTui(child);
    if (lowered !== child) changed = true;
    return lowered;
  });
  return changed ? { ...node, children } : node;
}
