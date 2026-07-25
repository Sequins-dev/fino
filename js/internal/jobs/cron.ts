/**
* internal:jobs/cron — cron expression parsing and next-occurrence math.
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
* EITHER field matches (the traditional vixie-cron OR rule). When only one of
* the two is restricted, only that field constrains the day; when neither is,
* every day matches.
*
* The two-step design separates the pure parse from the schedule math: call
* `parseCron` once to validate an expression and cache the resulting
* `ScheduleSpec`, then call `nextOccurrence` repeatedly to advance a firing
* clock without re-parsing. This is the parsing core behind the `internal:jobs`
* scheduler; most callers reach it through the higher-level job store and
* runner rather than importing it directly.
*
* ```ts no_run
*   import { parseCron, nextOccurrence } from 'internal:jobs/cron';
*
*   // Weekdays at 02:30 UTC.
*   const spec = parseCron('30 2 * * 1-5');
*   let clock = Date.now();
*   for (let i = 0; i < 3; i++) {
*     clock = nextOccurrence(spec, clock);
*     console.log(new Date(clock).toISOString());
*   }
* ```
*
* Vixie cron reference: https://man7.org/linux/man-pages/man5/crontab.5.html
*
* @internal
*/
/**
* Parsed cron specification: the sorted, deduplicated set of allowed values for
* each of the five fields, plus flags recording whether day-of-month and
* day-of-week were narrowed from `*`.
*
* Produced by `parseCron` when the expression is a 5-field form or an `@alias`.
* The value arrays are the fully expanded matches (ranges, steps, and comma
* lists resolved), so `nextOccurrence` can advance a clock by lookup rather
* than by re-interpreting syntax. All values are UTC field numbers: minute
* 0–59, hour 0–23, day-of-month 1–31, month 1–12, day-of-week 0–6 (Sunday is
* normalized to 0, so a `7` in the source becomes `0`).
*
* ```ts no_run
*   import { parseCron, type CronSpec } from 'internal:jobs/cron';
*
*   const spec = parseCron('0,15,30,45 2-4 1,15 * 1-5') as CronSpec;
*   console.log(spec.minutes);      // [0, 15, 30, 45]
*   console.log(spec.hours);        // [2, 3, 4]
*   console.log(spec.daysOfMonth);  // [1, 15]
*   console.log(spec.daysOfWeek);   // [1, 2, 3, 4, 5]
*   console.log(spec.domRestricted, spec.dowRestricted); // true true
* ```
*
* @internal
*/
export interface CronSpec {
  /** Discriminant marking this as a cron schedule rather than an interval. */
  kind: 'cron';
  /** Allowed minutes of the hour, sorted ascending (0–59). */
  minutes: number[];
  /** Allowed hours of the day, sorted ascending (0–23). */
  hours: number[];
  /** Allowed days of the month, sorted ascending (1–31). */
  daysOfMonth: number[];
  /** Allowed months, sorted ascending (1–12). */
  months: number[];
  /** Allowed days of the week, sorted ascending (0–6, Sunday is 0). */
  daysOfWeek: number[];
  /** True when the day-of-month field was narrowed from `*` to specific values, which activates it in the vixie OR rule. */
  domRestricted: boolean;
  /** True when the day-of-week field was narrowed from `*` to specific values, which activates it in the vixie OR rule. */
  dowRestricted: boolean;
}
/**
* Parsed `every:<duration>` interval specification.
*
* Produced by `parseCron` when the expression begins with `every:`. Unlike a
* `CronSpec`, an interval carries no calendar structure — it fires on whole
* multiples of `intervalMs` measured from an anchor (see `nextOccurrence`), so
* it is unaffected by month lengths, weekdays, or leap years.
*
* ```ts no_run
*   import { parseCron, type IntervalSpec } from 'internal:jobs/cron';
*
*   const spec = parseCron('every:90s') as IntervalSpec;
*   console.log(spec.kind);        // 'every'
*   console.log(spec.intervalMs);  // 90000
* ```
*
* @internal
*/
export interface IntervalSpec {
  /** Discriminant marking this as an interval schedule rather than a cron schedule. */
  kind: 'every';
  /** Interval length in milliseconds; always positive. */
  intervalMs: number;
}
/**
* Any parsed schedule specification — either a calendar `CronSpec` or an
* `every:` `IntervalSpec`.
*
* This is the return type of `parseCron` and the input to `nextOccurrence`.
* Discriminate on the `kind` field (`'cron'` versus `'every'`) to narrow it.
*
* ```ts no_run
*   import { parseCron, type ScheduleSpec } from 'internal:jobs/cron';
*
*   function describe(spec: ScheduleSpec): string {
*     return spec.kind === 'every'
*       ? `interval of ${spec.intervalMs}ms`
*       : `cron with ${spec.minutes.length} minute slots`;
*   }
*
*   console.log(describe(parseCron('every:5m'))); // interval of 300000ms
*   console.log(describe(parseCron('@hourly')));  // cron with 1 minute slots
* ```
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
  {
    name: 'minute',
    min: 0,
    max: 59
  },
  {
    name: 'hour',
    min: 0,
    max: 23
  },
  {
    name: 'day-of-month',
    min: 1,
    max: 31
  },
  {
    name: 'month',
    min: 1,
    max: 12
  },
  {
    name: 'day-of-week',
    min: 0,
    max: 7
  }
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
* Parse a schedule specification — a 5-field cron expression, an `@alias`, or
* `every:<duration>` — into a `ScheduleSpec`.
*
* The input is trimmed first. `every:<duration>` yields an `IntervalSpec` whose
* `intervalMs` is the duration scaled to milliseconds. An `@alias` is expanded
* to its 5-field equivalent and parsed like any other expression. Everything
* else must be exactly five whitespace-separated fields; each field is expanded
* into its full sorted set of allowed values, and a Sunday written as `7` in
* day-of-week is normalized to `0`.
*
* Parsing is intentionally strict so that scheduling errors surface at
* registration time rather than silently never firing. Throws if the
* expression is empty; if an `@alias` is unknown; if there are not exactly five
* fields; if a value or range is non-numeric (month and weekday names are not
* supported), out of its field range, or inverted (`5-1`); if a step is zero or
* non-numeric; or if an `every:` duration does not match `<n><ms|s|m|h|d>` or
* is not positive. Quartz extensions (`L`, `W`, `#`) and a seconds field are
* rejected by these same numeric/field-count checks.
*
* ```ts no_run
*   import { parseCron } from 'internal:jobs/cron';
*
*   parseCron('30 2 * * 1-5'); // weekdays at 02:30 UTC
*   parseCron('@daily');       // midnight UTC, expands to '0 0 * * *'
*   parseCron('every:15m');    // interval, fires every 15 minutes
*
*   try {
*     parseCron('0 0 * * MON'); // names are unsupported
*   } catch (err) {
*     console.log((err as Error).message); // ...must be numeric...
*   }
* ```
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
* The result is always strictly greater than `afterMs`: passing a timestamp
* that is itself an exact match returns the *following* firing, never the same
* instant, which makes the function safe to drive a firing clock forward in a
* loop without double-firing.
*
* Cron evaluation walks fields UTC month → day → hour → minute, jumping over
* non-matching months and days rather than scanning minute-by-minute, so even
* sparse schedules resolve in a handful of steps. The vixie day rule from
* `parseCron` applies: with both day fields restricted a day matches when
* either matches. For an `IntervalSpec`, the next firing is the smallest whole
* multiple of `intervalMs` past `afterMs` measured from `anchorMs` (default 0,
* the epoch); pass a job's creation time as `anchorMs` to phase-align intervals
* to when the job was registered.
*
* Cron search is bounded to five years. Throws if no occurrence exists in that
* window, which is how unsatisfiable calendar expressions such as `0 0 30 2 *`
* (February 30th) are reported rather than looping forever. Interval schedules
* never throw.
*
* ```ts no_run
*   import { parseCron, nextOccurrence } from 'internal:jobs/cron';
*
*   const daily = parseCron('@daily');
*   const first = nextOccurrence(daily, Date.now());
*   const second = nextOccurrence(daily, first); // strictly after `first`
*   console.log(new Date(first).toISOString(), new Date(second).toISOString());
*
*   // Interval phased to a job's creation time.
*   const spec = parseCron('every:90s');
*   console.log(nextOccurrence(spec, 100_000, 0)); // 180000
* ```
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
    }
    return t.getTime();
  }
  throw new Error('cron expression has no occurrence within five years');
}
