/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/layout.preview — preview previews for stacks and panels.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/preview` composes every group into the browsable catalog.
 *
 * @internal
 */
import { Box, HStack, Panel, Rule, Spacer, Text, VStack, styles } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

export function layoutPreviews(): PreviewGroup {
  return {
    title: 'Layout',
    previews: [
      {
        key: 'panel',
        name: 'Panel',
        controls: {
          title: { type: 'text', default: 'Session' },
          border: {
            type: 'select',
            options: ['single', 'heavy', 'double', 'ascii'],
            default: 'single',
          },
          rounded: { type: 'boolean', default: false },
          width: { type: 'number', default: 30, step: 2, min: 12, max: 60 },
        },
        view: (args) => (
          <Panel
            title={String(args.title)}
            border={args.border as never}
            rounded={args.rounded === true || args.rounded === 'true'}
            width={Number(args.width)}
          >
            <Text>Bordered content with a title.</Text>
            <Rule />
            <HStack gap={1} justify="between">
              <Text style={[styles.muted]}>left</Text>
              <Text style={[styles.accent]}>right</Text>
            </HStack>
          </Panel>
        ),
      },
      {
        key: 'stacks',
        name: 'Stacks & flex',
        view: () => (
          <VStack gap={1} width={34}>
            <HStack gap={1}>
              <Text style={[styles.inverse]}> fixed </Text>
              <Spacer flex={1} />
              <Text style={[styles.inverse]}> end </Text>
            </HStack>
            <HStack gap={1}>
              <Box border grow={1} padding={0}>
                <Text align="center">grow 1</Text>
              </Box>
              <Box border grow={2}>
                <Text align="center">grow 2</Text>
              </Box>
            </HStack>
          </VStack>
        ),
      },
    ],
  };
}
