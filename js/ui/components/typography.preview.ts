/** Co-located previews for typography components. @internal */
import { h } from 'fino:ui';
import {
  Blockquote,
  Bold,
  Code,
  Heading,
  InlineCode,
  Italic,
  List,
  Text,
  VStack,
} from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

const SAMPLE = 'const ready: boolean = true;\n// shared highlighter';

/** Build typography-family previews for a future catalog host. */
export function typographyPreviews(): PreviewGroup {
  return {
    title: 'Typography',
    previews: [
      {
        key: 'heading',
        name: 'Heading',
        controls: { level: { type: 'number', default: 1, min: 1, max: 6 } },
        view: (args) => h(Heading, { level: Number(args.level) as 1 }, 'Release notes'),
      },
      {
        key: 'prose',
        name: 'Prose',
        view: () =>
          h(
            VStack,
            { gap: 1 },
            h(Text, null, 'Plain ', h(Bold, null, 'bold'), ' and ', h(Italic, null, 'italic')),
            h(Blockquote, null, h(Text, null, 'Measure twice, cut once.')),
            h(List, { items: ['Clone', 'Build', h(InlineCode, null, 'fino test')] }),
          ),
      },
      {
        key: 'code',
        name: 'Code',
        view: () => h(Code, { code: SAMPLE, language: 'ts', showLineNumbers: true }),
      },
    ],
  };
}
