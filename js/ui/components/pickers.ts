/**
 * Clock-free date, time, and color picker contracts plus shared pure math.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';

/** One day cell in a complete calendar week. */
export interface MonthDayCell {
  date: string;
  day: number;
  currentMonth: boolean;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function weekday(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCDay();
}

/** Parse `YYYY-MM`, falling back to January 1970 for malformed input. */
export function parseIsoMonth(value: string): { year: number; month: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return match === null
    ? { year: 1970, month: 1 }
    : { year: Number(match[1]), month: Number(match[2]) };
}

/** Shift a valid or fallback ISO month across year boundaries. */
export function shiftMonth(value: string, delta: number): string {
  const { year, month } = parseIsoMonth(value);
  const total = year * 12 + month - 1 + Math.trunc(Number.isFinite(delta) ? delta : 0);
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

/** Human-readable label for a numeric year and 1-based month. */
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[Math.max(0, Math.min(11, Math.floor(month) - 1))]} ${year}`;
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Two-letter weekday labels beginning Sunday or Monday. */
export function weekdayLabels(weekStartsOn: 0 | 1 = 0): string[] {
  return [...WEEKDAYS.slice(weekStartsOn), ...WEEKDAYS.slice(0, weekStartsOn)];
}

/** Build complete weeks for a month, including adjacent-month padding cells. */
export function monthGrid(year: number, month: number, weekStartsOn: 0 | 1 = 0): MonthDayCell[][] {
  const safeMonth = Math.max(1, Math.min(12, Math.floor(month)));
  const leading = (weekday(year, safeMonth, 1) - weekStartsOn + 7) % 7;
  const previousMonth = safeMonth === 1 ? 12 : safeMonth - 1;
  const previousYear = safeMonth === 1 ? year - 1 : year;
  const nextMonth = safeMonth === 12 ? 1 : safeMonth + 1;
  const nextYear = safeMonth === 12 ? year + 1 : year;
  const cells: MonthDayCell[] = [];
  const previousDays = daysInMonth(previousYear, previousMonth);
  for (let index = 0; index < leading; index++) {
    const day = previousDays - leading + index + 1;
    cells.push({ date: isoDate(previousYear, previousMonth, day), day, currentMonth: false });
  }
  for (let day = 1; day <= daysInMonth(year, safeMonth); day++) {
    cells.push({ date: isoDate(year, safeMonth, day), day, currentMonth: true });
  }
  for (let day = 1; cells.length % 7 !== 0; day++) {
    cells.push({ date: isoDate(nextYear, nextMonth, day), day, currentMonth: false });
  }
  return Array.from({ length: cells.length / 7 }, (_, index) =>
    cells.slice(index * 7, index * 7 + 7),
  );
}

/** Whether a string is a real Gregorian `YYYY-MM-DD` date. */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (match === null) return false;
  return Number(match[3]) <= daysInMonth(Number(match[1]), Number(match[2]));
}

/** Props accepted by {@link Calendar}. */
export interface CalendarProps extends StyleProps, FlexChildProps, Props {
  month: string;
  selected?: string;
  today?: string;
  weekStartsOn?: 0 | 1;
  onSelect?: (date: string) => void;
  onMonthChange?: (month: string) => void;
}

/** Controlled month grid with explicit selection and navigation callbacks. */
export function Calendar(props: CalendarProps): VNode {
  return h('ui:calendar', props);
}

/** Props accepted by {@link DigitalClock}. */
export interface DigitalClockProps extends StyleProps, FlexChildProps, Props {
  time: string;
  seconds?: boolean;
  label?: string;
}

/** Prominent readout of caller-owned clock time. */
export function DigitalClock(props: DigitalClockProps): VNode {
  return h('ui:digital-clock', props);
}

/** Numeric parts parsed from a clock-time string. */
export interface ClockParts {
  hours: number;
  minutes: number;
  seconds: number;
}

/** Parse and clamp `HH:MM` or `HH:MM:SS`; malformed fields become zero. */
export function parseClockTime(value: string | undefined): ClockParts {
  const parts = value?.split(':').map(Number) ?? [];
  const clamp = (entry: number | undefined, max: number): number =>
    Number.isFinite(entry) ? Math.max(0, Math.min(max, Math.floor(entry!))) : 0;
  return { hours: clamp(parts[0], 23), minutes: clamp(parts[1], 59), seconds: clamp(parts[2], 59) };
}

/** Format numeric parts as `HH:MM` or `HH:MM:SS`. */
export function formatTimeParts(hours: number, minutes: number, seconds?: number): string {
  const parsed = parseClockTime(`${hours}:${minutes}:${seconds ?? 0}`);
  const base = `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`;
  return seconds === undefined ? base : `${base}:${pad2(parsed.seconds)}`;
}

/** Normalize an input time to the selected precision. */
export function formatClockTime(value: string, seconds = false): string {
  const parsed = parseClockTime(value);
  return formatTimeParts(parsed.hours, parsed.minutes, seconds ? parsed.seconds : undefined);
}

/** Whether a string is a valid 24-hour `HH:MM` or `HH:MM:SS` time. */
export function isClockTime(value: string, seconds?: boolean): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59) return false;
  if (match[3] !== undefined && Number(match[3]) > 59) return false;
  return seconds === true
    ? match[3] !== undefined
    : seconds === false
      ? match[3] === undefined
      : true;
}

/** Normalize the minute increment shared by native and terminal time controls. @internal */
export function normalizeTimeStep(step: number | undefined): number {
  return Math.max(1, Math.floor(step !== undefined && Number.isFinite(step) ? step : 1));
}

/** Build a centered modular window used by terminal time columns. */
export function timeColumnWindow(current: number, max: number, size = 5): number[] {
  const modulus = Math.max(1, Math.floor(max));
  const count = Math.max(1, Math.floor(size));
  const center = Math.floor(current);
  const half = Math.floor(count / 2);
  return Array.from(
    { length: count },
    (_, index) => (((center - half + index) % modulus) + modulus) % modulus,
  );
}

/** Props accepted by {@link DatePicker}. */
export interface DatePickerProps extends StyleProps, FlexChildProps, Props {
  value?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (date: string) => void;
  month?: string;
  onMonthChange?: (month: string) => void;
  today?: string;
  weekStartsOn?: 0 | 1;
  focused?: boolean;
  disabled?: boolean;
  placeholder?: string;
  id: string;
}

/** Native browser date input and terminal calendar popover contract. */
export function DatePicker(props: DatePickerProps): VNode {
  return h('ui:date-picker', props);
}

/** Props accepted by {@link TimePicker}. */
export interface TimePickerProps extends StyleProps, FlexChildProps, Props {
  value?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (time: string) => void;
  step?: number;
  seconds?: boolean;
  focused?: boolean;
  disabled?: boolean;
  placeholder?: string;
  id: string;
}

/** Native browser time input and terminal column popover contract. */
export function TimePicker(props: TimePickerProps): VNode {
  return h('ui:time-picker', props);
}

/** Parse a six-digit hex color with an optional leading hash. */
export function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) return null;
  return [0, 2, 4].map((start) => Number.parseInt(match[1]!.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** Return a canonical lowercase color or null for malformed input. */
export function normalizeHexColor(value: string): string | null {
  const rgb = parseHexColor(value);
  return rgb === null ? null : `#${rgb.map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

/** Canonicalize, reject, and deduplicate a color swatch list. @internal */
export function normalizeColorSwatches(values: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const hex = normalizeHexColor(value);
    if (hex !== null) normalized.add(hex);
  }
  return [...normalized];
}

/** Props accepted by {@link ColorPicker}. */
export interface ColorPickerProps extends StyleProps, FlexChildProps, Props {
  value: string;
  onChange: (value: string) => void;
  swatches?: readonly string[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
}

/** Native browser color input and terminal swatch-grid contract. */
export function ColorPicker(props: ColorPickerProps): VNode {
  return h('ui:color-picker', props);
}
