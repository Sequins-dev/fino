/** Native HTML lowerings and calendar styles for picker components. @internal */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { componentStyleAttrs, controlledNativeValue } from 'internal:ui/components/html-runtime';
import {
  Calendar,
  ColorPicker,
  DatePicker,
  DigitalClock,
  TimePicker,
  formatClockTime,
  isClockTime,
  isIsoDate,
  monthGrid,
  monthLabel,
  normalizeColorSwatches,
  normalizeHexColor,
  normalizeTimeStep,
  parseIsoMonth,
  shiftMonth,
  weekdayLabels,
} from 'internal:ui/components/pickers';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

mapComponentLowering(Calendar, 'html', (props) => {
  const { year, month } = parseIsoMonth(props.month);
  const weeks = monthGrid(year, month, props.weekStartsOn);
  const validDates = new Set(weeks.flat().map((cell) => cell.date));
  const action =
    props.onSelect === undefined && props.onMonthChange === undefined
      ? undefined
      : (raw?: string): void => {
          if (raw === 'previous') props.onMonthChange?.(shiftMonth(props.month, -1));
          else if (raw === 'next') props.onMonthChange?.(shiftMonth(props.month, 1));
          else if (raw !== undefined && validDates.has(raw)) props.onSelect?.(raw);
        };
  return controlledNativeValue(action, (attrs) => {
    const button = (value: string, label: string, enabled: boolean, extra: Props = {}) =>
      h(
        'button',
        {
          ...attrs,
          type: attrs.name === undefined ? 'button' : undefined,
          value,
          disabled: attrs.disabled === true || !enabled,
          ...extra,
        },
        label,
      );
    return h(
      'section',
      componentStyleAttrs(props as Props, 'ui-calendar-wrap'),
      h(
        'header',
        { className: 'ui-cal-nav' },
        button('previous', '‹', props.onMonthChange !== undefined, {
          'aria-label': 'Previous month',
        }),
        h('strong', null, monthLabel(year, month)),
        button('next', '›', props.onMonthChange !== undefined, { 'aria-label': 'Next month' }),
      ),
      h(
        'table',
        { className: 'ui-calendar', role: 'grid', 'aria-label': monthLabel(year, month) },
        h(
          'thead',
          null,
          h('tr', null, ...weekdayLabels(props.weekStartsOn).map((label) => h('th', null, label))),
        ),
        h(
          'tbody',
          null,
          ...weeks.map((week) =>
            h(
              'tr',
              null,
              ...week.map((cell) =>
                h(
                  'td',
                  null,
                  button(cell.date, String(cell.day), props.onSelect !== undefined, {
                    className: `ui-cal-day${cell.currentMonth ? '' : ' is-outside'}${cell.date === props.selected ? ' is-selected' : ''}${cell.date === props.today ? ' is-today' : ''}`,
                    'aria-selected': cell.date === props.selected ? 'true' : undefined,
                    'aria-current': cell.date === props.today ? 'date' : undefined,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  });
});

mapComponentLowering(DigitalClock, 'html', (props) => {
  const shown = formatClockTime(props.time, props.seconds === true);
  return h(
    'div',
    componentStyleAttrs(props as Props, 'ui-clock'),
    h('time', { datetime: shown }, shown),
    props.label === undefined ? null : h('span', null, props.label),
  );
});

mapComponentLowering(DatePicker, 'html', (props) =>
  controlledNativeValue(
    (raw) => {
      if (raw !== undefined && isIsoDate(raw)) props.onChange(raw);
    },
    (attrs) =>
      h('input', {
        ...componentStyleAttrs(props as Props, 'ui-field'),
        ...attrs,
        type: 'date',
        value: props.value,
        placeholder: props.placeholder,
      }),
    { disabled: props.disabled },
  ),
);

mapComponentLowering(TimePicker, 'html', (props) =>
  controlledNativeValue(
    (raw) => {
      if (raw !== undefined && isClockTime(raw, props.seconds === true)) props.onChange(raw);
    },
    (attrs) =>
      h('input', {
        ...componentStyleAttrs(props as Props, 'ui-field'),
        ...attrs,
        type: 'time',
        value: props.value,
        placeholder: props.placeholder,
        step: props.seconds === true ? '1' : String(normalizeTimeStep(props.step) * 60),
      }),
    { disabled: props.disabled },
  ),
);

mapComponentLowering(ColorPicker, 'html', (props) => {
  const valid = normalizeHexColor(props.value) ?? '#000000';
  const swatches = normalizeColorSwatches(props.swatches);
  return controlledNativeValue(
    (raw) => {
      const next = raw === undefined ? null : normalizeHexColor(raw);
      if (next !== null) props.onChange(next);
    },
    (attrs) =>
      h(
        'div',
        componentStyleAttrs(props as Props, 'ui-color-picker'),
        h('input', { ...attrs, type: 'color', value: valid, className: 'ui-color-input' }),
        h(
          'div',
          { className: 'ui-color-swatches' },
          ...swatches.map((hex) =>
            h('button', {
              ...attrs,
              type: attrs.name === undefined ? 'button' : undefined,
              value: hex,
              className: `ui-color-swatch${hex === valid ? ' is-selected' : ''}`,
              style: { background: hex },
              'aria-label': hex,
            }),
          ),
        ),
      ),
  );
});

registerHtmlCss(`
.ui-calendar-wrap { width: fit-content; }
.ui-cal-nav { display: flex; justify-content: space-between; align-items: center; }
.ui-calendar { border-collapse: collapse; }
.ui-calendar th { color: var(--tui-bright-black); font-weight: 400; }
.ui-cal-day { width: 2.2rem; height: 2.2rem; border-radius: 50%; cursor: pointer; }
.ui-cal-day.is-outside { opacity: 0.4; }
.ui-cal-day.is-today { text-decoration: underline; }
.ui-cal-day.is-selected { background: var(--ui-selected); font-weight: 700; }
.ui-clock { display: flex; flex-direction: column; }
.ui-clock time { font-size: 2em; font-weight: 700; font-variant-numeric: tabular-nums; }
.ui-clock span { color: var(--tui-bright-black); }
.ui-color-picker, .ui-color-swatches { display: flex; align-items: center; gap: 0.5rem; }
.ui-color-swatch { width: 2rem; height: 2rem; border: 2px solid transparent; border-radius: 0.3rem; }
.ui-color-swatch.is-selected { border-color: var(--tui-fg); }
`);
