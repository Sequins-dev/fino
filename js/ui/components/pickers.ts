/**
 * internal:ui/components/pickers — calendars, clocks, and the date/time/color
 * pickers, with the pure math each target's lowering shares.
 *
 * None of these components read a clock — there is no ambient "now". Every
 * date/time value crosses the boundary as an ISO string (`YYYY-MM-DD` dates,
 * `HH:MM`/`HH:MM:SS` 24h times), never a `Date` object (not portable JSON),
 * and the caller supplies "today"/"now" explicitly wherever a component needs
 * it. The date/time math below is pure, so it is unit-testable without
 * rendering anything.
 *
 * @internal
 */
import { h, type Props, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  changeAttrs,
  handlerOf,
  idAttr,
  register,
} from 'internal:ui/components/html-runtime';
import type { FlexChildProps, StyleProps } from 'internal:ui/components/primitives';

/** One day cell of a `Calendar` month grid. */
export interface MonthDayCell {
  /** ISO date, `'YYYY-MM-DD'`. */
  date: string;
  /** Day-of-month number, always relative to the cell's own month. */
  day: number;
  /** `false` for leading/trailing days borrowed from the adjacent month. */
  currentMonth: boolean;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

// `Date.UTC(year, month, 0)` lands on day 0 of 0-based month index `month`,
// i.e. the last day of the *previous* 0-based month — which, since `month`
// here is 1-based, is exactly the last day of month `month`. Using `Date`
// only for this arithmetic (never `new Date()` with no arguments, which
// would read the clock) keeps leap years and month-length quirks correct
// without hand-rolling a Gregorian table.
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse a `'YYYY-MM'` month string into numeric parts. Malformed input falls back to `1970-01`. */
export function parseIsoMonth(month: string): { year: number; month: number } {
  const [y, m] = month.split('-').map(Number);
  const year = Number.isFinite(y) ? y! : 1970;
  const monthNum = Number.isFinite(m) && m! >= 1 && m! <= 12 ? m! : 1;
  return { year, month: monthNum };
}

/** Shift a `'YYYY-MM'` month string by `delta` months; negative moves backward across year boundaries. */
export function shiftMonth(month: string, delta: number): string {
  const { year, month: m } = parseIsoMonth(month);
  const total = year * 12 + (m - 1) + Math.trunc(delta);
  const nextYear = Math.floor(total / 12);
  const nextMonth = ((total % 12) + 12) % 12;
  return `${String(nextYear).padStart(4, '0')}-${pad2(nextMonth + 1)}`;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Human-readable month label: `monthLabel(2024, 6) === 'June 2024'`. */
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[Math.max(0, Math.min(11, month - 1))]} ${year}`;
}

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Two-letter weekday headers starting from `weekStartsOn` (default Sunday). */
export function weekdayLabels(weekStartsOn: 0 | 1 = 0): string[] {
  return [...WEEKDAY_LABELS.slice(weekStartsOn), ...WEEKDAY_LABELS.slice(0, weekStartsOn)];
}

/**
 * Build the week rows a `Calendar` paints for `year`/`month` (1-12): complete
 * weeks of `MonthDayCell`s, with leading/trailing days borrowed from the
 * adjacent months to pad the first and last rows (`currentMonth: false` on
 * those). Pure and clock-free — every input is explicit, so leap years and
 * month-length boundaries are exercised directly by tests instead of waiting
 * for the calendar to land on them.
 *
 * ```ts no_run
 * monthGrid(2024, 2)[0]; // February 2024 (leap year) starts on a Thursday
 * // → [{ date: '2024-01-28', day: 28, currentMonth: false }, …, { date: '2024-02-01', day: 1, currentMonth: true }, …]
 * ```
 */
export function monthGrid(year: number, month: number, weekStartsOn: 0 | 1 = 0): MonthDayCell[][] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const leading = (firstWeekday - weekStartsOn + 7) % 7;
  const thisMonthDays = daysInMonth(year, month);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonthDays = daysInMonth(prevYear, prevMonth);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  const cells: MonthDayCell[] = [];
  for (let i = 0; i < leading; i++) {
    const day = prevMonthDays - leading + 1 + i;
    cells.push({ date: isoDate(prevYear, prevMonth, day), day, currentMonth: false });
  }
  for (let day = 1; day <= thisMonthDays; day++) {
    cells.push({ date: isoDate(year, month, day), day, currentMonth: true });
  }
  let trailingDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({
      date: isoDate(nextYear, nextMonth, trailingDay),
      day: trailingDay,
      currentMonth: false,
    });
    trailingDay++;
  }

  const weeks: MonthDayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function calStepButton(handler: (() => void) | undefined, label: string, aria: string): VNode {
  const attrs: Props = { className: 'ui-cal-step', 'aria-label': aria };
  if (actionsActive() && handler !== undefined) {
    attrs.name = 'do';
    attrs.value = register(handler);
    return actionForm({}, h('button', attrs, label));
  }
  attrs.type = 'button';
  if (handler === undefined) attrs.disabled = true;
  return h('button', attrs, label);
}

/** Props accepted by `Calendar`. */
export interface CalendarProps extends FlexChildProps, Props {
  /** Displayed month, `'YYYY-MM'`. */
  month: string;
  /** Selected date, `'YYYY-MM-DD'`. */
  selected?: string;
  /** Today's date, `'YYYY-MM-DD'` — supplied by the caller; the component never reads a clock. */
  today?: string;
  weekStartsOn?: 0 | 1;
  onSelect?: (date: string) => void;
  onMonthChange?: (month: string) => void;
  id?: string;
}
/**
 * Month grid of selectable days, with prev/next month controls. Every date
 * the component needs — the displayed month, the selection, and "today" —
 * arrives as an ISO string from the caller; `monthGrid` does the date math.
 */
export function Calendar(all: CalendarProps): VNode {
  const { children = [], ...props } = all as CalendarProps & { children?: NormalizedChild[] };
  const { month, selected, today, weekStartsOn, onSelect, onMonthChange, id } =
    props;
  const select = handlerOf<(date: string) => void>(onSelect);
  const monthChange = handlerOf<(month: string) => void>(onMonthChange);
  const { year, month: m } = parseIsoMonth(month);
  const weeks = monthGrid(year, m, weekStartsOn ?? 0);
  const labels = weekdayLabels(weekStartsOn ?? 0);

  const nav = h(
    'div',
    { className: 'ui-cal-nav' },
    calStepButton(
      monthChange !== undefined ? () => monthChange(shiftMonth(month, -1)) : undefined,
      '‹',
      'Previous month',
    ),
    h('span', { className: 'ui-cal-title' }, monthLabel(year, m)),
    calStepButton(
      monthChange !== undefined ? () => monthChange(shiftMonth(month, 1)) : undefined,
      '›',
      'Next month',
    ),
  );

  const headerRow = h('tr', null, ...labels.map((label) => h('th', { scope: 'col' }, label)));
  const bodyRows = weeks.map((week) =>
    h(
      'tr',
      null,
      ...week.map((cell) => {
        const isSelected = cell.date === selected;
        const isToday = cell.date === today;
        const btnAttrs: Props = {
          className:
            'ui-cal-day' +
            (cell.currentMonth ? '' : ' is-outside') +
            (isSelected ? ' is-selected' : '') +
            (isToday ? ' is-today' : ''),
        };
        if (isSelected) btnAttrs['aria-selected'] = 'true';
        if (isToday) btnAttrs['aria-current'] = 'date';
        let dayButton: VNode;
        if (actionsActive() && select !== undefined) {
          btnAttrs.name = 'do';
          btnAttrs.value = register(() => select(cell.date));
          dayButton = actionForm({}, h('button', btnAttrs, String(cell.day)));
        } else {
          btnAttrs.type = 'button';
          if (select === undefined) btnAttrs.disabled = true;
          dayButton = h('button', btnAttrs, String(cell.day));
        }
        return h('td', { className: 'ui-cal-cell', role: 'gridcell' }, dayButton);
      }),
    ),
  );
  const table = h(
    'table',
    { className: 'ui-calendar', role: 'grid', 'aria-label': monthLabel(year, m), ...idAttr(id) },
    h('thead', null, headerRow),
    h('tbody', null, ...bodyRows),
  );
  return h('div', { className: 'ui-calendar-wrap' }, nav, table);
}

/** Props accepted by `DigitalClock`. */
export interface DigitalClockProps extends StyleProps, FlexChildProps, Props {
  /** `'HH:MM'` or `'HH:MM:SS'`, 24h. */
  time: string;
  /** Show the seconds field; default false. Independent of how much precision `time` carries. */
  seconds?: boolean;
  label?: string;
  id?: string;
}
/**
 * Prominent readout of a supplied time. The caller owns the clock: pass a
 * fixed value for a static display, or re-render with a fresh `time` on
 * whatever cadence the app chooses for a live one — there is no self-driven
 * tick inside the component (contrast `Spinner`, which is presentational
 * enough to animate on a frame counter it is handed; a clock is not).
 */
export function DigitalClock(all: DigitalClockProps): VNode {
  const { children = [], ...props } = all as DigitalClockProps & { children?: NormalizedChild[] };
  const { time, seconds, label, id } = props;
  const shown = formatClockTime(time, seconds === true);
  return h(
    'div',
    { className: 'ui-clock', ...idAttr(id) },
    h('time', { className: 'ui-clock-time', datetime: shown }, shown),
    label !== undefined ? h('span', { className: 'ui-clock-label' }, label) : null,
  );
}

/** Normalize a time string to `'HH:MM'` or, with `seconds`, `'HH:MM:SS'`. */
export function formatClockTime(time: string, seconds = false): string {
  const [h, m, s] = time.split(':');
  const hh = (h ?? '00').padStart(2, '0');
  const mm = (m ?? '00').padStart(2, '0');
  const ss = (s ?? '00').padStart(2, '0');
  return seconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

/** Props accepted by `DatePicker`. */
export interface DatePickerProps extends Props {
  /** Selected date, `'YYYY-MM-DD'`. */
  value?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (date: string) => void;
  /** Month the popover calendar shows, `'YYYY-MM'`; defaults to `value`'s month, then `'1970-01'`. */
  month?: string;
  onMonthChange?: (month: string) => void;
  /** Today's date, forwarded to the popover `Calendar`. */
  today?: string;
  weekStartsOn?: 0 | 1;
  focused?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Required for anchoring the popover to the trigger, same as `Select`. */
  id: string;
}
/**
 * Date picker: a trigger showing `value` (or `placeholder`) plus a `Calendar`
 * in an anchored `Layer`, mirroring how `Select` composes its popover. The
 * web target renders only a native `<input type="date">` — see the module
 * guide for why the popover calendar is terminal-only.
 */
export function DatePicker(all: DatePickerProps): VNode {
  const { children = [], ...props } = all as DatePickerProps & { children?: NormalizedChild[] };
  const { value, onChange, disabled, placeholder, id } = props;
  const change = handlerOf<(date: string) => void>(onChange);
  const attrs: Props = { className: 'ui-field', type: 'date', ...idAttr(id) };
  if (value !== undefined) attrs.value = value;
  if (placeholder !== undefined) attrs.placeholder = placeholder;
  if (actionsActive() && change !== undefined && disabled !== true) {
    const act = register((next) => {
      if (typeof next === 'string' && next.length > 0) change(next);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('input', attrs));
  }
  if (change === undefined || disabled === true) attrs.disabled = true;
  return h('input', attrs);
}

/** Numeric hour/minute/second parts of a clock-time string. */
export interface ClockParts {
  hours: number;
  minutes: number;
  seconds: number;
}
/** Parse `'HH:MM'`/`'HH:MM:SS'` into clamped numeric parts. Undefined or malformed input is midnight. */
export function parseClockTime(time: string | undefined): ClockParts {
  if (time === undefined) return { hours: 0, minutes: 0, seconds: 0 };
  const [h, m, s] = time.split(':').map(Number);
  const clamp = (value: number | undefined, max: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value!))) : 0;
  return { hours: clamp(h, 23), minutes: clamp(m, 59), seconds: clamp(s, 59) };
}
/** Format numeric clock parts back to `'HH:MM'` or, with `seconds` given, `'HH:MM:SS'`. */
export function formatTimeParts(hours: number, minutes: number, seconds?: number): string {
  const base = `${pad2(hours)}:${pad2(minutes)}`;
  return seconds !== undefined ? `${base}:${pad2(seconds)}` : base;
}

/**
 * A `size`-wide window of values from a `max`-valued modular ring (0..max-1),
 * centered on `current`. Paints a scrollable-looking column of a few
 * neighboring hours/minutes/seconds without holding any scroll state — the
 * window is recomputed from the current value on every render, the same
 * "state lives outside the tree" rule the rest of the catalog follows.
 *
 * ```ts no_run
 * timeColumnWindow(0, 24, 5); // [22, 23, 0, 1, 2] — wraps around midnight
 * ```
 */
export function timeColumnWindow(current: number, max: number, size = 5): number[] {
  const half = Math.floor(size / 2);
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    out.push((((current - half + i) % max) + max) % max);
  }
  return out;
}

/** Props accepted by `TimePicker`. */
export interface TimePickerProps extends Props {
  /** Selected time, `'HH:MM'` or `'HH:MM:SS'`. */
  value?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (time: string) => void;
  /** Minute increment for the minute column/arrow-key stepping; default 1. */
  step?: number;
  seconds?: boolean;
  focused?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Required for anchoring the popover to the trigger, same as `Select`. */
  id: string;
}
/**
 * Time picker: a trigger plus an anchored popover of hour/minute(/second)
 * columns, mirroring `Select`/`DatePicker`. The web target renders only a
 * native `<input type="time" step>`.
 */
export function TimePicker(all: TimePickerProps): VNode {
  const { children = [], ...props } = all as TimePickerProps & { children?: NormalizedChild[] };
  const { value, onChange, step, seconds, disabled, placeholder, id } =
    props;
  const change = handlerOf<(time: string) => void>(onChange);
  const attrs: Props = { className: 'ui-field', type: 'time', ...idAttr(id) };
  if (value !== undefined) attrs.value = value;
  if (placeholder !== undefined) attrs.placeholder = placeholder;
  if (seconds === true) attrs.step = '1';
  else if (step !== undefined) attrs.step = String(Math.max(1, Math.floor(step)) * 60);
  if (actionsActive() && change !== undefined && disabled !== true) {
    const act = register((next) => {
      if (typeof next === 'string' && next.length > 0) change(next);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('input', attrs));
  }
  if (change === undefined || disabled === true) attrs.disabled = true;
  return h('input', attrs);
}

/** Parse `'#rrggbb'` (with or without the leading `#`) into 0-255 RGB parts, or `null` if malformed. */
export function parseHexColor(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (match === null) return null;
  const value = match[1]!;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** Props accepted by `ColorPicker`. */
export interface ColorPickerProps extends Props {
  /** `'#rrggbb'`. */
  value: string;
  onChange: (value: string) => void;
  swatches?: string[];
  /** Popover mode when given alongside `onOpenChange` and `id`; otherwise the swatch grid renders inline. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
}
/**
 * Color picker: a swatch preview and hex readout, with an optional
 * `swatches` palette to pick from — inline by default, or behind a
 * trigger/popover (like `Select`) when `open`/`onOpenChange`/`id` are all
 * given. The terminal paints swatches with real RGB when the terminal
 * reports truecolor support, falling back to the nearest of the 256-color
 * palette otherwise (`fino:tty/style`'s `supportsTruecolor`/`nearestAnsi256`)
 * — detected in the lowering, never inside this component. The web target
 * renders a native `<input type="color">` alongside the swatch row.
 */
export function ColorPicker(all: ColorPickerProps): VNode {
  const { children = [], ...props } = all as ColorPickerProps & { children?: NormalizedChild[] };
  const { value, onChange, swatches, id } = props;
  const change = handlerOf<(value: string) => void>(onChange);
  const attrs: Props = { className: 'ui-color-input', type: 'color' };
  if (typeof value === 'string') attrs.value = value;
  let picker: VNode;
  if (actionsActive() && change !== undefined) {
    const act = register((next) => {
      if (typeof next === 'string' && next.length > 0) change(next);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    picker = actionForm({ act, change: true }, h('input', attrs));
  } else {
    if (change === undefined) attrs.disabled = true;
    picker = h('input', attrs);
  }
  const swatchRow =
    swatches !== undefined && swatches.length > 0
      ? h(
          'div',
          { className: 'ui-color-swatches' },
          ...swatches.map((hex) => {
            const selected =
              hex.toLowerCase() === (typeof value === 'string' ? value.toLowerCase() : '');
            const btnAttrs: Props = {
              className: `ui-color-swatch${selected ? ' is-selected' : ''}`,
              style: { background: hex },
              'aria-label': hex,
            };
            if (actionsActive() && change !== undefined) {
              btnAttrs.name = 'do';
              btnAttrs.value = register(() => change(hex));
              return actionForm({}, h('button', btnAttrs));
            }
            btnAttrs.type = 'button';
            if (change === undefined) btnAttrs.disabled = true;
            return h('button', btnAttrs);
          }),
        )
      : null;
  return h('div', { className: 'ui-color-picker', ...idAttr(id) }, picker, swatchRow);
}
