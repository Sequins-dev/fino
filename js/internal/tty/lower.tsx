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
import { h, defineRenderTarget, lowerTree, mapRenderTargetLowering } from 'fino:ui';
// Terminal lowerings that live beside their components, imported for their
// registration side effects.
import 'internal:ui/components/feedback.tui';
import 'internal:ui/components/navigation.tui';
import 'internal:ui/components/data.tui';
import 'internal:ui/components/overlay.tui';
import 'internal:ui/components/menu.tui';
import 'internal:ui/components/disclosure.tui';
import 'internal:ui/components/forms.tui';
import 'internal:ui/components/layout.tui';
import 'internal:ui/components/typography.tui';
import 'internal:ui/components/display.tui';
import 'internal:ui/components/icons.tui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { stringWidth } from 'fino:tty/frame';
import { highlightLines } from 'fino:format/typescript';
import { env } from 'fino:process';
import {
  Box,
  Calendar,
  Clickable,
  Expander,
  Input,
  Layer,
  MenuHeader,
  MenuList,
  MenuRow,
  MenuSeparator,
  Panel,
  Radio,
  Rule,
  TabList,
  Text,
  Toast,
  styles,
} from 'fino:ui/components';
// The rest of what a lowering needs is deliberately absent from the public
// barrel: pure helpers that exist so both render targets agree on the same
// answer (the same edit reducer, the same icon name, the same axis ticks)
// rather than API an application would call. They come from the catalog
// module that owns each one.
import { applyTextAreaEdit, applyTextEdit } from 'internal:ui/components/text-edit';
import { defaultComboBoxFilter } from 'internal:ui/components/menu';
import { iconForm } from 'internal:ui/components/icons';
import { fileIcon } from 'internal:ui/components/data';
import { paginationRange } from 'internal:ui/components/navigation';
import { niceScale, plotBraille, seriesColor } from 'internal:ui/components/charts';
import {
  formatClockTime,
  formatTimeParts,
  monthGrid,
  monthLabel,
  parseClockTime,
  parseHexColor,
  parseIsoMonth,
  shiftMonth,
  timeColumnWindow,
  weekdayLabels,
} from 'internal:ui/components/pickers';
import type { ClockParts } from 'internal:ui/components/pickers';
import type {
  BarChartProps,
  BlockquoteProps,
  BoldProps,
  BreadcrumbsProps,
  ButtonProps,
  CalendarProps,
  CardProps,
  CheckboxProps,
  CodeProps,
  ColorPickerProps,
  ComboBoxProps,
  ContextMenuProps,
  DatePickerProps,
  DetailsProps,
  DigitalClockProps,
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
  LineChartProps,
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
  RadioGroupProps,
  RadioProps,
  SelectProps,
  Series,
  SliderProps,
  StatProps,
  StatusDotProps,
  StatusDotStatus,
  StepsProps,
  SwitchProps,
  TabListProps,
  TableProps,
  TabsProps,
  TextAreaProps,
  TextInputProps,
  TimelineProps,
  TimePickerProps,
  ToastProps,
  ToastStackProps,
  TooltipProps,
  Trend,
  UiKeyEvent,
  UiMouseEvent,
  VirtualListProps,
} from 'fino:ui/components';
import type { Color, Style } from 'fino:tty/style';
import { nearestAnsi256, supportsTruecolor } from 'fino:tty/style';

type Composer = (props: Props, children: NormalizedChild[]) => VNode;










function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let out = value;
  if (max !== undefined) out = Math.min(out, max);
  if (min !== undefined) out = Math.max(out, min);
  return out;
}










function menuHeader(props: Props): VNode {
  return <Text style={[styles.dim, styles.bold]}>{(props as { label: string }).label}</Text>;
}

function menuSeparator(): VNode {
  return <Rule style={[styles.dim]} />;
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












// `Link` is the one catalog component allowed to navigate. With `onActivate`
// it becomes a focusable Clickable, same as any other click-like control.
// Terminals get no clickable hyperlinks: OSC 8 cannot survive the frame
// pipeline (parseAnsi drops non-SGR escapes so segments stay free of control
// codes), and carrying links through Segment/Row is a frame-model change we
// chose not to make. An href-only link renders as styled, underlined text.

// Each child gets its own gutter row, so a quote built from several `Text`
// lines carries `│` beside every one of them — matching Markdown's `>` on
// every quoted line. A single child that word-wraps internally still only
// carries one gutter for that block: how many rows it wraps to is a
// layout-time decision made after this composer runs, and repeating the
// gutter per wrapped row would mean teaching the frame/cell layer about a
// tiling left border, which is out of scope for a component lowering.








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

function calendarTui(props: Props): VNode {
  const { month, selected, today, weekStartsOn, onSelect, onMonthChange, id, ...rest } =
    props as CalendarProps;
  const { year, month: m } = parseIsoMonth(month);
  const weeks = monthGrid(year, m, weekStartsOn ?? 0);
  const labels = weekdayLabels(weekStartsOn ?? 0);
  return (
    <Box direction="column" id={id} {...rest}>
      <Box direction="row" justify="between">
        <Clickable
          id={id !== undefined ? `${id}:prev` : undefined}
          focusable={false}
          disabled={onMonthChange === undefined}
          onClick={onMonthChange ? () => onMonthChange(shiftMonth(month, -1)) : undefined}
        >
          <Text style={onMonthChange ? [styles.accent] : [styles.dim]}>‹</Text>
        </Clickable>
        <Text style={[styles.bold]}>{monthLabel(year, m)}</Text>
        <Clickable
          id={id !== undefined ? `${id}:next` : undefined}
          focusable={false}
          disabled={onMonthChange === undefined}
          onClick={onMonthChange ? () => onMonthChange(shiftMonth(month, 1)) : undefined}
        >
          <Text style={onMonthChange ? [styles.accent] : [styles.dim]}>›</Text>
        </Clickable>
      </Box>
      <Box direction="row" gap={1}>
        {labels.map((label) => (
          <Text key={label} width={2} align="center" style={[styles.dim]}>
            {label}
          </Text>
        ))}
      </Box>
      {weeks.map((week, wi) => (
        <Box key={String(wi)} direction="row" gap={1}>
          {week.map((cell) => {
            const isSelected = cell.date === selected;
            const isToday = cell.date === today;
            const cellStyle: Style[] = [];
            if (!cell.currentMonth) cellStyle.push(styles.dim);
            if (isToday) cellStyle.push(styles.underline);
            if (isSelected) cellStyle.push(styles.inverse, styles.bold);
            return (
              <Clickable
                key={cell.date}
                id={id !== undefined ? `${id}:${cell.date}` : undefined}
                focusable={false}
                onClick={onSelect ? () => onSelect(cell.date) : undefined}
              >
                <Text width={2} align="center" style={cellStyle}>
                  {String(cell.day).padStart(2, ' ')}
                </Text>
              </Clickable>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

function digitalClock(props: Props): VNode {
  const { time, seconds, label, id, ...rest } = props as DigitalClockProps;
  return (
    <Box direction="column" id={id} {...rest}>
      <Text bold>{formatClockTime(time, seconds === true)}</Text>
      {label !== undefined ? <Text style={[styles.dim]}>{label}</Text> : null}
    </Box>
  );
}

function datePicker(props: Props): VNode {
  const {
    value,
    open,
    onOpenChange,
    onChange,
    month,
    onMonthChange,
    today,
    weekStartsOn,
    focused,
    disabled,
    placeholder,
    id,
  } = props as DatePickerProps;
  const shownMonth = month ?? (value !== undefined ? value.slice(0, 7) : '1970-01');
  return (
    <Box direction="column">
      <Clickable
        id={id}
        direction="row"
        gap={1}
        disabled={disabled}
        onClick={disabled === true ? undefined : () => onOpenChange(!open)}
        onKey={(event) => {
          if (event.key === 'escape' && open) {
            onOpenChange(false);
            return true;
          }
          return false;
        }}
      >
        <Text style={value !== undefined ? [] : [styles.dim]}>
          {value ?? placeholder ?? 'Select date…'}
        </Text>
        <Text style={focused ? [styles.accent] : [styles.dim]}>{open ? '▴' : '▾'}</Text>
      </Clickable>
      {open ? (
        <Layer anchorId={id}>
          <Box border paddingX={1}>
            <Calendar
              id={id !== undefined ? `${id}:cal` : undefined}
              month={shownMonth}
              selected={value}
              today={today}
              weekStartsOn={weekStartsOn}
              onSelect={(date) => {
                onChange(date);
                onOpenChange(false);
              }}
              onMonthChange={onMonthChange}
            />
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
}

function minuteOptions(step: number): number[] {
  const s = Math.max(1, Math.floor(step));
  const count = Math.max(1, Math.floor(60 / s));
  return Array.from({ length: count }, (_, i) => i * s);
}

function nearestOptionIndex(options: number[], value: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < options.length; i++) {
    const dist = Math.abs(options[i]! - value);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// Columns are click-selectable lists, as requested, and — since a component
// cannot hold "which column has arrow-key focus" as state of its own —
// Up/Down and Left/Right step the whole value directly (minutes and hours
// respectively) while the popover is open, the same directly-manipulated
// idiom `NumberInput`/`Slider` already use elsewhere in this catalog, rather
// than inventing per-column keyboard focus state that has nowhere to live.
function timePicker(props: Props): VNode {
  const { value, open, onOpenChange, onChange, step, seconds, focused, disabled, placeholder, id } =
    props as TimePickerProps;
  const parsed = parseClockTime(value);
  const stepMinutesBy = Math.max(1, Math.floor(step ?? 1));
  const showSeconds = seconds === true;
  const commit = (next: ClockParts): void => {
    onChange(formatTimeParts(next.hours, next.minutes, showSeconds ? next.seconds : undefined));
  };
  const stepMinutes = (delta: number): void => {
    const total = (((parsed.hours * 60 + parsed.minutes + delta) % 1440) + 1440) % 1440;
    commit({ hours: Math.floor(total / 60), minutes: total % 60, seconds: parsed.seconds });
  };
  const stepHours = (delta: number): void => {
    commit({ ...parsed, hours: (((parsed.hours + delta) % 24) + 24) % 24 });
  };
  // The trigger — not a captureKeys wrapper around the popover — owns these
  // key bindings: a click to open leaves the trigger itself focused (same as
  // `Select`/`ComboBox`), and `TuiDispatcher` only consults `captureKeys`
  // nodes as a fallback when *nothing* is focused, so a captureKeys popover
  // would never see keys typed right after the open-click.
  const onTriggerKey = (event: UiKeyEvent): boolean => {
    if (event.ctrl || event.alt || !open) return false;
    switch (event.key) {
      case 'escape':
      case 'enter':
        onOpenChange(false);
        return true;
      case 'up':
        stepMinutes(stepMinutesBy);
        return true;
      case 'down':
        stepMinutes(-stepMinutesBy);
        return true;
      case 'left':
        stepHours(-1);
        return true;
      case 'right':
        stepHours(1);
        return true;
      default:
        return false;
    }
  };

  const hourWindow = timeColumnWindow(parsed.hours, 24, 5);
  const minOptions = minuteOptions(stepMinutesBy);
  const minIndex = nearestOptionIndex(minOptions, parsed.minutes);
  const minWindow =
    minOptions.length <= 5
      ? minOptions
      : timeColumnWindow(minIndex, minOptions.length, 5).map((i) => minOptions[i]!);
  const currentMinute = minOptions[minIndex]!;
  const secWindow = showSeconds ? timeColumnWindow(parsed.seconds, 60, 5) : null;

  const column = (
    key: string,
    values: number[],
    current: number,
    onPick: (value: number) => void,
  ): VNode => (
    <Box key={key} direction="column">
      {values.map((v) => (
        <Clickable
          key={String(v)}
          id={id !== undefined ? `${id}:${key}:${v}` : undefined}
          focusable={false}
          onClick={() => onPick(v)}
        >
          <Text style={v === current ? [styles.inverse, styles.bold] : []}>
            {String(v).padStart(2, '0')}
          </Text>
        </Clickable>
      ))}
    </Box>
  );

  const columns: VNode[] = [
    column('h', hourWindow, parsed.hours, (h) => commit({ ...parsed, hours: h })),
    <Text key="sep1" style={[styles.dim]}>
      :
    </Text>,
    column('m', minWindow, currentMinute, (mm) => commit({ ...parsed, minutes: mm })),
  ];
  if (showSeconds) {
    columns.push(
      <Text key="sep2" style={[styles.dim]}>
        :
      </Text>,
      column('s', secWindow!, parsed.seconds, (ss) => commit({ ...parsed, seconds: ss })),
    );
  }

  return (
    <Box direction="column">
      <Clickable
        id={id}
        direction="row"
        gap={1}
        disabled={disabled}
        onClick={disabled === true ? undefined : () => onOpenChange(!open)}
        onKey={onTriggerKey}
      >
        <Text style={value !== undefined ? [] : [styles.dim]}>
          {value !== undefined ? formatClockTime(value, showSeconds) : (placeholder ?? '--:--')}
        </Text>
        <Text style={focused ? [styles.accent] : [styles.dim]}>{open ? '▴' : '▾'}</Text>
      </Clickable>
      {open ? (
        <Layer anchorId={id}>
          <Box border paddingX={1} direction="row" gap={1}>
            {columns}
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
}

function colorSwatch(hex: string, truecolor: boolean): Color | undefined {
  const rgb = parseHexColor(hex);
  if (rgb === null) return undefined;
  const [r, g, b] = rgb;
  return truecolor ? { rgb: [r, g, b] } : { ansi256: nearestAnsi256(r, g, b) };
}

// Truecolor detection (env.COLORTERM via fino:process) happens here, in the
// lowering — never inside the `ColorPicker` component function, which stays
// clock- and environment-free like every other catalog component. Terminals
// that don't report `truecolor`/`24bit` fall back to the nearest of the
// xterm 256-color palette (`nearestAnsi256`) for every swatch cell.
function colorPicker(props: Props): VNode {
  const { value, onChange, swatches, open, onOpenChange, id, ...rest } = props as ColorPickerProps;
  const truecolor = supportsTruecolor(env.COLORTERM);
  const currentColor = colorSwatch(value, truecolor);
  const grid =
    swatches !== undefined && swatches.length > 0 ? (
      <Box direction="row" wrap gap={1}>
        {swatches.map((hex, i) => {
          const selected = hex.toLowerCase() === value.toLowerCase();
          return (
            <Clickable
              key={`${hex}:${i}`}
              id={id !== undefined ? `${id}:swatch:${i}` : undefined}
              focusable={false}
              onClick={() => onChange(hex)}
            >
              <Box
                background={colorSwatch(hex, truecolor)}
                width={4}
                height={3}
                border={selected}
                borderColor={selected ? 'brightWhite' : undefined}
              />
            </Clickable>
          );
        })}
      </Box>
    ) : null;
  const readout = <Text style={[styles.dim]}>{value}</Text>;
  // Plain fill, no `border`: a single-row box has no room to paint a frame
  // (a bordered box needs a top row, a content row, and a bottom row), so a
  // border here would be silently invisible dead weight — unlike the grid
  // swatches below, which are tall enough for `selected`'s border to show.
  const swatchPreview = <Box background={currentColor} width={3} height={1} />;
  if (onOpenChange !== undefined && id !== undefined) {
    return (
      <Box direction="column" {...rest}>
        <Clickable id={id} direction="row" gap={1} onClick={() => onOpenChange(open !== true)}>
          {swatchPreview}
          {readout}
        </Clickable>
        {open === true ? (
          <Layer anchorId={id}>
            <Box border paddingX={1} direction="column" gap={1}>
              {grid}
            </Box>
          </Layer>
        ) : null}
      </Box>
    );
  }
  return (
    <Box direction="column" gap={1} id={id} {...rest}>
      <Box direction="row" gap={1}>
        {swatchPreview}
        {readout}
      </Box>
      {grid}
    </Box>
  );
}

// Chart series colors resolve through the same truecolor-capability check
// ColorPicker's swatches use: `fino:tty/style`'s SGR codec would happily
// emit a raw 24-bit escape for an explicit `{ rgb }` series color even on a
// terminal that can't render it, so it's downgraded to the nearest
// xterm-256 index here — in the lowering, never inside the chart
// components, matching the "environment detection stays out of components"
// rule `colorPicker` already established.
function resolveChartColor(color: Color, truecolor: boolean): Color {
  if (typeof color === 'string' || 'ansi256' in color) return color;
  const [r, g, b] = color.rgb;
  return truecolor ? color : { ansi256: nearestAnsi256(r, g, b) };
}

function chartSeriesColor(series: Series, index: number, truecolor: boolean): Color {
  return resolveChartColor(seriesColor(series, index), truecolor);
}

function formatChartValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// Eighth-cell block glyphs for vertical-bar sub-cell precision — index 0 is
// 1/8 filled, index 7 (`█`) is full.
const BLOCK_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const HORIZONTAL_BAR_TRACK = 24;

function barChart(props: Props): VNode {
  const { series, labels, height, horizontal, showValues, id, ...rest } = props as BarChartProps;
  const truecolor = supportsTruecolor(env.COLORTERM);
  const rows = Math.max(1, Math.floor(height ?? 8));
  const allValues = series.flatMap((s) => s.points);
  const scale = niceScale(Math.min(0, ...allValues), Math.max(0, ...allValues));
  const span = scale.max - scale.min || 1;
  const count = Math.max(0, ...series.map((s) => s.points.length));
  const cats = Array.from({ length: count }, (_, i) => labels?.[i] ?? String(i));

  if (horizontal === true) {
    const labelWidth = Math.max(0, ...cats.map((c) => stringWidth(c)));
    return (
      <Box direction="column" gap={1} id={id} {...rest}>
        {cats.map((cat, ci) => (
          <Box key={String(ci)} direction="column">
            {series.map((s, si) => {
              const value = s.points[ci] ?? 0;
              const fraction = Math.max(0, Math.min(1, (value - scale.min) / span));
              const filled = Math.round(fraction * HORIZONTAL_BAR_TRACK);
              const color = chartSeriesColor(s, si, truecolor);
              return (
                <Box key={s.key} direction="row" gap={1}>
                  <Text width={labelWidth}>{si === 0 ? cat : ''}</Text>
                  <Text style={[{ fg: color }]}>{'█'.repeat(filled)}</Text>
                  {showValues === true ? (
                    <Text style={[styles.dim]}>{formatChartValue(value)}</Text>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    );
  }

  const columnWidth = showValues
    ? Math.max(1, ...allValues.map((v) => formatChartValue(v).length))
    : 1;
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      {cats.map((cat, ci) => (
        <Box key={String(ci)} direction="column">
          {showValues === true ? (
            <Box direction="row">
              {series.map((s, si) => (
                <Text
                  key={s.key}
                  width={columnWidth}
                  align="center"
                  style={[{ fg: chartSeriesColor(s, si, truecolor) }]}
                >
                  {formatChartValue(s.points[ci] ?? 0)}
                </Text>
              ))}
            </Box>
          ) : null}
          <Box direction="column">
            {Array.from({ length: rows }, (_, r) => (
              <Box key={String(r)} direction="row">
                {series.map((s, si) => {
                  const value = s.points[ci] ?? 0;
                  const fraction = Math.max(0, Math.min(1, (value - scale.min) / span));
                  const filledEighths = Math.round(fraction * rows * 8);
                  const band = (rows - 1 - r) * 8;
                  const filledInRow = Math.max(0, Math.min(8, filledEighths - band));
                  const glyph =
                    filledInRow === 0
                      ? ' '
                      : filledInRow === 8
                        ? '█'
                        : BLOCK_LEVELS[filledInRow - 1]!;
                  return (
                    <Text
                      key={s.key}
                      style={filledInRow > 0 ? [{ fg: chartSeriesColor(s, si, truecolor) }] : []}
                    >
                      {glyph.repeat(columnWidth)}
                    </Text>
                  );
                })}
              </Box>
            ))}
          </Box>
          <Text width={series.length * columnWidth} align="center" style={[styles.dim]}>
            {cat}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

const BRAILLE_BLANK = String.fromCodePoint(0x2800);

interface ChartCell {
  char: string;
  color: Color | null;
}

function lineChart(props: Props): VNode {
  const { series, height, showAxis, showLegend, id, ...rest } = props as LineChartProps;
  const truecolor = supportsTruecolor(env.COLORTERM);
  const rows = Math.max(1, Math.floor(height ?? 8));
  const allValues = series.flatMap((s) => s.points);
  const scale =
    allValues.length > 0
      ? niceScale(Math.min(...allValues), Math.max(...allValues))
      : niceScale(0, 1);

  // The plot spans whatever width layout assigns, so a chart fills its
  // container instead of collapsing to its sample count.
  return (
    <Box direction="column" id={id} {...rest}>
      {h('measured', {
        height: rows + (showLegend === true ? 2 : 0),
        render: ({ width: available }: { width: number }) =>
          linePlot({
            series,
            rows,
            // Always fit: the plot scales down to the space it is given
            // rather than overflowing when there are more samples than
            // cells — plotBraille resamples across whatever width it gets.
            width: Math.max(1, available - axisGutter(series, scale, showAxis)),
            scale,
            truecolor,
            showAxis,
            showLegend,
          }),
      })}
    </Box>
  );
}

function axisGutter(
  series: readonly Series[],
  scale: NiceScale,
  showAxis: boolean | undefined,
): number {
  if (showAxis !== true) return 0;
  // Tick label column plus the gap between it and the plot.
  return Math.max(0, ...scale.ticks.map((t) => formatChartValue(t).length)) + 1;
}

interface LinePlotOptions {
  series: readonly Series[];
  rows: number;
  width: number;
  scale: NiceScale;
  truecolor: boolean;
  showAxis: boolean | undefined;
  showLegend: boolean | undefined;
}

function linePlot(options: LinePlotOptions): VNode {
  const { series, rows, width, scale, truecolor, showAxis, showLegend } = options;

  const composite: ChartCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: width }, () => ({ char: ' ', color: null })),
  );
  series.forEach((s, si) => {
    const color = chartSeriesColor(s, si, truecolor);
    const grid = plotBraille([s.points], width, rows, scale);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < width; c++) {
        const ch = grid[r]![c]!;
        if (ch !== BRAILLE_BLANK) composite[r]![c] = { char: ch, color };
      }
    }
  });

  const axisSpan = scale.max - scale.min || 1;
  const axisRowFor = (tick: number): number => {
    const fraction = (scale.max - tick) / axisSpan;
    return Math.max(0, Math.min(rows - 1, Math.round(fraction * (rows - 1))));
  };
  const axisRows = new Map<number, number>();
  if (showAxis === true) for (const tick of scale.ticks) axisRows.set(axisRowFor(tick), tick);
  const axisWidth =
    showAxis === true ? Math.max(0, ...scale.ticks.map((t) => formatChartValue(t).length)) : 0;

  const chartRows = Array.from({ length: rows }, (_, r) => {
    const cells = composite[r]!;
    const runs: VNode[] = [];
    let i = 0;
    while (i < width) {
      const color = cells[i]!.color;
      let j = i + 1;
      while (j < width && cells[j]!.color === color) j++;
      const text = cells
        .slice(i, j)
        .map((cell) => cell.char)
        .join('');
      runs.push(
        <Text key={String(i)} style={color !== null ? [{ fg: color }] : []}>
          {text}
        </Text>,
      );
      i = j;
    }
    const tick = showAxis === true ? axisRows.get(r) : undefined;
    return (
      <Box key={String(r)} direction="row" gap={1}>
        {showAxis === true ? (
          <Text width={axisWidth} align="end" style={[styles.dim]}>
            {tick !== undefined ? formatChartValue(tick) : ''}
          </Text>
        ) : null}
        <Box direction="row">{runs}</Box>
      </Box>
    );
  });

  return (
    <Box direction="column" gap={1}>
      <Box direction="column">{chartRows}</Box>
      {showLegend === true ? (
        <Box direction="row" gap={2}>
          {series.map((s, si) => (
            <Box key={s.key} direction="row" gap={1}>
              <Text style={[{ fg: chartSeriesColor(s, si, truecolor) }]}>●</Text>
              <Text style={[styles.dim]}>{s.label ?? s.key}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

const COMPOSERS: Record<string, Composer> = {
  'ui:menu-header': menuHeader,
  'ui:menu-separator': menuSeparator,
  'ui:virtual-list': virtualList,
  'ui:calendar': calendarTui,
  'ui:digital-clock': digitalClock,
  'ui:date-picker': datePicker,
  'ui:time-picker': timePicker,
  'ui:color-picker': colorPicker,
  'ui:bar-chart': barChart,
  'ui:line-chart': lineChart,
};

/**
 * The node names the terminal paints itself.
 *
 * This is the target's floor: lowering stops here, and anything else reaching
 * it without a registered lowering is an error rather than a silently empty
 * box. `button` and `list` are the older `fino:tty/tui` primitives, still
 * handled by the layout engine.
 */
const TUI_PRIMITIVES = [
  'fragment',
  // Retained host text nodes, so lowering an already-mounted tree is a no-op
  // rather than an error.
  '#text',
  'box',
  'text',
  'spacer',
  'rule',
  'input',
  'button',
  'list',
  'clickable',
  'scrollview',
  'layer',
  'measured',
];

defineRenderTarget('tui', { primitives: TUI_PRIMITIVES });

// Each composer becomes a lowering registered against the semantic node name.
// Registering them here rather than hard-wiring a table is what lets a
// component ship its own terminal lowering later, and lets an application
// override one of these.
for (const [type, compose] of Object.entries(COMPOSERS)) {
  mapRenderTargetLowering(type, 'tui', (props: Props & { children?: NormalizedChild[] }) => {
    const { children, ...rest } = props;
    return compose(rest, children ?? []);
  });
}

/**
 * Lower a semantic tree to terminal primitives.
 *
 * Thin wrapper over `lowerTree(node, 'tui')`, kept because the terminal target
 * and its tests name this operation directly.
 */
export function lowerTui(node: VNode): VNode {
  return lowerTree(node, 'tui');
}
