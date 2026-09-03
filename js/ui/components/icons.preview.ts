/** Co-located previews for icon components. @internal */
import { h } from 'fino:ui';
import { HStack, Icon, IconButton, Text } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build icon-family previews for a future catalog host. */
export function iconPreviews(): PreviewGroup {
  return {
    title: 'Icons',
    previews: [
      {
        key: 'registry',
        name: 'Registry',
        view: () =>
          h(
            HStack,
            { gap: 1 },
            h(Icon, { name: 'folder', label: 'Folder' }),
            h(Icon, { name: 'code', label: 'Code' }),
            h(Text, null, 'semantic forms'),
          ),
      },
      {
        key: 'button',
        name: 'Icon button',
        view: () => h(IconButton, { icon: 'lock', label: 'Lock', onClick: () => {} }),
      },
    ],
  };
}
