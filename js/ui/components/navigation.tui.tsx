/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/navigation.tui — terminal forms for breadcrumbs,
 * pagers, and step strips.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, VNode } from 'fino:ui';
import { Box, Clickable, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { Breadcrumbs, Pagination, Steps, paginationRange } from 'internal:ui/components/navigation';
import type {
  BreadcrumbsProps,
  PaginationProps,
  StepsProps,
} from 'internal:ui/components/navigation';

mapRenderTargetLowering(Breadcrumbs, 'tui', (all: BreadcrumbsProps): VNode => {
  const { children = [], ...props } = all as BreadcrumbsProps & { children?: NormalizedChild[] };
  const { items, onNavigate, id, ...rest } = props;
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      {items.flatMap((item, index) => {
        const node =
          index === items.length - 1 ? (
            <Text key={item.key} style={[styles.bold]}>
              {item.label}
            </Text>
          ) : (
            <Clickable
              key={item.key}
              id={id !== undefined ? `${id}:${item.key}` : undefined}
              focusable={false}
              onClick={onNavigate ? () => onNavigate(item.key) : undefined}
            >
              <Text style={[styles.dim]}>{item.label}</Text>
            </Clickable>
          );
        const separator = (
          <Text key={`sep:${item.key}`} style={[styles.dim]}>
            /
          </Text>
        );
        return index > 0 ? [separator, node] : [node];
      })}
    </Box>
  );
});

mapRenderTargetLowering(Pagination, 'tui', (all: PaginationProps): VNode => {
  const { children = [], ...props } = all as PaginationProps & { children?: NormalizedChild[] };
  const { page, pages, onChange, siblings, id, ...rest } = props;
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  const atStart = current <= 1;
  const atEnd = current >= total;
  const range = paginationRange(current, total, siblings);
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      <Clickable
        id={id !== undefined ? `${id}:prev` : undefined}
        focusable={false}
        disabled={atStart}
        onClick={atStart ? undefined : () => onChange(current - 1)}
      >
        <Text style={atStart ? [styles.dim] : [styles.accent]}>‹</Text>
      </Clickable>
      {range.map((entry, index) =>
        entry === 'ellipsis' ? (
          <Text key={`ellipsis:${index}`} style={[styles.dim]}>
            …
          </Text>
        ) : (
          <Clickable
            key={String(entry)}
            id={id !== undefined ? `${id}:${entry}` : undefined}
            focusable={false}
            disabled={entry === current}
            onClick={entry === current ? undefined : () => onChange(entry)}
          >
            <Text style={entry === current ? [styles.bold, styles.accent] : [styles.dim]}>
              {String(entry)}
            </Text>
          </Clickable>
        ),
      )}
      <Clickable
        id={id !== undefined ? `${id}:next` : undefined}
        focusable={false}
        disabled={atEnd}
        onClick={atEnd ? undefined : () => onChange(current + 1)}
      >
        <Text style={atEnd ? [styles.dim] : [styles.accent]}>›</Text>
      </Clickable>
    </Box>
  );
});

mapRenderTargetLowering(Steps, 'tui', (all: StepsProps): VNode => {
  const { children = [], ...props } = all as StepsProps & { children?: NormalizedChild[] };
  const { steps: entries, current, id, ...rest } = props;
  const at = entries.findIndex((step) => step.key === current);
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      {entries.flatMap((step, index) => {
        const state = at !== -1 && index < at ? 'done' : index === at ? 'current' : 'upcoming';
        const dot = (
          <Text
            key={`d:${step.key}`}
            style={
              state === 'done'
                ? [styles.success]
                : state === 'current'
                  ? [styles.bold, styles.accent]
                  : [styles.dim]
            }
          >
            {state === 'upcoming' ? '○' : '●'}
          </Text>
        );
        const label = (
          <Text
            key={`l:${step.key}`}
            style={state === 'current' ? [styles.bold] : state === 'upcoming' ? [styles.dim] : []}
          >
            {step.label}
          </Text>
        );
        const joint = (
          <Text key={`j:${step.key}`} style={[styles.dim]}>
            ──
          </Text>
        );
        return index > 0 ? [joint, dot, label] : [dot, label];
      })}
    </Box>
  );
});
