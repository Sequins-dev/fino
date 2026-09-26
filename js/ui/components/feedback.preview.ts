/** Co-located previews for feedback components. @internal */
import { h } from 'fino:ui';
import {
  Badge,
  Callout,
  HStack,
  KeyHint,
  ProgressBar,
  Spinner,
  Tag,
  VStack,
} from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build feedback-family previews for a catalog host. */
export function feedbackPreviews(): PreviewGroup {
  return {
    title: 'Feedback',
    previews: [
      {
        key: 'progress',
        name: 'Progress',
        controls: { value: { type: 'number', default: 0.62, min: 0, max: 1, step: 0.01 } },
        view: (args) =>
          h(
            HStack,
            { gap: 1 },
            h(Spinner, { tick: 2 }),
            h(ProgressBar, { value: Number(args.value), width: 16, showPercent: true }),
          ),
      },
      {
        key: 'badges',
        name: 'Badges and tags',
        view: () =>
          h(
            HStack,
            { gap: 1, wrap: true },
            h(Badge, { label: 'Ready', variant: 'success' }),
            h(Tag, { label: 'runtime', color: 'accent' }),
          ),
      },
      {
        key: 'callout',
        name: 'Callout',
        view: () => h(Callout, { title: 'Validation', variant: 'warning' }, 'A name is required.'),
      },
      {
        key: 'keys',
        name: 'Key hints',
        view: () =>
          h(
            VStack,
            null,
            h(KeyHint, {
              keys: [
                { key: 'y', label: 'approve' },
                { key: 'n', label: 'reject' },
              ],
            }),
          ),
      },
    ],
  };
}
