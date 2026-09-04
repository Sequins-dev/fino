/** Co-located previews for display components. @internal */
import { h } from 'fino:ui';
import { Card, EmptyState, HStack, Stat, StatusDot, Text } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build display-family previews for a catalog host. */
export function displayPreviews(): PreviewGroup {
  return {
    title: 'Display',
    previews: [
      {
        key: 'card',
        name: 'Card',
        view: () =>
          h(
            Card,
            { title: 'Deployment', subtitle: 'Production', width: 30 },
            h(Text, null, 'Version 1.4.0'),
          ),
      },
      {
        key: 'stats',
        name: 'Stats',
        view: () =>
          h(
            HStack,
            { gap: 3 },
            h(Stat, { label: 'Requests', value: '12.4k', trend: 'up' }),
            h(StatusDot, { status: 'ok', label: 'Healthy' }),
          ),
      },
      {
        key: 'empty',
        name: 'Empty state',
        view: () =>
          h(EmptyState, {
            icon: 'folder',
            title: 'No files',
            description: 'Create a file to begin.',
          }),
      },
    ],
  };
}
