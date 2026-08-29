/** Co-located previews for navigation components. @internal */
import { createSignal, h } from 'fino:ui';
import { Breadcrumbs, Pagination, Steps, VStack } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build navigation-family previews for a catalog host. */
export function navigationPreviews(): PreviewGroup {
  const page = createSignal(7);
  return {
    title: 'Navigation',
    previews: [
      {
        key: 'breadcrumbs',
        name: 'Breadcrumbs',
        view: () =>
          h(Breadcrumbs, {
            items: [
              { key: 'home', label: 'Home' },
              { key: 'projects', label: 'Projects' },
              { key: 'fino', label: 'Fino' },
            ],
            onNavigate: () => {},
          }),
      },
      {
        key: 'pagination',
        name: 'Pagination',
        controls: { pages: { type: 'number', default: 20, min: 1, max: 100 } },
        view: (args) =>
          h(Pagination, {
            page: page.get(),
            pages: Number(args.pages),
            onChange: (next) => page.set(next),
          }),
      },
      {
        key: 'steps',
        name: 'Steps',
        view: () =>
          h(
            VStack,
            null,
            h(Steps, {
              current: 'review',
              steps: [
                { key: 'draft', label: 'Draft' },
                { key: 'review', label: 'Review' },
                { key: 'done', label: 'Done' },
              ],
            }),
          ),
      },
    ],
  };
}
