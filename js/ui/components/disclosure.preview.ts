/** Co-located previews for disclosure components. @internal */
import { createSignal, h } from 'fino:ui';
import { Accordion, Details, Tabs, Text, createAccordion } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build disclosure-family previews for a catalog host. */
export function disclosurePreviews(): PreviewGroup {
  const detailsOpen = createSignal(true);
  const tab = createSignal('overview');
  const accordion = createAccordion(true);
  return {
    title: 'Disclosure',
    previews: [
      {
        key: 'details',
        name: 'Details',
        view: () =>
          h(
            Details,
            {
              title: 'Advanced settings',
              open: detailsOpen.get(),
              onToggle: (next) => detailsOpen.set(next),
            },
            h(Text, null, 'Hidden until expanded.'),
          ),
      },
      {
        key: 'tabs',
        name: 'Tabs',
        view: () =>
          h(
            Tabs,
            {
              value: tab.get(),
              onChange: (next) => tab.set(next),
              items: [
                { key: 'overview', label: 'Overview' },
                { key: 'activity', label: 'Activity' },
              ],
            },
            h(Text, null, tab.get() === 'overview' ? 'Overview panel' : 'Activity panel'),
          ),
      },
      {
        key: 'accordion',
        name: 'Accordion',
        view: () =>
          h(Accordion, {
            sections: [
              { key: 'one', title: 'First', content: h(Text, null, 'First body') },
              { key: 'two', title: 'Second', content: h(Text, null, 'Second body') },
            ],
            openKeys: accordion.openKeys.get(),
            onToggle: accordion.toggle,
          }),
      },
    ],
  };
}
