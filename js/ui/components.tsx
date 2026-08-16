/** @jsxImportSource fino:ui */
/**
 * fino:ui/components — host-neutral UI primitives and the semantic component
 * catalog.
 *
 * Two vocabularies live here. The structural primitives — `box`, `text`,
 * `layer`, `clickable`, `input`, `scrollview` (plus the `spacer` and `rule`
 * helpers) — describe layout, and render targets implement them directly.
 * Catalog components sit above them and are purely semantic: `Checkbox()`
 * emits a `ui:checkbox` node carrying `checked`, `label`, and `onChange`, and
 * says nothing about presentation. Each render target owns the lowering:
 * `internal:tty/lower` turns semantic nodes into the glyph-and-box
 * compositions the terminal paints, and `fino:ui/components/html` turns the
 * same nodes into native web markup (`<input type="checkbox">`, `<details>`,
 * `<select>`).
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
 *
 * ## Module layout
 *
 * The catalog is grouped into `internal:ui/components/*` modules — one per
 * component family, each with its stories file beside it — and this module is
 * the single public entry point over them. What it re-exports *is* the public
 * API: components, their props types, the data types those props name, and
 * the state models (`createTextField`, `ListSelection`, `VirtualScroll`, …)
 * an application holds across renders.
 *
 * Pure helpers that exist so the two render targets agree — the edit reducers
 * behind `TextInput`, the icon registry lookups, the calendar and axis math,
 * the braille rasterizer — are deliberately *not* re-exported here. They are
 * lowering machinery, not application API; a render target imports them from
 * the group module that owns them.
 */

export { styles } from 'fino:ui/components/theme';
export type { Color, Style } from 'fino:tty/style';

export {
  Box,
  Text,
  Spacer,
  Input,
  Layer,
  Clickable,
  Scroll,
  Rule,
} from 'internal:ui/components/primitives';
export type {
  Direction,
  Align,
  Justify,
  WrapMode,
  BorderStyle,
  StyleProps,
  FlexChildProps,
  BoxProps,
  TextProps,
  SpacerProps,
  TextSelection,
  InputProps,
  LayerProps,
  UiKeyEvent,
  UiMouseEvent,
  ClickableProps,
  ScrollProps,
  RuleProps,
} from 'internal:ui/components/primitives';

export { VStack, HStack, Stack, Panel, Field, Fieldset } from 'internal:ui/components/layout';
export type {
  StackProps,
  PanelProps,
  FieldProps,
  FieldsetProps,
} from 'internal:ui/components/layout';

export {
  Button,
  Checkbox,
  Radio,
  RadioGroup,
  Switch,
  TextInput,
  TextArea,
  NumberInput,
  Slider,
} from 'internal:ui/components/forms';
export type {
  ButtonProps,
  CheckboxProps,
  RadioProps,
  RadioGroupProps,
  SwitchProps,
  TextInputProps,
  TextAreaProps,
  NumberInputProps,
  SliderProps,
} from 'internal:ui/components/forms';

export { createTextField, createTextArea } from 'internal:ui/components/text-edit';
export type { TextFieldState, TextAreaState } from 'internal:ui/components/text-edit';

export {
  Expander,
  Details,
  TabList,
  Tabs,
  Accordion,
  createDisclosure,
  createAccordion,
} from 'internal:ui/components/disclosure';
export type {
  ExpanderPosition,
  ExpanderProps,
  DetailsProps,
  TabItem,
  TabListProps,
  TabsProps,
  AccordionSection,
  AccordionProps,
  AccordionState,
  Disclosure,
} from 'internal:ui/components/disclosure';

export {
  ListSelection,
  MenuRow,
  MenuHeader,
  MenuSeparator,
  MenuList,
  Select,
  ComboBox,
} from 'internal:ui/components/menu';
export type {
  MenuItem,
  MenuRowProps,
  MenuListProps,
  SelectProps,
  ComboBoxOption,
  ComboBoxProps,
} from 'internal:ui/components/menu';

export {
  Modal,
  ContextMenu,
  Popover,
  Tooltip,
  Toast,
  ToastStack,
  HoverCard,
  FloatingActionBar,
} from 'internal:ui/components/overlay';
export type {
  ModalProps,
  ContextMenuProps,
  PopoverProps,
  TooltipProps,
  ToastProps,
  ToastStackProps,
  HoverCardProps,
  FloatingActionBarProps,
} from 'internal:ui/components/overlay';

export {
  Badge,
  Spinner,
  ProgressBar,
  KeyHint,
  Tag,
  TagGroup,
} from 'internal:ui/components/feedback';
export type {
  ToneVariant,
  StatusVariant,
  BadgeProps,
  SpinnerProps,
  ProgressBarProps,
  KeyHintProps,
  TagProps,
  TagGroupProps,
} from 'internal:ui/components/feedback';

export { Breadcrumbs, Pagination, Steps } from 'internal:ui/components/navigation';
export type {
  BreadcrumbsProps,
  PaginationProps,
  StepsProps,
} from 'internal:ui/components/navigation';

export { Icon, IconButton } from 'internal:ui/components/icons';
export type { IconForms, IconProps, IconButtonProps } from 'internal:ui/components/icons';

export { Table, FileTree, createTreeState, Timeline } from 'internal:ui/components/data';
export type {
  TableColumn,
  TableProps,
  FileTreeNode,
  FileTreeProps,
  TreeState,
  TimelineEntry,
  TimelineProps,
} from 'internal:ui/components/data';

export { VirtualScroll, VirtualList } from 'internal:ui/components/virtual';
export type { VirtualWindow, VirtualListProps } from 'internal:ui/components/virtual';

export {
  Heading,
  Bold,
  Italic,
  Link,
  Blockquote,
  List,
  Code,
  InlineCode,
} from 'internal:ui/components/typography';
export type {
  HeadingProps,
  BoldProps,
  ItalicProps,
  LinkProps,
  BlockquoteProps,
  ListProps,
  CodeProps,
  InlineCodeProps,
} from 'internal:ui/components/typography';

export { Card, Stat, StatusDot, EmptyState } from 'internal:ui/components/display';
export type {
  CardProps,
  Trend,
  StatProps,
  StatusDotStatus,
  StatusDotProps,
  EmptyStateProps,
} from 'internal:ui/components/display';

export {
  Calendar,
  DigitalClock,
  DatePicker,
  TimePicker,
  ColorPicker,
} from 'internal:ui/components/pickers';
export type {
  CalendarProps,
  DigitalClockProps,
  DatePickerProps,
  TimePickerProps,
  ColorPickerProps,
} from 'internal:ui/components/pickers';

export { BarChart, LineChart } from 'internal:ui/components/charts';
export type { Series, BarChartProps, LineChartProps } from 'internal:ui/components/charts';
