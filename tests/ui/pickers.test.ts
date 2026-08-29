import { describe, it } from 'fino:test/test';
import { createSignal, h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Calendar,
  ColorPicker,
  DatePicker,
  DigitalClock,
  TimePicker,
  formatClockTime,
  formatTimeParts,
  isClockTime,
  isIsoDate,
  monthGrid,
  normalizeHexColor,
  parseClockTime,
  shiftMonth,
  timeColumnWindow,
} from 'fino:ui/components';
import { pageCss, toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { adaptTerminalColor, terminalColor } from 'internal:ui/components/color.tui';
import { normalizeColorSwatches, normalizeTimeStep } from 'internal:ui/components/pickers';
import { pickersPreviews } from 'internal:ui/components/pickers.preview';
import { defaultArgs } from 'internal:ui/preview';
import { createTuiHarness, plainLine } from './tui-harness.ts';

function html(tree: VNode, actions?: Map<string, (value?: string) => void>): string {
  return renderToHtml(toHtml(tree, actions === undefined ? {} : { actions }));
}

describe('picker date, time, and color mechanics', () => {
  it('covers leap years and month boundaries without reading ambient time', (t) => {
    const leap = monthGrid(2024, 2);
    t.equal(leap.flat().find((cell) => cell.date === '2024-02-29')?.currentMonth, true);
    t.equal(isIsoDate('2024-02-29'), true);
    t.equal(isIsoDate('2023-02-29'), false);
    t.equal(shiftMonth('2024-01', -1), '2023-12');
    t.equal(shiftMonth('2024-12', 1), '2025-01');
  });

  it('clamps, formats, steps, and validates clock values', (t) => {
    t.deepEqual(parseClockTime('27:61:99'), { hours: 23, minutes: 59, seconds: 59 });
    t.equal(formatClockTime('2:3', false), '02:03');
    t.equal(formatTimeParts(23, 59, 7), '23:59:07');
    t.deepEqual(timeColumnWindow(0, 24, 5), [22, 23, 0, 1, 2]);
    t.equal(isClockTime('23:59'), true);
    t.equal(isClockTime('24:00'), false);
    t.equal(isClockTime('12:30:04', true), true);
  });

  it('rejects invalid colors and shares truecolor/fallback adaptation', (t) => {
    t.equal(normalizeHexColor(' #Aa00fF '), '#aa00ff');
    t.equal(normalizeHexColor('#xyzxyz'), null);
    t.deepEqual(normalizeColorSwatches(['#AA00FF', 'bad', '#aa00ff']), ['#aa00ff']);
    t.equal(normalizeTimeStep(Number.NaN), 1);
    t.deepEqual(terminalColor([1, 2, 3], true), { rgb: [1, 2, 3] });
    t.ok('ansi256' in terminalColor([255, 0, 0], false));
    t.equal(adaptTerminalColor('cyan', false), 'cyan');
    t.deepEqual(adaptTerminalColor({ ansi256: 42 }, true), { ansi256: 42 });
    t.deepEqual(adaptTerminalColor({ rgb: [1, 2, 3] }, true), { rgb: [1, 2, 3] });
  });
});

describe('picker HTML lowerings', () => {
  it('keeps platform pickers native and groups calendar/color actions', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const calls: string[] = [];
    const out = html(
      h(
        'fragment',
        null,
        h(Calendar, {
          month: '2024-02',
          onSelect: (value) => calls.push(value),
          onMonthChange: (value) => calls.push(value),
        }),
        h(DatePicker, {
          id: 'date',
          open: false,
          onOpenChange: () => {},
          onChange: (value) => calls.push(value),
        }),
        h(TimePicker, {
          id: 'time',
          open: false,
          seconds: true,
          onOpenChange: () => {},
          onChange: (value) => calls.push(value),
        }),
        h(ColorPicker, {
          value: '#ff0000',
          onChange: (value) => calls.push(value),
          swatches: ['#00ff00', 'bad'],
        }),
      ),
      actions,
    );
    t.equal(actions.size, 4);
    t.ok(out.includes('type="date"'));
    t.ok(out.includes('type="time"'));
    t.ok(out.includes('type="color"'));
    actions.get('a0')?.('2024-02-29');
    actions.get('a0')?.('next');
    actions.get('a1')?.('2023-02-29');
    actions.get('a2')?.('23:59:58');
    actions.get('a3')?.('#00FF00');
    t.deepEqual(calls, ['2024-02-29', '2024-03', '23:59:58', '#00ff00']);
  });
});

describe('picker terminal lowerings', () => {
  it('composes terminal date and time pickers through shared popovers', (t) => {
    const app = createTuiHarness(50, 12);
    const open = createSignal(true);
    const time = createSignal('23:59');
    const view = () =>
      h(
        'fragment',
        null,
        h(DatePicker, {
          id: 'date',
          value: '2024-02-29',
          month: '2024-02',
          open: open.get(),
          onOpenChange: (next) => open.set(next),
          onChange: () => {},
        }),
        h(TimePicker, {
          id: 'time',
          value: time.get(),
          open: true,
          step: 5,
          onOpenChange: () => {},
          onChange: (next) => time.set(next),
        }),
      );
    app.render(view());
    t.ok(app.lines().map(plainLine).join('\n').includes('2024-02-29'));
    app.dispatcher.focusNext();
    t.equal(app.key({ key: 'escape' }), true);
    t.equal(open.get(), false);
  });

  it('steps terminal time values across midnight', (t) => {
    const app = createTuiHarness(24, 8);
    const time = createSignal('23:59');
    const view = () =>
      h(TimePicker, {
        id: 'time',
        value: time.get(),
        open: true,
        step: 5,
        onOpenChange: () => {},
        onChange: (next) => time.set(next),
      });
    app.render(view());
    app.dispatcher.focusNext();
    t.equal(app.key({ key: 'up' }), true);
    t.equal(time.get(), '00:04');
    app.render(view());
    t.equal(app.key({ key: 'left' }), true);
    t.equal(time.get(), '23:04');
  });

  it('renders supplied clocks and ignores invalid terminal swatches', (t) => {
    const app = createTuiHarness(30, 6);
    app.render(
      h(
        'fragment',
        null,
        h(DigitalClock, { time: '7:05:09', seconds: true }),
        h(ColorPicker, { value: 'invalid', onChange: () => {}, swatches: ['bad', '#00ff00'] }),
      ),
    );
    const text = app.lines().map(plainLine).join('\n');
    t.ok(text.includes('07:05:09'));
  });
});

describe('picker previews and styles', () => {
  it('keeps the family preview co-located, renderable, and singly styled', (t) => {
    const group = pickersPreviews();
    t.equal(group.title, 'Pickers');
    t.deepEqual(
      group.previews.map((preview) => preview.key),
      ['calendar', 'clock', 'color'],
    );
    for (const preview of group.previews) {
      t.ok(html(preview.view(defaultArgs(preview))).length > 0, preview.key);
    }
    t.equal(pageCss().split('.ui-calendar-wrap {').length - 1, 1);
  });
});
