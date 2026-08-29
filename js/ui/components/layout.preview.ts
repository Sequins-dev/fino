/** Co-located previews for layout components. @internal */
import { h } from 'fino:ui';
import { HStack, Panel, Rule, Spacer, Text, VStack, styles } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build layout-family previews for a future catalog host. */
export function layoutPreviews(): PreviewGroup {
  return {
    title: 'Layout',
    previews: [
      {
        key: 'panel',
        name: 'Panel',
        controls: {
          title: { type: 'text', default: 'Session' },
          width: { type: 'number', default: 30, min: 12, max: 60 },
        },
        view: (args) =>
          h(
            Panel,
            { title: String(args.title), width: Number(args.width) },
            h(Text, null, 'Bordered content'),
            h(Rule),
            h(
              HStack,
              { justify: 'between' },
              h(Text, { style: [styles.muted] }, 'left'),
              h(Text, { style: [styles.accent] }, 'right'),
            ),
          ),
      },
      {
        key: 'stacks',
        name: 'Stacks',
        view: () =>
          h(
            VStack,
            { gap: 1, width: 24 },
            h(HStack, null, h(Text, null, 'start'), h(Spacer, { flex: 1 }), h(Text, null, 'end')),
          ),
      },
    ],
  };
}
