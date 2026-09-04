/** Terminal lowerings for disclosure components. @internal */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { Box, Clickable, Icon, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { Details, Expander, TabList, Tabs } from 'internal:ui/components/disclosure';
import { mapComponentLowering } from 'internal:ui/components/target';

mapComponentLowering(Expander, 'tui', (props) => {
  const { open, onToggle, disabled, ...rest } = props;
  const marker = h(Icon, {
    name: open ? 'chevron-down' : 'chevron-right',
    style: props.style,
  });
  if (onToggle === undefined) return h(Text, rest as Props, marker);
  return h(
    Clickable,
    {
      ...rest,
      focusable: false,
      disabled,
      onClick: disabled === true ? undefined : () => onToggle(!open),
    } as Props,
    marker,
  );
});

mapComponentLowering(Details, 'tui', (props, children) => {
  const { title, open, onToggle, expander, focused, id, ...rest } = props;
  const where = expander ?? 'start';
  const summaryStyle = focused === true ? [styles.bold, styles.accent] : [styles.bold];
  const marker = h(Expander, { open, style: summaryStyle });
  return h(
    Box,
    { ...rest, direction: 'column' } as Props,
    h(
      Clickable,
      {
        id,
        direction: 'row',
        gap: 1,
        onClick: onToggle === undefined ? undefined : () => onToggle(!open),
      },
      where === 'start' ? marker : null,
      h(Text, { style: summaryStyle }, title),
      where === 'end' ? marker : null,
    ),
    open ? h(Box, { direction: 'column', paddingX: 2 }, ...children) : null,
  );
});

mapComponentLowering(TabList, 'tui', (props) => {
  const { items, value, onChange, id, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: 'row', gap: 2 } as Props,
    ...items.map((item) =>
      h(
        Clickable,
        {
          key: item.key,
          id: id === undefined ? undefined : `${id}:${item.key}`,
          disabled: item.disabled,
          onClick:
            onChange === undefined || item.key === value || item.disabled === true
              ? undefined
              : () => onChange(item.key),
        },
        h(
          Text,
          {
            style:
              item.disabled === true
                ? [styles.dim]
                : item.key === value
                  ? [styles.bold, styles.underline]
                  : [styles.dim],
          },
          item.label,
        ),
      ),
    ),
  );
});

mapComponentLowering(Tabs, 'tui', (props, children) =>
  h(
    Box,
    { direction: 'column', gap: 1 },
    h(TabList, props),
    h(Box, { direction: 'column' }, ...children),
  ),
);
