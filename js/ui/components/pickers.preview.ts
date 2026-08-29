/** Co-located previews for date, time, and color pickers. @internal */
import { h } from 'fino:ui';
import { Calendar, ColorPicker, DigitalClock, HStack } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build picker-family previews for a catalog host. */
export function pickersPreviews(): PreviewGroup {
  return {
    title: 'Pickers',
    previews: [
      {
        key: 'calendar',
        name: 'Calendar',
        view: () => h(Calendar, { month: '2024-02', selected: '2024-02-29', today: '2024-02-14' }),
      },
      {
        key: 'clock',
        name: 'Digital clock',
        view: () => h(DigitalClock, { time: '23:59:58', seconds: true, label: 'UTC' }),
      },
      {
        key: 'color',
        name: 'Color picker',
        view: () =>
          h(
            HStack,
            null,
            h(ColorPicker, {
              value: '#3366ff',
              onChange: () => {},
              swatches: ['#3366ff', '#ff3366', 'invalid'],
            }),
          ),
      },
    ],
  };
}
