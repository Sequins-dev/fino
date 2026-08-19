/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/indicators.preview — preview previews for badges, icons, key hints, and tags.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/preview` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import {
  Badge,
  Box,
  Button,
  HStack,
  Icon,
  KeyHint,
  Tag,
  TagGroup,
  Text,
  VStack,
  styles,
} from 'fino:ui/components';
import type { ToneVariant } from 'fino:ui/components';
import { ICONS } from 'internal:ui/components/icons';
import type { PreviewGroup } from 'internal:ui/preview';

const TONE_VARIANTS: ToneVariant[] = ['accent', 'muted', 'danger', 'success', 'warning'];

export function indicatorsPreviews(): PreviewGroup {
  const tagLabels = ['alpha', 'beta', 'gamma', 'delta'];
  const tagColors: Record<string, ToneVariant> = {
    alpha: 'accent',
    beta: 'success',
    gamma: 'warning',
    delta: 'muted',
  };
  const tags = createSignal(tagLabels);
  return {
    title: 'Indicators',
    previews: [
      {
        key: 'badge',
        name: 'Badge',
        controls: {
          label: { type: 'text', default: 'beta' },
          variant: { type: 'select', options: [...TONE_VARIANTS], default: 'accent' },
        },
        view: (args) => (
          <VStack gap={1}>
            <Badge label={String(args.label)} variant={args.variant as ToneVariant} />
            <HStack gap={1}>
              {TONE_VARIANTS.map((variant) => (
                <Badge key={variant} label={variant} variant={variant} />
              ))}
            </HStack>
          </VStack>
        ),
      },
      {
        key: 'icons',
        name: 'Icon',
        view: () => (
          <Box direction="row" wrap gap={2} width={54}>
            {Object.keys(ICONS).map((name) => (
              <HStack key={name} gap={1} width={16}>
                <Icon name={name} label={name} />
                <Text style={[styles.muted]}>{name}</Text>
              </HStack>
            ))}
          </Box>
        ),
      },
      {
        key: 'key-hint',
        name: 'KeyHint',
        controls: {
          separator: { type: 'text', default: '·' },
        },
        view: (args) => (
          <KeyHint
            separator={String(args.separator)}
            keys={[
              { key: 'y', label: 'approve' },
              { key: 'n', label: 'reject' },
              { key: 'q', label: 'quit' },
            ]}
          />
        ),
      },
      {
        key: 'tags',
        name: 'Tag & TagGroup',
        view: () => (
          <VStack gap={1}>
            <TagGroup>
              {tags.get().map((label) => (
                <Tag
                  key={label}
                  id={`tag:${label}`}
                  label={label}
                  color={tagColors[label]}
                  onRemove={() => tags.set(tags.get().filter((tag) => tag !== label))}
                />
              ))}
            </TagGroup>
            <HStack gap={1}>
              <Button label="Reset" onClick={() => tags.set(tagLabels)} />
              <Text style={[styles.muted]}>{`${tags.get().length} tags`}</Text>
            </HStack>
          </VStack>
        ),
      },
    ],
  };
}
