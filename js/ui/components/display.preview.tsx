/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/display.preview — preview previews for cards, stats, status dots, and empty states.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/preview` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import { sessions } from 'fino:net/http/app';
import {
  Box,
  Button,
  Card,
  EmptyState,
  FloatingActionBar,
  HStack,
  HoverCard,
  Stat,
  StatusDot,
  Text,
  VStack,
  styles,
} from 'fino:ui/components';
import type { StatusDotStatus, Trend } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

const STATUS_DOT_VALUES: StatusDotStatus[] = ['ok', 'busy', 'error', 'idle', 'warning'];

export function displayPreviews(): PreviewGroup {
  const cardSynced = createSignal(0);
  const emptyCleared = createSignal(0);
  return {
    title: 'Display',
    previews: [
      {
        key: 'card',
        name: 'Card',
        controls: {
          withImage: { type: 'boolean', label: 'Image', default: true },
        },
        view: (args) => (
          <Card
            title="Notebook sync"
            subtitle="Last synced 2 minutes ago"
            image={
              args.withImage === true
                ? { src: 'https://fino.dev/img/notebook.png', alt: 'Notebook cover art' }
                : undefined
            }
            actions={[
              <Button key="dismiss" label="Dismiss" onClick={() => {}} />,
              <Button
                key="sync"
                label="Sync now"
                onClick={() => cardSynced.set(cardSynced.get() + 1)}
              />,
            ]}
          >
            <VStack gap={0}>
              <Text style={[styles.muted]}>Changes sync automatically every five minutes.</Text>
              <Text style={[styles.dim]}>{`synced ${cardSynced.get()} times`}</Text>
            </VStack>
          </Card>
        ),
      },
      {
        key: 'stat',
        name: 'Stat',
        controls: {
          trend: { type: 'select', options: ['up', 'down', 'flat', 'none'], default: 'up' },
        },
        view: (args) => (
          <HStack gap={3}>
            <Stat
              label="Active sessions"
              value="1,204"
              hint="last 24h"
              trend={args.trend === 'none' ? undefined : (args.trend as Trend)}
            />
            <Stat label="Error rate" value="0.4%" trend="down" />
            <Stat label="Queue depth" value="12" />
          </HStack>
        ),
      },
      {
        key: 'status-dot',
        name: 'StatusDot',
        controls: {
          status: { type: 'select', options: [...STATUS_DOT_VALUES], default: 'ok' },
        },
        view: (args) => (
          <VStack gap={1}>
            <StatusDot status={args.status as StatusDotStatus} label={String(args.status)} />
            <HStack gap={2}>
              {STATUS_DOT_VALUES.map((status) => (
                <StatusDot key={status} status={status} label={status} />
              ))}
            </HStack>
          </VStack>
        ),
      },
      {
        key: 'empty-state',
        name: 'EmptyState',
        view: () => (
          <VStack gap={1}>
            <Box border width={40} height={10}>
              <EmptyState
                grow={1}
                icon="doc"
                title="No results"
                description="Try a different search term."
                action={
                  <Button
                    label="Clear filters"
                    onClick={() => emptyCleared.set(emptyCleared.get() + 1)}
                  />
                }
              />
            </Box>
            <Text style={[styles.muted]}>{`cleared ${emptyCleared.get()} times`}</Text>
          </VStack>
        ),
      },
      {
        key: 'hover-card',
        name: 'HoverCard',
        controls: {
          open: { type: 'boolean', default: true },
        },
        view: (args) => (
          <VStack gap={1}>
            <Text id="hover-card-anchor">Release 1.4.0 (anchor)</Text>
            <HoverCard open={args.open === true} anchorId="hover-card-anchor" title="Release 1.4.0">
              <Text>Adds the Display component group: Card, Stat, StatusDot, and more.</Text>
              <Text style={[styles.dim]}>Shipped 2 days ago</Text>
            </HoverCard>
          </VStack>
        ),
      },
      {
        key: 'floating-action-bar',
        name: 'FloatingActionBar',
        controls: {
          placement: {
            type: 'select',
            options: ['bottom-start', 'bottom-center', 'bottom-end'],
            default: 'bottom-center',
          },
        },
        view: (args) => (
          <Box
            id="fab-container"
            border
            direction="column"
            gap={1}
            width={40}
            height={8}
            padding={1}
          >
            <Text style={[styles.muted]}>Chat transcript scrolls here…</Text>
            <FloatingActionBar
              anchorId="fab-container"
              placement={args.placement as 'bottom-start' | 'bottom-center' | 'bottom-end'}
            >
              <Button label="Jump to latest" onClick={() => {}} />
            </FloatingActionBar>
          </Box>
        ),
      },
    ],
  };
}
