/**
* internal/jobs/cron — cron expression parsing and next-occurrence math.
*
* Supports the classic 5-field form (`minute hour day-of-month month
* day-of-week`) with `*`, numerals, ranges (`a-b`), step suffixes (`/n` on
* `*` or a range), and comma lists; the aliases `@hourly`, `@daily`,
* `@weekly`, `@monthly`, and `@yearly`; and the interval sugar
* `every:<duration>` where duration is `<n><ms|s|m|h|d>`.
*
* All evaluation is in UTC: schedules are stored as epoch milliseconds, which
* keeps `next_run_at` portable across hosts and avoids DST skip/double-fire
* holes. `@daily` means midnight UTC. Month/day names, a seconds field, and
* Quartz extensions (`L`, `W`, `#`) are rejected with clear errors.
*
* When both day-of-month and day-of-week are restricted, a day matches when
* EITHER field matches (the traditional vixie-cron OR rule).
*
* @internal
*/

/**
* Parsed cron specification: sorted allowed values per field.
*
* @internal
*/
export interface CronSpec {
  kind: 'cron';
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}
/**
* Parsed `every:<duration>` interval specification.
*
* @internal
*/
export interface IntervalSpec {
  kind: 'every';
  intervalMs: number;
}
/**
* Any parsed schedule specification.
*
* @internal
*/
export type ScheduleSpec = CronSpec | IntervalSpec;

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
};

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const DURATION_SCALE: Record<string, number> = {
  ms: 1,
  s: 1e3,
  m: 6e4,
  h: 36e5,
  d: 864e5
};

interface FieldRange {
  name: string;
  min: number;
  max: number;
}
const FIELDS: FieldRange[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 }
];

function parseField(text: string, range: FieldRange): {
  values: number[];
  restricted: boolean;
} {
  const allowed = new Set<number>();
  let restricted = false;
  for (const part of text.split(',')) {
    if (part.length === 0) {
      throw new Error(`cron ${range.name} field has an empty list entry`);
    }
    let body = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      body = part.slice(0, slash);
      const stepText = part.slice(slash + 1);
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new Error(`cron ${range.name} step "/${stepText}" must be a positive integer`);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (body === '*') {
      lo = range.min;
      hi = range.max;
      if (slash !== -1) restricted = true;
    } else {
      restricted = true;
      const dash = body.indexOf('-');
      if (dash !== -1) {
        const loText = body.slice(0, dash);
        const hiText = body.slice(dash + 1);
        if (!/^\d+$/.test(loText) || !/^\d+$/.test(hiText)) {
          throw new Error(`cron ${range.name} range "${body}" must be numeric (names and L/W/# are not supported)`);
        }
        lo = Number(loText);
        hi = Number(hiText);
        if (lo > hi) {
          throw new Error(`cron ${range.name} range "${body}" is inverted`);
        }
      } else {
        if (!/^\d+$/.test(body)) {
          throw new Error(`cron ${range.name} value "${body}" must be numeric (names and L/W/# are not supported)`);
        }
        lo = Number(body);
        hi = lo;
      }
      if (lo < range.min || hi > range.max) {
        throw new Error(`cron ${range.name} value "${body}" is out of range ${range.min}-${range.max}`);
      }
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return {
    values: [...allowed].sort((a, b) => a - b),
    restricted
  };
}

/**
* Parse a schedule specification: 5-field cron, an `@alias`, or
* `every:<duration>`.
*
* ```ts no_run
* import { parseCron } from 'internal:jobs/cron';
* const spec = parseCron('30 2 * * 1-5');
* console.log(spec.kind);
* ```
*
* @throws On malformed expressions, out-of-range values, or unsupported
* syntax (names, seconds field, L/W/#).
*
* @internal
*/
export function parseCron(spec: string): ScheduleSpec {
  const text = spec.trim();
  if (text.length === 0) throw new Error('cron expression is empty');
  if (text.startsWith('every:')) {
    const duration = text.slice('every:'.length).trim();
    const match = DURATION_RE.exec(duration);
    if (match === null) {
      throw new Error(`every: duration "${duration}" must match <n><ms|s|m|h|d>`);
    }
    const intervalMs = Number(match[1]) * DURATION_SCALE[match[2]!]!;
    if (!(intervalMs > 0)) {
      throw new Error(`every: interval must be positive, got "${duration}"`);
    }
    return {
      kind: 'every',
      intervalMs
    };
  }
  const expanded = text.startsWith('@') ? ALIASES[text] : text;
  if (expanded === undefined) {
    throw new Error(`unknown cron alias "${text}" (supported: ${Object.keys(ALIASES).join(', ')})`);
  }
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (minute hour dom month dow), got ${fields.length}`);
  }
  const minute = parseField(fields[0]!, FIELDS[0]!);
  const hour = parseField(fields[1]!, FIELDS[1]!);
  const dom = parseField(fields[2]!, FIELDS[2]!);
  const month = parseField(fields[3]!, FIELDS[3]!);
  const dow = parseField(fields[4]!, FIELDS[4]!);
  // Cron allows both 0 and 7 for Sunday; normalize 7 → 0.
  const dowValues = [...new Set(dow.values.map((v) => v === 7 ? 0 : v))].sort((a, b) => a - b);
  return {
    kind: 'cron',
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dowValues,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted
  };
}

function nextAllowed(values: number[], from: number): number | null {
  for (const v of values) {
    if (v >= from) return v;
  }
  return null;
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  const domOk = spec.daysOfMonth.includes(date.getUTCDate());
  const dowOk = spec.daysOfWeek.includes(date.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

const FIVE_YEARS_MS = 5 * 366 * 864e5;

/**
* Next occurrence of `spec` strictly after `afterMs`, as epoch milliseconds.
*
* Cron evaluation walks fields UTC month → day → hour → minute without
* scanning minute-by-minute; `every:` intervals align to whole multiples of
* the interval since `anchorMs` (default 0 — the epoch).
*
* ```ts no_run
* import { parseCron, nextOccurrence } from 'internal:jobs/cron';
* const at = nextOccurrence(parseCron('@daily'), Date.now());
* console.log(new Date(at).toISOString());
* ```
*
* @throws When no occurrence exists within five years (unsatisfiable
* expressions like Feb 30).
*
* @internal
*/
export function nextOccurrence(spec: ScheduleSpec, afterMs: number, anchorMs = 0): number {
  if (spec.kind === 'every') {
    const elapsed = afterMs - anchorMs;
    const periods = Math.floor(elapsed / spec.intervalMs) + 1;
    return anchorMs + periods * spec.intervalMs;
  }
  // Start at the next whole minute after `afterMs`.
  let t = new Date(Math.floor(afterMs / 6e4) * 6e4 + 6e4);
  const bail = afterMs + FIVE_YEARS_MS;
  while (t.getTime() <= bail) {
    if (!spec.months.includes(t.getUTCMonth() + 1)) {
      const nextMonth = nextAllowed(spec.months, t.getUTCMonth() + 2);
      t = nextMonth === null ? new Date(Date.UTC(t.getUTCFullYear() + 1, spec.months[0]! - 1, 1)) : new Date(Date.UTC(t.getUTCFullYear(), nextMonth - 1, 1));
      continue;
    }
    if (!dayMatches(spec, t)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
      continue;
    }
    const hour = nextAllowed(spec.hours, t.getUTCHours());
    if (hour === null) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
      continue;
    }
    if (hour !== t.getUTCHours()) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), hour));
    }
    const minute = nextAllowed(spec.minutes, t.getUTCMinutes());
    if (minute === null) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours() + 1));
      continue;
    }
    if (minute !== t.getUTCMinutes()) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), minute));
      // Hour rollover from minute advance cannot happen: nextAllowed(minutes)
      // returned a value >= current minute within the same hour.
    }
    return t.getTime();
  }
  throw new Error('cron expression has no occurrence within five years');
}
