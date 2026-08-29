/** Terminal lowerings for navigation components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { Box, Clickable, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { Breadcrumbs, Pagination, Steps, paginationRange } from 'internal:ui/components/navigation';
import { mapComponentLowering } from 'internal:ui/components/target';

mapComponentLowering(Breadcrumbs, 'tui', (props) => {
  const { items, onNavigate, id, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: 'row', gap: 1, id } as Props,
    ...items.flatMap((item, index) => {
      const node: VNode =
        index === items.length - 1
          ? h(Text, { key: item.key, style: [styles.bold] }, item.label)
          : h(
              Clickable,
              {
                key: item.key,
                id: id === undefined ? undefined : `${id}:${item.key}`,
                focusable: false,
                onClick: onNavigate === undefined ? undefined : () => onNavigate(item.key),
              },
              h(Text, { style: [styles.dim] }, item.label),
            );
      return index === 0
        ? [node]
        : [h(Text, { key: `sep:${item.key}`, style: [styles.dim] }, '/'), node];
    }),
  );
});

mapComponentLowering(Pagination, 'tui', (props) => {
  const { page, pages, onChange, siblings, id, ...rest } = props;
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  const range = paginationRange(current, total, siblings);
  const step = (target: number, label: string, disabled: boolean, key: string): VNode =>
    h(
      Clickable,
      {
        key,
        id: id === undefined ? undefined : `${id}:${key}`,
        focusable: false,
        disabled,
        onClick: disabled || onChange === undefined ? undefined : () => onChange(target),
      },
      h(Text, { style: disabled ? [styles.dim] : [styles.accent] }, label),
    );
  return h(
    Box,
    { ...rest, direction: 'row', gap: 1, id } as Props,
    step(current - 1, '‹', current === 1, 'prev'),
    ...range.map((entry, index) =>
      entry === 'ellipsis'
        ? h(Text, { key: `e:${index}`, style: [styles.dim] }, '…')
        : step(entry, String(entry), entry === current, String(entry)),
    ),
    step(current + 1, '›', current === total, 'next'),
  );
});

mapComponentLowering(Steps, 'tui', (props) => {
  const { steps: entries, current, id, ...rest } = props;
  const at = entries.findIndex((step) => step.key === current);
  return h(
    Box,
    { ...rest, direction: 'row', gap: 1, id } as Props,
    ...entries.flatMap((step, index) => {
      const state = at !== -1 && index < at ? 'done' : index === at ? 'current' : 'upcoming';
      const style =
        state === 'done'
          ? [styles.success]
          : state === 'current'
            ? [styles.bold, styles.accent]
            : [styles.dim];
      const parts: VNode[] = [];
      if (index > 0) parts.push(h(Text, { key: `j:${step.key}`, style: [styles.dim] }, '──'));
      parts.push(
        h(Text, { key: `d:${step.key}`, style }, state === 'upcoming' ? '○' : '●'),
        h(
          Text,
          {
            key: `l:${step.key}`,
            style: state === 'current' ? [styles.bold] : state === 'upcoming' ? [styles.dim] : [],
          },
          step.label,
        ),
      );
      return parts;
    }),
  );
});
