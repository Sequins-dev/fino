/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/typography.stories — gallery stories for headings, emphasis, links, quotes, lists, and code.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/gallery` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import { copyToClipboard } from 'fino:tty/tui';
import {
  Blockquote,
  Bold,
  Code,
  HStack,
  Heading,
  InlineCode,
  Italic,
  Link,
  List,
  Text,
  VStack,
  styles,
} from 'fino:ui/components';
import type { StoryGroup } from 'internal:ui/story';

export function typographyStories(): StoryGroup {
  const activated = createSignal(0);
  const sampleCode = [
    'function greet(name: string): string {',
    '  // say hello',
    '  return `Hello, ${name}!`;',
    '}',
  ].join('\n');
  return {
    title: 'Typography',
    stories: [
      {
        key: 'heading',
        name: 'Heading',
        controls: {
          level: { type: 'number', default: 1, min: 1, max: 6, step: 1 },
        },
        view: (args) => (
          <VStack gap={1}>
            <Heading level={Math.min(6, Math.max(1, Number(args.level))) as 1 | 2 | 3 | 4 | 5 | 6}>
              Release notes
            </Heading>
            <Text style={[styles.muted]}>Body copy beneath the heading.</Text>
          </VStack>
        ),
      },
      {
        key: 'emphasis',
        name: 'Bold & Italic',
        view: () => (
          <VStack gap={1}>
            {/* Text flattens descendant nodes to plain text in the terminal —
                mixed inline styling composes as row siblings instead. */}
            <HStack gap={0}>
              <Text>Plain, </Text>
              <Bold>bold</Bold>
              <Text>, and </Text>
              <Italic>italic</Italic>
              <Text> text mixed inline.</Text>
            </HStack>
            <HStack gap={1}>
              <Bold>Warning:</Bold>
              <Italic>this action cannot be undone.</Italic>
            </HStack>
          </VStack>
        ),
      },
      {
        key: 'link',
        name: 'Link',
        controls: {
          mode: { type: 'select', options: ['href', 'handler'], default: 'href' },
        },
        view: (args) => (
          <VStack gap={1}>
            {args.mode === 'handler' ? (
              <Link id="story-link" onActivate={() => activated.set(activated.get() + 1)}>
                Run the build
              </Link>
            ) : (
              <Link href="https://fino.dev/docs">Read the docs</Link>
            )}
            <Text style={[styles.muted]}>
              {args.mode === 'handler'
                ? `activated ${activated.get()} times`
                : 'href renders a real <a> on the web'}
            </Text>
          </VStack>
        ),
      },
      {
        key: 'blockquote',
        name: 'Blockquote',
        view: () => (
          <Blockquote>
            <Text>Measure twice, cut once.</Text>
            <Text style={[styles.dim]}>— attributed to every carpenter, ever</Text>
          </Blockquote>
        ),
      },
      {
        key: 'list',
        name: 'List',
        controls: {
          ordered: { type: 'boolean', default: false },
        },
        view: (args) => (
          <List
            ordered={args.ordered === true}
            items={[
              'Clone the repo',
              'Install dependencies',
              <HStack gap={0}>
                <Text>Run </Text>
                <InlineCode>cargo build</InlineCode>
              </HStack>,
            ]}
          />
        ),
      },
      {
        key: 'code',
        name: 'Code',
        controls: {
          language: { type: 'select', options: ['ts', 'js', 'plain'], default: 'ts' },
          showLineNumbers: { type: 'boolean', default: true },
          filename: { type: 'text', default: 'greet.ts' },
          copyable: { type: 'boolean', default: true },
        },
        view: (args) => (
          <VStack gap={1}>
            <Code
              code={sampleCode}
              language={args.language === 'plain' ? undefined : String(args.language)}
              showLineNumbers={args.showLineNumbers === true}
              filename={String(args.filename).length > 0 ? String(args.filename) : undefined}
              copyable={args.copyable === true}
              onCopy={(code) => copyToClipboard(code)}
            />
            <HStack gap={0}>
              <Text>Inline: </Text>
              <InlineCode>npm install fino</InlineCode>
            </HStack>
          </VStack>
        ),
      },
    ],
  };
}
