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
import {
  applyTextEdit,
  Box,
  Clickable,
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
  styles,
} from 'fino:ui/components';
import type {
  BadgeProps,
  BreadcrumbsProps,
  ButtonProps,
  CheckboxProps,
  ContextMenuProps,
  DetailsProps,
  ExpanderProps,
  FileTreeNode,
  FileTreeProps,
  IconProps,
  KeyHintProps,
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
  SpinnerProps,
  StepsProps,
  SwitchProps,
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
  const { value, placeholder, caret, selection, focused, onKey, onChange, onSubmit, id, ...rest } =
    props as TextInputProps;
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
  return (
    <Clickable id={id} onKey={editKey} {...rest}>
      <Input
        value={value}
        placeholder={placeholder}
        caret={caret}
        selection={selection}
        focused={focused}
      />
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
  const { page, pages, onChange, id, ...rest } = props as PaginationProps;
  const atStart = page <= 1;
  const atEnd = page >= pages;
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      <Clickable
        id={id !== undefined ? `${id}:prev` : undefined}
        focusable={false}
        disabled={atStart}
        onClick={atStart ? undefined : () => onChange(page - 1)}
      >
        <Text style={atStart ? [styles.dim] : [styles.accent]}>‹</Text>
      </Clickable>
      <Text>{`${page} / ${pages}`}</Text>
      <Clickable
        id={id !== undefined ? `${id}:next` : undefined}
        focusable={false}
        disabled={atEnd}
        onClick={atEnd ? undefined : () => onChange(page + 1)}
      >
        <Text style={atEnd ? [styles.dim] : [styles.accent]}>›</Text>
      </Clickable>
    </Box>
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
        return rows;
      })}
    </Box>
  );
}

const COMPOSERS: Record<string, Composer> = {
  'ui:panel': panel,
  'ui:button': button,
  'ui:checkbox': checkbox,
  'ui:radio': radio,
  'ui:radio-group': radioGroup,
  'ui:switch': switchNode,
  'ui:text-input': textInput,
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
