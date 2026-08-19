/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/navigation.preview — preview previews for breadcrumbs, pagers, and step strips.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/preview` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import { Breadcrumbs, Pagination, Steps, Text, VStack, styles } from 'fino:ui/components';
import { page } from 'fino:ui/web';
import type { PreviewGroup } from 'internal:ui/preview';

export function navigationPreviews(): PreviewGroup {
  const crumbTrail = [
    { key: 'root', label: '~' },
    { key: 'src', label: 'src' },
    { key: 'ui', label: 'ui' },
    { key: 'preview', label: 'preview.tsx' },
  ];
  const crumb = createSignal('preview');
  const pageAt = createSignal(1);
  return {
    title: 'Navigation',
    previews: [
      {
        key: 'breadcrumbs',
        name: 'Breadcrumbs',
        view: () => (
          <VStack gap={1}>
            <Breadcrumbs items={crumbTrail} onNavigate={(key) => crumb.set(key)} />
            <Text style={[styles.muted]}>{`navigated: ${crumb.get()}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'pagination',
        name: 'Pagination',
        controls: {
          pages: { type: 'number', default: 20, min: 1, max: 30 },
          siblings: { type: 'number', label: 'Siblings', default: 1, min: 0, max: 3 },
        },
        view: (args) => {
          const pages = Math.max(1, Number(args.pages));
          const siblings = Math.max(0, Number(args.siblings));
          const page = Math.min(pageAt.get(), pages);
          return (
            <VStack gap={1}>
              <Pagination
                page={page}
                pages={pages}
                siblings={siblings}
                onChange={(next) => pageAt.set(next)}
              />
              <Text style={[styles.muted]}>{`page ${page} of ${pages}`}</Text>
            </VStack>
          );
        },
      },
      {
        key: 'steps',
        name: 'Steps',
        controls: {
          current: { type: 'select', options: ['plan', 'build', 'test', 'ship'], default: 'build' },
        },
        view: (args) => (
          <Steps
            current={String(args.current)}
            steps={[
              { key: 'plan', label: 'Plan' },
              { key: 'build', label: 'Build' },
              { key: 'test', label: 'Test' },
              { key: 'ship', label: 'Ship' },
            ]}
          />
        ),
      },
    ],
  };
}
