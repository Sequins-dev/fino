/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/pickers.stories — gallery stories for calendars, clocks, and the date/time/color pickers.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/gallery` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import { render } from 'fino:tty/tui';
import {
  Calendar,
  ColorPicker,
  DatePicker,
  DigitalClock,
  Popover,
  Text,
  TimePicker,
  VStack,
  createDisclosure,
  styles,
} from 'fino:ui/components';
import type { StoryGroup } from 'internal:ui/story';

const SWATCHES = [
  '#bf616a',
  '#a3be8c',
  '#ebcb8b',
  '#81a1c1',
  '#b48ead',
  '#88c0d0',
  '#d8dee9',
  '#3b4252',
];

// Every date/time value here is a fixed string — no `Date.now()`, no ambient
// clock — so the terminal and HTML galleries render identically on every
// run, and the interaction tests in tests/ui/pickers.test.tsx can assert

export function pickersStories(): StoryGroup {
  const calMonth = createSignal('2024-06');
  const calSelected = createSignal<string | undefined>('2024-06-15');
  const datePicker = createDisclosure(false);
  const dateValue = createSignal<string | undefined>('2024-06-15');
  const dateMonth = createSignal('2024-06');
  const timePicker = createDisclosure(false);
  const timeValue = createSignal<string | undefined>('14:30');
  const colorValue = createSignal('#88c0d0');
  const colorPicker = createDisclosure(false);

  return {
    title: 'Time & pickers',
    stories: [
      {
        key: 'calendar',
        name: 'Calendar',
        controls: {
          weekStartsOn: {
            type: 'select',
            label: 'Week starts on',
            options: ['0', '1'],
            default: '0',
          },
        },
        view: (args) => (
          <VStack gap={1}>
            <Calendar
              id="gallery-calendar"
              month={calMonth.get()}
              selected={calSelected.get()}
              today="2024-06-10"
              weekStartsOn={(args.weekStartsOn === '1' ? 1 : 0) as 0 | 1}
              onSelect={(date) => calSelected.set(date)}
              onMonthChange={(month) => calMonth.set(month)}
            />
            <Text style={[styles.muted]}>{`selected: ${calSelected.get() ?? '—'}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'digital-clock',
        name: 'DigitalClock',
        controls: {
          time: { type: 'text', default: '09:41:00' },
          seconds: { type: 'boolean', default: true },
          label: { type: 'text', default: 'Local time' },
        },
        view: (args) => (
          <DigitalClock
            time={String(args.time)}
            seconds={args.seconds === true}
            label={String(args.label).length > 0 ? String(args.label) : undefined}
          />
        ),
      },
      {
        key: 'date-picker',
        name: 'DatePicker',
        controls: {
          weekStartsOn: {
            type: 'select',
            label: 'Week starts on',
            options: ['0', '1'],
            default: '0',
          },
        },
        view: (args) => (
          <VStack gap={1} width={30}>
            <DatePicker
              id="gallery-date-picker"
              value={dateValue.get()}
              open={datePicker.open.get()}
              onOpenChange={(next) => datePicker.set(next)}
              onChange={(date) => dateValue.set(date)}
              month={dateMonth.get()}
              onMonthChange={(month) => dateMonth.set(month)}
              today="2024-06-10"
              weekStartsOn={(args.weekStartsOn === '1' ? 1 : 0) as 0 | 1}
            />
            <Text style={[styles.muted]}>Click the trigger to open the calendar popover.</Text>
          </VStack>
        ),
      },
      {
        key: 'time-picker',
        name: 'TimePicker',
        controls: {
          step: { type: 'number', label: 'Minute step', default: 5, min: 1, max: 30 },
          seconds: { type: 'boolean', default: false },
        },
        view: (args) => (
          <VStack gap={1} width={30}>
            <TimePicker
              id="gallery-time-picker"
              value={timeValue.get()}
              open={timePicker.open.get()}
              onOpenChange={(next) => timePicker.set(next)}
              onChange={(value) => timeValue.set(value)}
              step={Number(args.step)}
              seconds={args.seconds === true}
            />
            <Text style={[styles.muted]}>Arrow keys step while open; Enter/Esc close.</Text>
          </VStack>
        ),
      },
      {
        key: 'color-picker',
        name: 'ColorPicker',
        controls: {
          popover: { type: 'boolean', label: 'Popover mode', default: false },
        },
        view: (args) => {
          const popover = args.popover === true;
          return (
            <VStack gap={1}>
              <ColorPicker
                id="gallery-color-picker"
                value={colorValue.get()}
                onChange={(value) => colorValue.set(value)}
                swatches={SWATCHES}
                open={popover ? colorPicker.open.get() : undefined}
                onOpenChange={popover ? (next) => colorPicker.set(next) : undefined}
              />
              <Text style={[styles.muted]}>{`value: ${colorValue.get()}`}</Text>
            </VStack>
          );
        },
      },
    ],
  };
}
