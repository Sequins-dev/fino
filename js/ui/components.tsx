/** @jsxImportSource fino:ui */
/**
 * fino:ui/components — host-neutral UI primitives and the component catalog.
 *
 * Everything here composes down to six primitive node types — `box`, `text`,
 * `layer`, `clickable`, `input`, `scrollview` (plus the `spacer` and `rule`
 * helpers) — and carries no host-specific behavior. A render target that
 * implements the primitives renders the whole catalog: `fino:tty/tui` paints
 * them into terminal cells, the HTML target maps them onto flexbox markup.
 *
 * State never lives inside a component: interactive components take values
 * and change callbacks, and small state helpers (`createDisclosure`,
 * `ListSelection`) hold what must survive across renders. Focus is rendered
 * from a `focused` prop, wired by the app from its render target's focus
 * signal.
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import { Panel, Button, Details } from 'fino:ui/components';
 * import { createSignal } from 'fino:ui';
 *
 * const open = createSignal(false);
 * const view = () => (
 *   <Panel title="Session">
 *     <Details title="Advanced" open={open.get()} onToggle={(next) => open.set(next)}>
 *       <Button label="Reset" onClick={() => {}} />
 *     </Details>
 *   </Panel>
 * );
 * ```
 */
import { h, createSignal, type Child, type Props, type VNode, type Signal } from 'fino:ui';
import type { Color, Style } from 'fino:tty/style';
import { stringWidth } from 'fino:tty/frame';
import { styles } from 'fino:ui/components/theme';

export type { Color, Style };
export { styles };

export type Direction = 'row' | 'column';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Justify = 'start' | 'center' | 'end' | 'between';
export type WrapMode = 'none' | 'char' | 'word';
export type BorderStyle = 'single' | 'ascii' | 'round' | 'heavy' | 'double';

/** Style props accepted by every primitive. */
export interface StyleProps {
  color?: Color;
  background?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
  /** Style token(s) merged left-to-right beneath the individual props above. */
  style?: Style | Style[];
  /** Hit-region id, reported by the render target for mouse routing. */
  id?: string;
}

/** Flex-child props accepted by every primitive. */
export interface FlexChildProps {
  grow?: number;
  shrink?: number;
  basis?: number;
  /** Shorthand for `grow`. */
  flex?: number;
  alignSelf?: Align;
  margin?: number;
  marginX?: number;
  marginY?: number;
}

/** Props accepted by `Box`. */
export interface BoxProps extends StyleProps, FlexChildProps, Props {
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  direction?: Direction;
  /** Wrap children onto new lines when the main axis overflows (row only). */
  wrap?: boolean;
  justify?: Justify;
  align?: Align;
  gap?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  border?: boolean | BorderStyle;
  borderStyle?: BorderStyle;
  borderColor?: Color;
  /** Text drawn into the top border edge. */
  borderTitle?: string;
  overflow?: 'hidden' | 'visible';
  children?: Child;
}

/** Props accepted by `Text`. */
export interface TextProps extends StyleProps, FlexChildProps, Props {
  wrap?: boolean | WrapMode;
  align?: 'start' | 'center' | 'end';
  truncate?: boolean;
  /** Character offset of the caret within this node's text. */
  caret?: number;
  width?: number;
  height?: number;
  children?: Child;
}

/** Props accepted by `Spacer`. */
export interface SpacerProps extends FlexChildProps, Props {
  width?: number;
  height?: number;
}

/** Props accepted by `Input`. */
export interface InputProps extends StyleProps, FlexChildProps, Props {
  value?: string;
  placeholder?: string;
  focused?: boolean;
  caret?: number;
}

/** Props accepted by `Layer`. */
export interface LayerProps extends StyleProps, Props {
  /** Explicit cell position the layer attaches to. */
  anchor?: { x: number; y: number };
  /** Anchor beneath the painted rect of the node with this hit id. */
  anchorId?: string;
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'center';
  /** Dim everything beneath the layer. */
  backdrop?: boolean;
  width?: number;
  height?: number;
  children?: Child;
}

/** Key event delivered to component handlers by the render target. */
export interface UiKeyEvent {
  type: 'key';
  key: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Mouse event delivered to component handlers by the render target. */
export interface UiMouseEvent {
  type: 'mouse';
  action: 'press' | 'release' | 'drag' | 'move' | 'wheel';
  button: string;
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** Props accepted by `Clickable`. */
export interface ClickableProps extends StyleProps, FlexChildProps, Props {
  onClick?: () => void;
  onKey?: (event: UiKeyEvent) => boolean | void;
  onMouse?: (event: UiMouseEvent) => boolean | void;
  onFocus?: () => void;
  onBlur?: () => void;
  focusable?: boolean;
  disabled?: boolean;
  direction?: Direction;
  align?: Align;
  justify?: Justify;
  gap?: number;
  width?: number;
  height?: number;
  children?: Child;
}

/** Props accepted by `Scroll`. */
export interface ScrollProps extends StyleProps, FlexChildProps, Props {
  width?: number;
  height?: number;
  /** First content row shown at the top of the viewport. */
  offset?: number;
  children?: Child;
}

/** Props accepted by `Rule`. */
export interface RuleProps extends StyleProps, FlexChildProps, Props {
  /** Fill character, default `─`. */
  char?: string;
  /** Cells left undrawn at the right edge. */
  inset?: number;
}

/** Layout container with the flexbox model, padding, margins, and borders. */
export function Box(props: BoxProps): VNode {
  return h('box', props);
}
/** Styled text runs with wrapping, truncation, and caret reporting. */
export function Text(props: TextProps): VNode {
  return h('text', props);
}
/** Flexible or fixed empty space. */
export function Spacer(props: SpacerProps): VNode {
  return h('spacer', props);
}
/** Single-line editable text field. */
export function Input(props: InputProps): VNode {
  return h('input', props);
}
/** Content rendered above the normal flow, anchored or centered. */
export function Layer(props: LayerProps): VNode {
  return h('layer', props);
}
/**
 * Non-visual behavior container: lays out like a plain `Box`, and a click
 * anywhere within — or Enter/Space while focused — fires `onClick`.
 */
export function Clickable(props: ClickableProps): VNode {
  return h('clickable', props);
}
/** Scrollable viewport over child content. */
export function Scroll(props: ScrollProps): VNode {
  return h('scrollview', props);
}
/** Horizontal line filling its container. */
export function Rule(props: RuleProps = {}): VNode {
  return h('rule', props);
}

/** Props accepted by `Stack`, `HStack`, and `VStack`. */
export interface StackProps extends Omit<BoxProps, 'direction'> {
  children?: Child;
}
/** Vertical box, `gap` between children. */
export function VStack(props: StackProps): VNode {
  return h('box', { ...props, direction: 'column' });
}
/** Horizontal box, `gap` between children. */
export function HStack(props: StackProps): VNode {
  return h('box', { ...props, direction: 'row' });
}
/** Alias of `VStack`, matching the common stacking default. */
export function Stack(props: StackProps): VNode {
  return VStack(props);
}

/** Props accepted by `Panel`. */
export interface PanelProps extends BoxProps {
  /** Title drawn into the top border. */
  title?: string;
}
/** Bordered box with padding and an optional title in the border. */
export function Panel(props: PanelProps): VNode {
  const { title, children, ...rest } = props;
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

/** Props accepted by `Button`. */
export interface ButtonProps extends StyleProps, FlexChildProps, Props {
  label: string;
  onClick?: () => void;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/** Push button: a `Clickable` around a bracketed label. */
export function Button(props: ButtonProps): VNode {
  const { label, onClick, focused, disabled, id, ...rest } = props;
  return (
    <Clickable id={id} onClick={onClick} disabled={disabled} {...rest}>
      <Text
        style={disabled ? [styles.dim] : focused ? [styles.bold, styles.inverse] : []}
      >{`[ ${label} ]`}</Text>
    </Clickable>
  );
}

/** Props accepted by `Checkbox`. */
export interface CheckboxProps extends StyleProps, FlexChildProps, Props {
  checked: boolean;
  label?: string;
  onChange?: (checked: boolean) => void;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/** Checkbox row: `[x] label`, toggled by click or Enter/Space. */
export function Checkbox(props: CheckboxProps): VNode {
  const { checked, label, onChange, focused, disabled, id, ...rest } = props;
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

/** Props accepted by `Radio`. */
export interface RadioProps extends StyleProps, FlexChildProps, Props {
  selected: boolean;
  label?: string;
  onSelect?: () => void;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/** Single radio row: `(•) label`. */
export function Radio(props: RadioProps): VNode {
  const { selected, label, onSelect, focused, disabled, id, ...rest } = props;
  return (
    <Clickable id={id} direction="row" gap={1} disabled={disabled} onClick={onSelect} {...rest}>
      <Text style={disabled ? [styles.dim] : focused ? [styles.bold, styles.accent] : []}>
        {selected ? '(•)' : '( )'}
      </Text>
      {label !== undefined ? <Text dim={disabled}>{label}</Text> : null}
    </Clickable>
  );
}

/** Props accepted by `RadioGroup`. */
export interface RadioGroupProps extends StyleProps, FlexChildProps, Props {
  value: string;
  options: Array<{ key: string; label: string; disabled?: boolean }>;
  onChange?: (key: string) => void;
  direction?: Direction;
  gap?: number;
  focusedKey?: string;
  id?: string;
}
/** Radio set rendered from an option list. */
export function RadioGroup(props: RadioGroupProps): VNode {
  const { value, options, onChange, direction, gap, focusedKey, id, ...rest } = props;
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

/** Props accepted by `Switch`. */
export interface SwitchProps extends StyleProps, FlexChildProps, Props {
  on: boolean;
  label?: string;
  onChange?: (on: boolean) => void;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/** Toggle switch: `──●` on (accent), `●──` off (muted). */
export function Switch(props: SwitchProps): VNode {
  const { on, label, onChange, focused, disabled, id, ...rest } = props;
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

/** Props accepted by `TextInput`. */
export interface TextInputProps extends StyleProps, FlexChildProps, Props {
  value: string;
  placeholder?: string;
  caret?: number;
  focused?: boolean;
  onKey?: (event: UiKeyEvent) => boolean | void;
  id?: string;
}
/** Single-line text field wired for focus and key routing. */
export function TextInput(props: TextInputProps): VNode {
  const { value, placeholder, caret, focused, onKey, id, ...rest } = props;
  return (
    <Clickable id={id} onKey={onKey} {...rest}>
      <Input value={value} placeholder={placeholder} caret={caret} focused={focused} />
    </Clickable>
  );
}

/** Props accepted by `Details`. */
export interface DetailsProps extends StyleProps, FlexChildProps, Props {
  title: string;
  open: boolean;
  onToggle?: (open: boolean) => void;
  focused?: boolean;
  id?: string;
  children?: Child;
}
/**
 * Collapsible section: an always-visible summary bar that toggles the content
 * beneath it, like an HTML `<details>` element.
 */
export function Details(props: DetailsProps): VNode {
  const { title, open, onToggle, focused, id, children, ...rest } = props;
  return (
    <Box direction="column" {...rest}>
      <Clickable
        id={id}
        direction="row"
        gap={1}
        onClick={onToggle ? () => onToggle(!open) : undefined}
      >
        <Text style={focused ? [styles.bold, styles.accent] : [styles.bold]}>
          {open ? '▾' : '▸'}
        </Text>
        <Text style={focused ? [styles.bold, styles.accent] : [styles.bold]}>{title}</Text>
      </Clickable>
      {open ? (
        <Box direction="column" paddingX={2}>
          {children}
        </Box>
      ) : null}
    </Box>
  );
}

/** One tab in a `Tabs` strip. */
export interface TabItem {
  key: string;
  label: string;
  disabled?: boolean;
}

/** Props accepted by `TabList`. */
export interface TabListProps extends StyleProps, FlexChildProps, Props {
  items: TabItem[];
  value: string;
  onChange?: (key: string) => void;
  id?: string;
}
/** The tab strip alone: active tab bold+underlined, others dim. */
export function TabList(props: TabListProps): VNode {
  const { items, value, onChange, id, ...rest } = props;
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

/** Props accepted by `Tabs`. */
export interface TabsProps extends TabListProps {
  children?: Child;
}
/**
 * Tab strip with a content area beneath. The caller renders the active
 * panel as children — there is no hidden panel state.
 */
export function Tabs(props: TabsProps): VNode {
  const { children, ...rest } = props;
  return (
    <Box direction="column" gap={1}>
      <TabList {...rest} />
      <Box direction="column">{children}</Box>
    </Box>
  );
}

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
/** One selectable menu row: marker, optional glyph, label, dim detail. */
export function MenuRow(props: MenuRowProps): VNode {
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
}

/** Section heading inside a menu. */
export function MenuHeader(props: { label: string } & Props): VNode {
  return <Text style={[styles.dim, styles.bold]}>{props.label}</Text>;
}

/** Divider inside a menu. */
export function MenuSeparator(_props: Props = {}): VNode {
  return <Rule style={[styles.dim]} />;
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
export function MenuList(props: MenuListProps): VNode {
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
}

/** Props accepted by `Modal`. */
export interface ModalProps extends Props {
  title?: string;
  onDismiss?: () => void;
  width?: number;
  height?: number;
  children?: Child;
}
/**
 * Centered dialog above a dimmed backdrop. Esc — from anywhere, the modal
 * root consumes it — and clicks outside both dismiss.
 */
export function Modal(props: ModalProps): VNode {
  const { title, onDismiss, width, height, children } = props;
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

/** Props accepted by `ContextMenu`. */
export interface ContextMenuProps extends Props {
  /** Cell position the menu opens at — typically the click position. */
  at: { x: number; y: number };
  items: readonly MenuItem[];
  selectedKey?: string | null;
  onSelect: (key: string) => void;
  onDismiss: () => void;
  id?: string;
}
/**
 * Menu overlaying the content at a position. A full-screen catch layer
 * beneath it dismisses on any outside click.
 */
export function ContextMenu(props: ContextMenuProps): VNode {
  const { at, items, selectedKey, onSelect, onDismiss, id } = props;
  return (
    <Box>
      <Layer anchor={{ x: 0, y: -1 }} width={9999} height={9999}>
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
/** Select box: a trigger row and a popover option list anchored beneath it. */
export function Select(props: SelectProps): VNode {
  const { value, options, open, onOpenChange, onChange, placeholder, focused, id } = props;
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

/** Disclosure state helper for `Details`, `Modal`, `Select`, and menus. */
export interface Disclosure {
  readonly open: Signal<boolean>;
  toggle(): void;
  set(open: boolean): void;
}
/** Create toggleable open/closed state that survives re-renders. */
export function createDisclosure(defaultOpen = false): Disclosure {
  const open = createSignal(defaultOpen);
  return {
    open,
    toggle: () => open.set(!open.get()),
    set: (next: boolean) => open.set(next),
  };
}

/** Token color variants used by `Badge` and `Tag`. */
export type ToneVariant = 'accent' | 'muted' | 'danger' | 'success' | 'warning';
/** Semantic status variants used by `Toast` and `Timeline`. */
export type StatusVariant = 'info' | 'success' | 'danger' | 'warning';

/** Props accepted by `Badge`. */
export interface BadgeProps extends FlexChildProps, Props {
  label: string;
  variant?: ToneVariant;
  id?: string;
}
/** Small inline status label: ` label ` in an inverse token color. */
export function Badge(props: BadgeProps): VNode {
  const { label, variant, ...rest } = props;
  return (
    <Text style={[styles[variant ?? 'accent'], styles.inverse]} {...rest}>{` ${label} `}</Text>
  );
}

/** Frame set cycled by `Spinner`. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Props accepted by `Spinner`. */
export interface SpinnerProps extends FlexChildProps, Props {
  /** Current animation step — the caller owns the clock. */
  tick: number;
  frames?: string[];
  id?: string;
}
/** Spinner glyph for the current tick. */
export function Spinner(props: SpinnerProps): VNode {
  const { tick, frames, ...rest } = props;
  const set = frames !== undefined && frames.length > 0 ? frames : SPINNER_FRAMES;
  const frame = set[((tick % set.length) + set.length) % set.length]!;
  return (
    <Text style={[styles.accent]} {...rest}>
      {frame}
    </Text>
  );
}

/** Props accepted by `ProgressBar`. */
export interface ProgressBarProps extends FlexChildProps, Props {
  /** Completion fraction, 0..1. */
  value: number;
  width?: number;
  showPercent?: boolean;
  id?: string;
}
/** Horizontal progress: filled `█` and empty `░` cells, optional percent. */
export function ProgressBar(props: ProgressBarProps): VNode {
  const { value, width, showPercent, id, ...rest } = props;
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

/** Props accepted by `KeyHint`. */
export interface KeyHintProps extends FlexChildProps, Props {
  keys: Array<{ key: string; label: string }>;
  separator?: string;
  id?: string;
}
/** Dim key legend row: `y approve · n reject`, keys bold. */
export function KeyHint(props: KeyHintProps): VNode {
  const { keys, separator, id, ...rest } = props;
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

/** Props accepted by `Tag`. */
export interface TagProps extends FlexChildProps, Props {
  label: string;
  onRemove?: () => void;
  color?: ToneVariant;
  id?: string;
}
/** Chip: ` label ` in an inverse token color, with an optional `×` remover. */
export function Tag(props: TagProps): VNode {
  const { label, onRemove, color, id, ...rest } = props;
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

/** Props accepted by `TagGroup`. */
export interface TagGroupProps extends FlexChildProps, Props {
  gap?: number;
  id?: string;
  children?: Child;
}
/** Wrapping row of tags. */
export function TagGroup(props: TagGroupProps): VNode {
  const { gap, children, ...rest } = props;
  return (
    <Box direction="row" wrap gap={gap ?? 1} {...rest}>
      {children}
    </Box>
  );
}

/** Props accepted by `Breadcrumbs`. */
export interface BreadcrumbsProps extends FlexChildProps, Props {
  items: Array<{ key: string; label: string }>;
  onNavigate?: (key: string) => void;
  id?: string;
}
/** Path row: dim clickable ancestors, `/` separators, bold current item. */
export function Breadcrumbs(props: BreadcrumbsProps): VNode {
  const { items, onNavigate, id, ...rest } = props;
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

/** Props accepted by `Pagination`. */
export interface PaginationProps extends FlexChildProps, Props {
  page: number;
  pages: number;
  onChange: (page: number) => void;
  id?: string;
}
/** Pager: `‹ 2 / 14 ›`, chevrons disabled at the ends. */
export function Pagination(props: PaginationProps): VNode {
  const { page, pages, onChange, id, ...rest } = props;
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

/** Props accepted by `Steps`. */
export interface StepsProps extends FlexChildProps, Props {
  steps: Array<{ key: string; label: string }>;
  current: string;
  id?: string;
}
/** Step strip: success `●` done, bold accent `●` current, dim `○` upcoming. */
export function Steps(props: StepsProps): VNode {
  const { steps, current, id, ...rest } = props;
  const at = steps.findIndex((step) => step.key === current);
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      {steps.flatMap((step, index) => {
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

/** One section of an `Accordion`. */
export interface AccordionSection {
  key: string;
  title: string;
  content: Child;
}
/** Props accepted by `Accordion`. */
export interface AccordionProps extends FlexChildProps, Props {
  sections: AccordionSection[];
  openKeys: string[];
  onToggle?: (key: string) => void;
  id?: string;
}
/**
 * Stack of `Details` sections. The caller owns `openKeys` — pair with
 * `createAccordion(true)` when only one section may stay open.
 */
export function Accordion(props: AccordionProps): VNode {
  const { sections, openKeys, onToggle, id, ...rest } = props;
  return (
    <Box direction="column" id={id} {...rest}>
      {sections.map((section) => (
        <Details
          key={section.key}
          id={id !== undefined ? `${id}:${section.key}` : undefined}
          title={section.title}
          open={openKeys.includes(section.key)}
          onToggle={onToggle ? () => onToggle(section.key) : undefined}
        >
          {section.content}
        </Details>
      ))}
    </Box>
  );
}

/** Accordion open-key state helper. */
export interface AccordionState {
  readonly openKeys: Signal<string[]>;
  toggle(key: string): void;
}
/** Create accordion open-key state; `single` closes other sections on toggle. */
export function createAccordion(single = false): AccordionState {
  const openKeys = createSignal<string[]>([]);
  return {
    openKeys,
    toggle(key: string): void {
      const current = openKeys.get();
      if (current.includes(key)) {
        openKeys.set(current.filter((open) => open !== key));
      } else {
        openKeys.set(single ? [key] : [...current, key]);
      }
    },
  };
}

/** Props accepted by `Popover`. */
export interface PopoverProps extends Props {
  open: boolean;
  /** Hit id of the trigger the popover anchors beneath. */
  anchorId: string;
  onDismiss?: () => void;
  children?: Child;
}
/** Bordered overlay anchored beneath a trigger. Esc dismisses; no backdrop. */
export function Popover(props: PopoverProps): VNode {
  const { open, anchorId, onDismiss, children } = props;
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

/** Props accepted by `Tooltip`. */
export interface TooltipProps extends Props {
  text: string;
  /** Shown state — the app decides when; there is no hover tracking. */
  open: boolean;
  anchorId: string;
}
/** One-line dim-bordered hint anchored beneath a trigger. */
export function Tooltip(props: TooltipProps): VNode {
  const { text, open, anchorId } = props;
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

/** Props accepted by `Toast`. */
export interface ToastProps extends Props {
  message: string;
  variant?: StatusVariant;
}
/** One notification: a small box with a variant-colored border. */
export function Toast(props: ToastProps): VNode {
  const { message, variant } = props;
  return (
    <Box border paddingX={1} borderColor={styles[variant ?? 'info'].fg}>
      <Text>{message}</Text>
    </Box>
  );
}

/** Props accepted by `ToastStack`. */
export interface ToastStackProps extends Props {
  toasts: Array<{ id: string; message: string; variant?: StatusVariant }>;
}
/** Notification column pinned to the top-right corner in a layer. */
export function ToastStack(props: ToastStackProps): VNode {
  const { toasts } = props;
  return (
    <Box>
      {toasts.length > 0 ? (
        <Layer anchor={{ x: 9999, y: -1 }} placement="bottom-end">
          <Box direction="column" align="end">
            {toasts.map((toast) => (
              <Toast key={toast.id} message={toast.message} variant={toast.variant} />
            ))}
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
}

/** One column of a `Table`. */
export interface TableColumn {
  key: string;
  header: string;
  /** Explicit cell width; narrower content truncates with `…`. */
  width?: number;
  align?: 'start' | 'end';
}
/** Props accepted by `Table`. */
export interface TableProps extends FlexChildProps, Props {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  selectedIndex?: number;
  onSelectRow?: (index: number) => void;
  id?: string;
}
/** Data table: bold header over a dim rule, fitted columns, clickable rows. */
export function Table(props: TableProps): VNode {
  const { columns, rows, selectedIndex, onSelectRow, id, ...rest } = props;
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

/** One node of a `FileTree`; `children` left undefined marks a leaf. */
export interface FileTreeNode {
  key: string;
  label: string;
  children?: FileTreeNode[];
}
/** Props accepted by `FileTree`. */
export interface FileTreeProps extends FlexChildProps, Props {
  nodes: FileTreeNode[];
  expanded: string[];
  selectedKey?: string | null;
  onToggle?: (key: string) => void;
  onSelect?: (key: string) => void;
  id?: string;
}
/**
 * Indented tree: directories carry a `▸`/`▾` toggle glyph, rows select on
 * click. The glyph is its own `Clickable`, so a toggle never also selects.
 */
export function FileTree(props: FileTreeProps): VNode {
  const { nodes, expanded, selectedKey, onToggle, onSelect, id, ...rest } = props;
  const rows: VNode[] = [];
  const visit = (node: FileTreeNode, depth: number): void => {
    const dir = node.children !== undefined;
    const open = dir && expanded.includes(node.key);
    const selected = node.key === selectedKey;
    rows.push(
      <Clickable
        key={node.key}
        id={id !== undefined ? `${id}:${node.key}` : undefined}
        direction="row"
        focusable={false}
        style={selected ? [styles.bold, styles.inverse] : []}
        onClick={onSelect ? () => onSelect(node.key) : undefined}
      >
        {depth > 0 ? <Text>{' '.repeat(depth * 2)}</Text> : null}
        {dir ? (
          <Clickable
            id={id !== undefined ? `${id}:${node.key}:toggle` : undefined}
            focusable={false}
            onClick={onToggle ? () => onToggle(node.key) : undefined}
          >
            <Text>{open ? '▾ ' : '▸ '}</Text>
          </Clickable>
        ) : (
          <Text>{'  '}</Text>
        )}
        <Text>{node.label}</Text>
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

/** Tree expansion state helper for `FileTree`. */
export interface TreeState {
  readonly expanded: Signal<string[]>;
  toggle(key: string): void;
  isExpanded(key: string): boolean;
}
/** Create tree expansion state that survives re-renders. */
export function createTreeState(defaultExpanded: string[] = []): TreeState {
  const expanded = createSignal<string[]>(defaultExpanded);
  return {
    expanded,
    toggle(key: string): void {
      const current = expanded.get();
      expanded.set(
        current.includes(key) ? current.filter((open) => open !== key) : [...current, key],
      );
    },
    isExpanded: (key: string) => expanded.get().includes(key),
  };
}

/** One entry of a `Timeline`. */
export interface TimelineEntry {
  key: string;
  title: string;
  detail?: string;
  variant?: StatusVariant;
}
/** Props accepted by `Timeline`. */
export interface TimelineProps extends FlexChildProps, Props {
  entries: TimelineEntry[];
  id?: string;
}
/** Vertical event list: variant-colored `●` titles, dim `│` connector details. */
export function Timeline(props: TimelineProps): VNode {
  const { entries, id, ...rest } = props;
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
