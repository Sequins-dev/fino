/** Terminal lowerings for date, time, and color pickers. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { env } from 'fino:process';
import { Box, Clickable, Text } from 'fino:ui/components';
import type { UiKeyEvent } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { supportsTruecolor } from 'fino:tty/style';
import type { Style } from 'fino:tty/style';
import { terminalColor } from 'internal:ui/components/color.tui';
import { dismissOnEscape } from 'internal:ui/components/interaction';
import { Popover } from 'internal:ui/components/overlay';
import {
  Calendar,
  ColorPicker,
  DatePicker,
  DigitalClock,
  TimePicker,
  formatClockTime,
  formatTimeParts,
  monthGrid,
  monthLabel,
  normalizeColorSwatches,
  normalizeHexColor,
  normalizeTimeStep,
  parseClockTime,
  parseHexColor,
  parseIsoMonth,
  shiftMonth,
  timeColumnWindow,
  weekdayLabels,
} from 'internal:ui/components/pickers';
import { mapComponentLowering } from 'internal:ui/components/target';

mapComponentLowering(Calendar, 'tui', (props) => {
  const { year, month } = parseIsoMonth(props.month);
  return h(
    Box,
    { direction: 'column', id: props.id },
    h(
      Box,
      { direction: 'row', justify: 'between' },
      h(
        Clickable,
        {
          focusable: false,
          onClick:
            props.onMonthChange === undefined
              ? undefined
              : () => props.onMonthChange!(shiftMonth(props.month, -1)),
        },
        h(Text, { style: [styles.accent] }, '‹'),
      ),
      h(Text, { bold: true }, monthLabel(year, month)),
      h(
        Clickable,
        {
          focusable: false,
          onClick:
            props.onMonthChange === undefined
              ? undefined
              : () => props.onMonthChange!(shiftMonth(props.month, 1)),
        },
        h(Text, { style: [styles.accent] }, '›'),
      ),
    ),
    h(
      Box,
      { direction: 'row', gap: 1 },
      ...weekdayLabels(props.weekStartsOn).map((label) =>
        h(Text, { key: label, width: 2, align: 'center', style: [styles.dim] }, label),
      ),
    ),
    ...monthGrid(year, month, props.weekStartsOn).map((week, index) =>
      h(
        Box,
        { key: String(index), direction: 'row', gap: 1 },
        ...week.map((cell) => {
          const style: Style[] = [];
          if (!cell.currentMonth) style.push(styles.dim);
          if (cell.date === props.today) style.push(styles.underline);
          if (cell.date === props.selected) style.push(styles.inverse, styles.bold);
          return h(
            Clickable,
            {
              key: cell.date,
              focusable: false,
              onClick: props.onSelect === undefined ? undefined : () => props.onSelect!(cell.date),
            },
            h(Text, { width: 2, align: 'center', style }, String(cell.day).padStart(2, ' ')),
          );
        }),
      ),
    ),
  );
});

mapComponentLowering(DigitalClock, 'tui', (props) =>
  h(
    Box,
    { direction: 'column', id: props.id },
    h(Text, { bold: true }, formatClockTime(props.time, props.seconds === true)),
    props.label === undefined ? null : h(Text, { style: [styles.dim] }, props.label),
  ),
);

mapComponentLowering(DatePicker, 'tui', (props) => {
  const close = () => props.onOpenChange(false);
  return h(
    Box,
    { direction: 'column' },
    h(
      Clickable,
      {
        id: props.id,
        direction: 'row',
        gap: 1,
        disabled: props.disabled,
        onClick: props.disabled === true ? undefined : () => props.onOpenChange(!props.open),
        onKey: dismissOnEscape(props.open ? close : undefined),
      },
      h(
        Text,
        { style: props.value === undefined ? [styles.dim] : [] },
        props.value ?? props.placeholder ?? 'Select date…',
      ),
      h(Text, { style: props.focused ? [styles.accent] : [styles.dim] }, props.open ? '▴' : '▾'),
    ),
    h(
      Popover,
      { open: props.open, anchorId: props.id, onDismiss: close },
      h(Calendar, {
        month: props.month ?? props.value?.slice(0, 7) ?? '1970-01',
        selected: props.value,
        today: props.today,
        weekStartsOn: props.weekStartsOn,
        onMonthChange: props.onMonthChange,
        onSelect: (date) => {
          props.onChange(date);
          close();
        },
      }),
    ),
  );
});

function minuteOptions(step: number): number[] {
  const size = Math.max(1, Math.min(60, Math.floor(Number.isFinite(step) ? step : 1)));
  return Array.from({ length: Math.ceil(60 / size) }, (_, index) => index * size).filter(
    (value) => value < 60,
  );
}

mapComponentLowering(TimePicker, 'tui', (props) => {
  const parsed = parseClockTime(props.value);
  const step = normalizeTimeStep(props.step);
  const commit = (hours: number, minutes: number, seconds = parsed.seconds) =>
    props.onChange(formatTimeParts(hours, minutes, props.seconds ? seconds : undefined));
  const stepMinutes = (delta: number) => {
    const total = (((parsed.hours * 60 + parsed.minutes + delta) % 1440) + 1440) % 1440;
    commit(Math.floor(total / 60), total % 60);
  };
  const close = () => props.onOpenChange(false);
  const onKey = (event: UiKeyEvent): boolean => {
    if (!props.open || event.ctrl || event.alt) return false;
    if (event.key === 'escape' || event.key === 'enter') {
      close();
      return true;
    }
    if (event.key === 'up' || event.key === 'down') {
      stepMinutes(event.key === 'up' ? step : -step);
      return true;
    }
    if (event.key === 'left' || event.key === 'right') {
      commit((parsed.hours + (event.key === 'right' ? 1 : 23)) % 24, parsed.minutes);
      return true;
    }
    return false;
  };
  const column = (
    key: string,
    values: number[],
    current: number,
    pick: (value: number) => void,
  ): VNode =>
    h(
      Box,
      { key, direction: 'column' },
      ...values.map((value) =>
        h(
          Clickable,
          { key: String(value), focusable: false, onClick: () => pick(value) },
          h(
            Text,
            { style: value === current ? [styles.inverse, styles.bold] : [] },
            String(value).padStart(2, '0'),
          ),
        ),
      ),
    );
  const minutes = minuteOptions(step);
  const selectedMinute = minutes.reduce(
    (best, value) =>
      Math.abs(value - parsed.minutes) < Math.abs(best - parsed.minutes) ? value : best,
    minutes[0] ?? 0,
  );
  const children: VNode[] = [
    column('h', timeColumnWindow(parsed.hours, 24), parsed.hours, (value) =>
      commit(value, parsed.minutes),
    ),
    h(Text, { key: 'hm' }, ':'),
    column(
      'm',
      minutes.length <= 5
        ? minutes
        : timeColumnWindow(minutes.indexOf(selectedMinute), minutes.length).map(
            (index) => minutes[index]!,
          ),
      selectedMinute,
      (value) => commit(parsed.hours, value),
    ),
  ];
  if (props.seconds)
    children.push(
      h(Text, { key: 'ms' }, ':'),
      column('s', timeColumnWindow(parsed.seconds, 60), parsed.seconds, (value) =>
        commit(parsed.hours, parsed.minutes, value),
      ),
    );
  return h(
    Box,
    { direction: 'column' },
    h(
      Clickable,
      {
        id: props.id,
        direction: 'row',
        gap: 1,
        disabled: props.disabled,
        onClick: props.disabled ? undefined : () => props.onOpenChange(!props.open),
        onKey,
      },
      h(
        Text,
        { style: props.value === undefined ? [styles.dim] : [] },
        props.value === undefined
          ? (props.placeholder ?? '--:--')
          : formatClockTime(props.value, props.seconds),
      ),
      h(Text, { style: props.focused ? [styles.accent] : [styles.dim] }, props.open ? '▴' : '▾'),
    ),
    h(
      Popover,
      { open: props.open, anchorId: props.id, onDismiss: close },
      h(Box, { direction: 'row', gap: 1 }, ...children),
    ),
  );
});

mapComponentLowering(ColorPicker, 'tui', (props) => {
  const truecolor = supportsTruecolor(env.COLORTERM);
  const swatch = (hex: string) => {
    const rgb = parseHexColor(hex);
    return rgb === null ? undefined : terminalColor(rgb, truecolor);
  };
  const valid = normalizeHexColor(props.value);
  const grid = h(
    Box,
    { direction: 'row', wrap: true, gap: 1 },
    ...normalizeColorSwatches(props.swatches).map((hex) =>
      h(
        Clickable,
        { key: hex, focusable: false, onClick: () => props.onChange(hex) },
        h(Box, { background: swatch(hex), width: 4, height: 3, border: hex === valid }),
      ),
    ),
  );
  const preview = h(Box, {
    background: valid === null ? undefined : swatch(valid),
    width: 3,
    height: 1,
  });
  if (props.onOpenChange !== undefined && props.id !== undefined)
    return h(
      Box,
      { direction: 'column' },
      h(
        Clickable,
        {
          id: props.id,
          direction: 'row',
          gap: 1,
          onClick: () => props.onOpenChange!(!props.open),
          onKey: dismissOnEscape(props.open ? () => props.onOpenChange!(false) : undefined),
        },
        preview,
        h(Text, { style: [styles.dim] }, props.value),
      ),
      h(
        Popover,
        {
          open: props.open === true,
          anchorId: props.id,
          onDismiss: () => props.onOpenChange!(false),
        },
        grid,
      ),
    );
  return h(
    Box,
    { direction: 'column', gap: 1, id: props.id } as Props,
    h(Box, { direction: 'row', gap: 1 }, preview, h(Text, { style: [styles.dim] }, props.value)),
    grid,
  );
});
