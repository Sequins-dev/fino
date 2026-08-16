/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/pickers.tui — terminal forms for calendars, clocks, and the date/time/colour pickers.
 *
 * @internal
 */
import { h, mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { Box, Clickable, Layer, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { env } from 'fino:process';
import { nearestAnsi256, supportsTruecolor } from 'fino:tty/style';
import type { Color, Style } from 'fino:tty/style';
import { parseHexColor } from 'internal:ui/components/pickers';
import { formatClockTime, formatTimeParts, monthGrid, monthLabel, parseClockTime, parseIsoMonth, shiftMonth, timeColumnWindow, weekdayLabels } from 'internal:ui/components/pickers';
import { Calendar, ColorPicker, DatePicker, DigitalClock, TimePicker } from 'internal:ui/components/pickers';
import type { ClockParts } from 'internal:ui/components/pickers';
import type {
  CalendarProps,
  ColorPickerProps,
  DatePickerProps,
  DigitalClockProps,
  TimePickerProps,
} from 'internal:ui/components/pickers';

function colorSwatch(hex: string, truecolor: boolean): Color | undefined {
  const rgb = parseHexColor(hex);
  if (rgb === null) return undefined;
  const [r, g, b] = rgb;
  return truecolor ? { rgb: [r, g, b] } : { ansi256: nearestAnsi256(r, g, b) };
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

mapRenderTargetLowering(Calendar, 'tui', (all: CalendarProps): VNode => {
  const { children = [], ...props } = all as CalendarProps & { children?: NormalizedChild[] };
  const { month, selected, today, weekStartsOn, onSelect, onMonthChange, id, ...rest } =
    props;
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
});

mapRenderTargetLowering(DigitalClock, 'tui', (all: DigitalClockProps): VNode => {
  const { children = [], ...props } = all as DigitalClockProps & { children?: NormalizedChild[] };
  const { time, seconds, label, id, ...rest } = props;
  return (
    <Box direction="column" id={id} {...rest}>
      <Text bold>{formatClockTime(time, seconds === true)}</Text>
      {label !== undefined ? <Text style={[styles.dim]}>{label}</Text> : null}
    </Box>
  );
});

mapRenderTargetLowering(DatePicker, 'tui', (all: DatePickerProps): VNode => {
  const { children = [], ...props } = all as DatePickerProps & { children?: NormalizedChild[] };
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
  } = props;
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
});

mapRenderTargetLowering(TimePicker, 'tui', (all: TimePickerProps): VNode => {
  const { children = [], ...props } = all as TimePickerProps & { children?: NormalizedChild[] };
  const { value, open, onOpenChange, onChange, step, seconds, focused, disabled, placeholder, id } =
    props;
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
});

mapRenderTargetLowering(ColorPicker, 'tui', (all: ColorPickerProps): VNode => {
  const { children = [], ...props } = all as ColorPickerProps & { children?: NormalizedChild[] };
  const { value, onChange, swatches, open, onOpenChange, id, ...rest } = props;
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
});
