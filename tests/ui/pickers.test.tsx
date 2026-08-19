/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { createRenderer, createSignal } from 'fino:ui';
import type { VNode } from 'fino:ui';
import { Calendar, ColorPicker, DatePicker, DigitalClock, TimePicker } from 'fino:ui/components';
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
import { nearestAnsi256, supportsTruecolor } from 'fino:tty/style';
import { renderFrame } from 'fino:tty/tui';
import { renderToHtml } from 'fino:ui/html';
import { toHtml } from 'fino:ui/components/html';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';
import { layout } from 'internal:tty/layout';
import { lowerTui } from 'internal:tty/lower';
import { TuiDispatcher } from 'internal:tty/events';
import type { TuiMouseEventLike } from 'internal:tty/events';

function lines(tree: VNode, width: number, height: number): string[] {
  return renderFrame(tree, { width, height }).split('\n');
}

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

interface Live {
  dispatcher: TuiDispatcher;
  render(tree: VNode): void;
  text(): string[];
  raw(): string[];
}

function live(width = 40, height = 16): Live {
  const root = createTerminalRoot();
  const renderer = createRenderer(terminalHost());
  const dispatcher = new TuiDispatcher(root);
  let frame: string[] = [];
  return {
    dispatcher,
    render(tree: VNode): void {
      renderer.render(lowerTui(tree), root);
      const laid = layout(root.children[0]!, { width, height });
      frame = laid.rows.map((row) => row.segments.map((s) => s.text).join(''));
    },
    text(): string[] {
      return frame.map(strip);
    },
    raw(): string[] {
      return frame;
    },
  };
}

function click(app: Live, x: number, y: number): void {
  const at = (action: 'press' | 'release'): TuiMouseEventLike => ({
    type: 'mouse',
    action,
    button: 'left',
    x,
    y,
    ctrl: false,
    alt: false,
    shift: false,
  });
  app.dispatcher.dispatch(at('press'));
  app.dispatcher.dispatch(at('release'));
}

function key(app: Live, k: string, extra: Partial<TuiMouseEventLike> = {}): void {
  app.dispatcher.dispatch({
    type: 'key',
    key: k,
    ctrl: false,
    alt: false,
    shift: false,
    ...extra,
  } as never);
}

describe('fino:ui/components date/time math helpers', () => {
  it('builds a leap-year February with leading/trailing days from adjacent months', (t) => {
    const weeks = monthGrid(2024, 2, 0);
    t.equal(weeks.length, 5, 'Feb 2024 (starts Thursday, 29 days) spans 5 weeks');
    t.equal(weeks[0]![0]!.date, '2024-01-28', 'first cell borrows from January');
    t.equal(weeks[0]![0]!.currentMonth, false, 'borrowed leading day is marked as not current');
    t.equal(weeks[4]![4]!.date, '2024-02-29', 'the leap day exists');
    t.equal(weeks[4]![4]!.currentMonth, true, 'the leap day belongs to the current month');
    t.equal(weeks[4]![6]!.date, '2024-03-02', 'last cell borrows from March');
    for (const week of weeks) t.equal(week.length, 7, 'every week has 7 days');
  });

  it('builds a non-leap-year February with 28 days', (t) => {
    const weeks = monthGrid(2023, 2, 0);
    const currentMonthDays = weeks.flat().filter((cell) => cell.currentMonth);
    t.equal(currentMonthDays.length, 28, 'February 2023 has 28 days');
    t.equal(currentMonthDays[currentMonthDays.length - 1]!.date, '2023-02-28');
  });

  it('handles a month starting on the week boundary itself', (t) => {
    // June 1 2024 is a Saturday.
    const weeks = monthGrid(2024, 6, 0);
    t.equal(weeks[0]![6]!.date, '2024-06-01', 'the 1st lands on the last column, Sunday-start');
    t.equal(weeks[0]![6]!.currentMonth, true);
    t.equal(weeks[0]![0]!.currentMonth, false, 'the first six cells borrow from May');
  });

  it('shifts the grid a week earlier when weekStartsOn is Monday', (t) => {
    const sunday = monthGrid(2024, 6, 0);
    const monday = monthGrid(2024, 6, 1);
    t.equal(monday[0]![0]!.date, '2024-05-27', 'Monday-start grid begins on the preceding Monday');
    t.notEqual(sunday[0]![0]!.date, monday[0]![0]!.date, 'the two week-start conventions differ');
  });

  it('shifts months across year boundaries in both directions', (t) => {
    t.equal(shiftMonth('2024-01', -1), '2023-12', 'January backward crosses into the prior year');
    t.equal(shiftMonth('2024-12', 1), '2025-01', 'December forward crosses into the next year');
    t.equal(shiftMonth('2024-06', 0), '2024-06', 'a zero shift is a no-op');
    t.equal(shiftMonth('2024-06', 13), '2025-07', 'a multi-year shift lands on the right month');
  });

  it('parses YYYY-MM, falling back on malformed input', (t) => {
    t.deepEqual(parseIsoMonth('2024-06'), { year: 2024, month: 6 });
    t.deepEqual(parseIsoMonth('garbage'), { year: 1970, month: 1 }, 'malformed input is 1970-01');
  });

  it('labels months and weekday headers, rotating the header for weekStartsOn', (t) => {
    t.equal(monthLabel(2024, 6), 'June 2024');
    t.equal(monthLabel(2024, 1), 'January 2024');
    t.deepEqual(weekdayLabels(0), ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
    t.deepEqual(weekdayLabels(1), ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
  });

  it('formats and parses clock-time strings', (t) => {
    t.equal(formatClockTime('09:05:22'), '09:05', 'seconds dropped by default');
    t.equal(formatClockTime('09:05:22', true), '09:05:22', 'seconds kept when requested');
    t.equal(formatClockTime('9:5'), '09:05', 'short components are zero-padded');
    t.deepEqual(parseClockTime('09:05:22'), { hours: 9, minutes: 5, seconds: 22 });
    t.deepEqual(
      parseClockTime(undefined),
      { hours: 0, minutes: 0, seconds: 0 },
      'undefined is midnight',
    );
    t.deepEqual(
      parseClockTime('25:99'),
      { hours: 23, minutes: 59, seconds: 0 },
      'out-of-range parts clamp',
    );
    t.equal(formatTimeParts(9, 5, 22), '09:05:22');
    t.equal(formatTimeParts(9, 5), '09:05', 'seconds omitted when not given');
  });

  it('windows a modular ring of values centered on the current value', (t) => {
    t.deepEqual(timeColumnWindow(0, 24, 5), [22, 23, 0, 1, 2], 'wraps around midnight');
    t.deepEqual(timeColumnWindow(12, 24, 5), [10, 11, 12, 13, 14], 'no wrap needed mid-range');
    t.deepEqual(timeColumnWindow(59, 60, 3), [58, 59, 0], 'wraps at the top of the minute ring');
  });

  it('parses hex colors, rejecting malformed input', (t) => {
    t.deepEqual(parseHexColor('#ff0000'), [255, 0, 0]);
    t.deepEqual(parseHexColor('00ff00'), [0, 255, 0], 'the leading # is optional');
    t.equal(parseHexColor('nope'), null);
    t.equal(parseHexColor('#fff'), null, 'only 6-digit hex is accepted');
  });
});

describe('fino:tty/style truecolor helpers', () => {
  it('recognizes truecolor COLORTERM values only', (t) => {
    t.equal(supportsTruecolor('truecolor'), true);
    t.equal(supportsTruecolor('24bit'), true);
    t.equal(supportsTruecolor('256'), false);
    t.equal(supportsTruecolor(undefined), false);
  });

  it('maps RGB triples to the nearest xterm-256 index', (t) => {
    t.equal(nearestAnsi256(0, 0, 0), 16, 'pure black is the cube corner, not the gray ramp');
    t.equal(nearestAnsi256(255, 255, 255), 231, 'pure white is the cube corner');
    t.equal(nearestAnsi256(255, 0, 0), 196, 'pure red maps into the color cube');
    const grayIndex = nearestAnsi256(128, 128, 128);
    t.ok(grayIndex >= 232 && grayIndex <= 255, 'a neutral gray prefers the 24-step grayscale ramp');
  });
});

describe('fino:ui/components Calendar', () => {
  it('paints a bordered-free 7-column grid with weekday headers and dimmed adjacent-month days', (t) => {
    const frame = lines(<Calendar month="2024-06" today="2024-06-10" />, 30, 10);
    t.equal(
      strip(frame[0]!),
      '‹         June 2024          ›',
      'prev/next controls flank the month label',
    );
    t.equal(strip(frame[1]!), 'Su Mo Tu We Th Fr Sa', 'weekday header row');
    t.equal(
      strip(frame[2]!),
      '26 27 28 29 30 31  1',
      'leading May days share the first row with June 1',
    );
  });

  it('marks the selected day inverse+bold and today underlined', (t) => {
    const frame = lines(
      <Calendar month="2024-06" selected="2024-06-15" today="2024-06-10" />,
      40,
      10,
    ).join('\n');
    t.ok(frame.includes('\x1b[4m10\x1b[0m'), 'today (the 10th) is underlined and otherwise plain');
    t.ok(frame.includes('\x1b[1;7m15\x1b[0m'), 'the selected day (the 15th) is bold+inverse');
  });

  it('selects a day and navigates months through the terminal dispatcher', (t) => {
    const app = live(30, 10);
    const month = createSignal('2024-06');
    const selected = createSignal<string | null>(null);
    const view = (): VNode => (
      <Calendar
        id="cal"
        month={month.get()}
        selected={selected.get() ?? undefined}
        onSelect={(d) => selected.set(d)}
        onMonthChange={(m) => month.set(m)}
      />
    );
    app.render(view());
    // Row 4 is "9 10 11 12 13 14 15"; each 2-char cell + 1 gap is a 3-wide column.
    click(app, 18, 4);
    t.equal(selected.get(), '2024-06-15', 'clicking a day cell selects that date');
    app.render(view());
    click(app, 0, 0);
    t.equal(month.get(), '2024-05', 'the prev-month control steps the month back');
    app.render(view());
    click(app, 29, 0);
    t.equal(month.get(), '2024-06', 'the next-month control steps the month forward');
  });

  it('renders a role=grid table with th headers and day buttons on the action collector', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const selected: string[] = [];
    const html = renderToHtml(
      toHtml(
        <Calendar
          month="2024-06"
          selected="2024-06-15"
          today="2024-06-10"
          onSelect={(d) => selected.push(d)}
        />,
        { actions },
      ),
    );
    t.ok(html.includes('role="grid"'), 'the table carries role=grid');
    t.ok(html.includes('<th scope="col">Su</th>'), 'weekday headers are real <th>s');
    t.ok(html.includes('aria-selected="true"'), 'the selected day is marked aria-selected');
    t.ok(html.includes('aria-current="date"'), 'today is marked aria-current=date');
    const match = /aria-selected="true"[^>]*name="do" value="(a\d+)"/.exec(html);
    t.ok(match !== null, 'the selected day button rides the action collector');
    actions.get(match![1]!)!();
    t.deepEqual(selected, ['2024-06-15'], 'invoking the collected action fires onSelect');
  });

  it('lowers day buttons and month controls disabled without their handlers', (t) => {
    const html = renderToHtml(toHtml(<Calendar month="2024-06" />));
    t.ok(
      html.includes('class="ui-cal-day" type="button" disabled'),
      'handler-less day buttons are inert',
    );
    t.ok(html.includes('class="ui-cal-step" aria-label="Previous month" type="button" disabled'));
  });
});

describe('fino:ui/components DigitalClock', () => {
  it('renders a bold readout with an optional dim label in the terminal', (t) => {
    const frame = lines(<DigitalClock time="09:05:22" label="UTC" />, 20, 2);
    t.equal(strip(frame[0]!), '09:05', 'seconds omitted by default');
    t.equal(strip(frame[1]!), 'UTC', 'label renders beneath');
    t.ok(frame[0]!.includes('\x1b[1m'), 'the time is bold');
  });

  it('shows seconds when requested', (t) => {
    const frame = lines(<DigitalClock time="09:05:22" seconds />, 20, 1);
    t.equal(strip(frame[0]!), '09:05:22');
  });

  it('renders a native <time datetime> on the web', (t) => {
    const html = renderToHtml(toHtml(<DigitalClock time="09:05:22" seconds label="UTC" />));
    t.ok(html.includes('<time class="ui-clock-time" datetime="09:05:22">09:05:22</time>'));
    t.ok(html.includes('UTC'), 'label renders');
  });
});

describe('fino:ui/components DatePicker', () => {
  it('shows a placeholder or the value on the trigger, closed by default', (t) => {
    const placeholder = lines(
      <DatePicker id="dp" open={false} onOpenChange={() => {}} onChange={() => {}} />,
      30,
      2,
    );
    t.equal(strip(placeholder[0]!), 'Select date… ▾');
    const withValue = lines(
      <DatePicker
        id="dp"
        value="2024-06-15"
        open={false}
        onOpenChange={() => {}}
        onChange={() => {}}
      />,
      30,
      2,
    );
    t.equal(strip(withValue[0]!), '2024-06-15 ▾');
  });

  it('opens a popover Calendar and picks a date, closing the popover', (t) => {
    const app = live(40, 16);
    const open = createSignal(false);
    const value = createSignal<string | undefined>(undefined);
    const month = createSignal('2024-06');
    const view = (): VNode => (
      <DatePicker
        id="dp"
        value={value.get()}
        open={open.get()}
        onOpenChange={(o) => open.set(o)}
        onChange={(v) => value.set(v)}
        month={month.get()}
        onMonthChange={(m) => month.set(m)}
        today="2024-06-10"
      />
    );
    app.render(view());
    click(app, 0, 0);
    t.equal(open.get(), true, 'clicking the trigger opens the popover');
    app.render(view());
    const dayRow = app.text().findIndex((row) => row.includes('June 2024'));
    t.ok(dayRow >= 0, 'the popover calendar renders beneath the trigger');
    const fifteenRow = app.text().findIndex((row) => / 15$| 15 |^15 /.test(row));
    t.ok(fifteenRow > 0, 'the 15th renders somewhere in the grid');
    const x = app.text()[fifteenRow]!.indexOf('15');
    click(app, x, fifteenRow);
    t.equal(value.get(), '2024-06-15', 'picking a day commits the value');
    t.equal(open.get(), false, 'picking a day closes the popover');
  });

  it('dismisses on escape without changing the value', (t) => {
    // Keys route to the focused node (falling back to `captureKeys` nodes
    // only when *nothing* is focused), so the trigger needs focus — from the
    // same click that opened it — before it can see the escape key, exactly
    // like `Select`'s own escape handling.
    const app = live(40, 16);
    const open = createSignal(false);
    const view = (): VNode => (
      <DatePicker
        id="dp"
        open={open.get()}
        onOpenChange={(o) => open.set(o)}
        onChange={() => {}}
        month="2024-06"
      />
    );
    app.render(view());
    click(app, 0, 0);
    t.equal(open.get(), true, 'the trigger click opens the popover and focuses the trigger');
    app.render(view());
    key(app, 'escape');
    t.equal(open.get(), false, 'escape closes the popover');
  });

  it('renders only a native <input type="date"> on the web, no popover markup', (t) => {
    const html = renderToHtml(
      toHtml(
        <DatePicker
          id="dp"
          value="2024-06-15"
          open
          onOpenChange={() => {}}
          onChange={() => {}}
          month="2024-06"
        />,
      ),
    );
    t.ok(html.includes('type="date"'), 'native date input');
    t.ok(html.includes('value="2024-06-15"'), 'current value rides the value attribute');
    t.ok(
      !html.includes('role="grid"'),
      'no duplicate popover calendar on the web, even while open',
    );
  });

  it('honors the disabled prop on the native input', (t) => {
    const enabled = renderToHtml(
      toHtml(<DatePicker id="dp" open={false} onOpenChange={() => {}} onChange={() => {}} />),
    );
    t.ok(!enabled.includes('disabled'), 'enabled by default');
    const disabled = renderToHtml(
      toHtml(
        <DatePicker id="dp" open={false} onOpenChange={() => {}} onChange={() => {}} disabled />,
      ),
    );
    t.ok(disabled.includes('disabled'), 'disabled prop lowers the native input disabled');
  });
});

describe('fino:ui/components TimePicker', () => {
  it('shows a placeholder or the value on the trigger', (t) => {
    const placeholder = lines(
      <TimePicker id="tp" open={false} onOpenChange={() => {}} onChange={() => {}} />,
      20,
      2,
    );
    t.equal(strip(placeholder[0]!), '--:-- ▾');
    const withValue = lines(
      <TimePicker id="tp" value="09:05" open={false} onOpenChange={() => {}} onChange={() => {}} />,
      20,
      2,
    );
    t.equal(strip(withValue[0]!), '09:05 ▾');
  });

  it('opens hour/minute(/second) columns and picks a value by click', (t) => {
    const app = live(40, 12);
    const open = createSignal(false);
    const value = createSignal<string | undefined>('09:05');
    const view = (): VNode => (
      <TimePicker
        id="tp"
        value={value.get()}
        open={open.get()}
        onOpenChange={(o) => open.set(o)}
        onChange={(v) => value.set(v)}
      />
    );
    app.render(view());
    click(app, 0, 0);
    t.equal(open.get(), true, 'clicking the trigger opens the popover');
    app.render(view());
    const rows = app.text();
    t.ok(
      rows.some((row) => row.includes('09') && row.includes(':')),
      'the current hour/minute renders in the popover',
    );
  });

  it('steps hours and minutes with arrow keys while open, then Enter closes', (t) => {
    const app = live(40, 12);
    const open = createSignal(false);
    const value = createSignal<string | undefined>('09:05');
    const view = (): VNode => (
      <TimePicker
        id="tp"
        value={value.get()}
        open={open.get()}
        onOpenChange={(o) => open.set(o)}
        onChange={(v) => value.set(v)}
      />
    );
    app.render(view());
    click(app, 0, 0);
    app.render(view());
    key(app, 'up');
    t.equal(value.get(), '09:06', 'up steps the minute by the default step of 1');
    app.render(view());
    key(app, 'down');
    app.render(view());
    key(app, 'down');
    t.equal(value.get(), '09:04', 'down steps the minute back');
    app.render(view());
    key(app, 'right');
    t.equal(value.get(), '10:04', 'right steps the hour forward');
    app.render(view());
    key(app, 'left');
    t.equal(value.get(), '09:04', 'left steps the hour back');
    app.render(view());
    key(app, 'enter');
    t.equal(open.get(), false, 'enter closes the popover');
  });

  it('wraps hours across midnight and minutes across the hour', (t) => {
    const app = live(40, 12);
    const open = createSignal(false);
    const value = createSignal<string | undefined>('00:00');
    const view = (): VNode => (
      <TimePicker
        id="tp"
        value={value.get()}
        open={open.get()}
        onOpenChange={(o) => open.set(o)}
        onChange={(v) => value.set(v)}
      />
    );
    app.render(view());
    click(app, 0, 0);
    app.render(view());
    key(app, 'left');
    t.equal(value.get(), '23:00', 'hour wraps backward past midnight');
    app.render(view());
    key(app, 'down');
    t.equal(value.get(), '22:59', 'minute underflow borrows an hour');
  });

  it('picks a column value directly by clicking it', (t) => {
    const app = live(40, 12);
    const open = createSignal(true);
    const value = createSignal<string | undefined>('09:05');
    const view = (): VNode => (
      <TimePicker
        id="tp"
        value={value.get()}
        open={open.get()}
        onOpenChange={(o) => open.set(o)}
        onChange={(v) => value.set(v)}
      />
    );
    app.render(view());
    // The popover's border top is one row beneath the trigger; the hour
    // column's five visible rows are `timeColumnWindow(9, 24, 5)`, i.e.
    // 07, 08, 09 (current), 10, 11 — the second content row (08) sits two
    // rows below the border top.
    const popoverTop = app.text().findIndex((row) => row.includes('┌'));
    t.ok(popoverTop >= 0, 'the popover box renders');
    click(app, 3, popoverTop + 2);
    t.equal(value.get(), '08:05', 'clicking a value in the hour column commits it directly');
  });

  it('shows a seconds column and native input step=1 when seconds is set', (t) => {
    const frame = lines(
      <TimePicker
        id="tp"
        value="09:05:30"
        open
        onOpenChange={() => {}}
        onChange={() => {}}
        seconds
      />,
      40,
      12,
    );
    t.ok(
      frame.some((row) => strip(row).includes('30')),
      'the current seconds value renders in a third column',
    );
    const html = renderToHtml(
      toHtml(
        <TimePicker
          id="tp"
          value="09:05:30"
          open
          onOpenChange={() => {}}
          onChange={() => {}}
          seconds
        />,
      ),
    );
    t.ok(html.includes('step="1"'), 'seconds forces a 1-second native step');
  });

  it('renders only a native <input type="time" step> on the web, minutes converted to seconds', (t) => {
    const html = renderToHtml(
      toHtml(
        <TimePicker
          id="tp"
          value="09:05"
          open
          onOpenChange={() => {}}
          onChange={() => {}}
          step={15}
        />,
      ),
    );
    t.ok(html.includes('type="time"'), 'native time input');
    t.ok(html.includes('value="09:05"'));
    t.ok(html.includes('step="900"'), '15 minutes converts to 900 seconds');
  });
});

describe('fino:ui/components ColorPicker', () => {
  it('renders inline with a swatch grid when open/onOpenChange are omitted', (t) => {
    const app = live(30, 8);
    const value = createSignal('#ff0000');
    const view = (): VNode => (
      <ColorPicker
        value={value.get()}
        onChange={(v) => value.set(v)}
        swatches={['#ff0000', '#00ff00', '#0000ff']}
      />
    );
    app.render(view());
    t.ok(app.text()[0]!.includes('#ff0000'), 'the hex readout renders on the first row');
    // Trigger (row 0) + gap (row 1) put the swatch grid on rows 2-4; each
    // 4-wide swatch is followed by a 1-cell gap, so the second swatch
    // (green) starts at column 5.
    click(app, 6, 3);
    t.equal(value.get(), '#00ff00', 'clicking a swatch in the always-visible grid picks it');
  });

  it('renders a trigger + popover swatch grid when open/onOpenChange/id are given', (t) => {
    const app = live(30, 8);
    const open = createSignal(false);
    const value = createSignal('#ff0000');
    const view = (): VNode => (
      <ColorPicker
        id="cp"
        value={value.get()}
        onChange={(v) => value.set(v)}
        swatches={['#ff0000', '#00ff00']}
        open={open.get()}
        onOpenChange={(o) => open.set(o)}
      />
    );
    app.render(view());
    t.equal(
      app.text().filter((row) => row.length > 0).length,
      1,
      'closed: only the trigger row paints',
    );
    click(app, 0, 0);
    t.equal(open.get(), true, 'clicking the trigger opens the popover');
  });

  it('marks the swatch matching the current value with a visible border', (t) => {
    const raw = lines(
      <ColorPicker value="#ff0000" onChange={() => {}} swatches={['#ff0000', '#00ff00']} />,
      30,
      6,
    ).join('\n');
    t.ok(raw.includes('┌'), 'the selected swatch paints a border frame');
  });

  it('renders a native <input type="color"> plus a swatch row on the web', (t) => {
    const html = renderToHtml(
      toHtml(<ColorPicker value="#ff0000" onChange={() => {}} swatches={['#ff0000', '#00ff00']} />),
    );
    t.ok(html.includes('type="color"'), 'native color input');
    t.ok(html.includes('value="#ff0000"'));
    t.ok(html.includes('ui-color-swatch'), 'swatch buttons render alongside the native input');
  });

  it('fires onChange through the action collector when a web swatch is clicked', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const picked: string[] = [];
    const html = renderToHtml(
      toHtml(
        <ColorPicker
          value="#ff0000"
          onChange={(v) => picked.push(v)}
          swatches={['#ff0000', '#00ff00']}
        />,
        { actions },
      ),
    );
    const match = /class="ui-color-swatch[^"]*"[^>]*name="do" value="(a\d+)"/.exec(html);
    t.ok(match !== null, 'a swatch button rides the action collector');
    actions.get(match![1]!)!();
    t.deepEqual(picked, ['#ff0000'], 'invoking the collected action fires onChange');
  });
});
