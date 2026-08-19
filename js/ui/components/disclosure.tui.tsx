/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/disclosure.tui — terminal forms for expanders, details, and tab strips.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, VNode } from 'fino:ui';
import { Box, Clickable, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { iconForm } from 'internal:ui/components/icons';
import { Details, Expander, TabList, Tabs } from 'internal:ui/components/disclosure';
import type {
  DetailsProps,
  ExpanderProps,
  TabListProps,
  TabsProps,
} from 'internal:ui/components/disclosure';

mapRenderTargetLowering(Expander, 'tui', (all: ExpanderProps): VNode => {
  const { children = [], ...props } = all as ExpanderProps & { children?: NormalizedChild[] };
  const { open, onToggle, disabled, id, style, ...rest } = props;
  const glyph = iconForm(open ? 'chevron-down' : 'chevron-right', 'tui');
  if (onToggle === undefined) {
    return (
      <Text id={id} style={style} {...rest}>
        {glyph}
      </Text>
    );
  }
  return (
    <Clickable
      id={id}
      focusable={false}
      disabled={disabled}
      onClick={() => onToggle(!open)}
      {...rest}
    >
      <Text style={style}>{glyph}</Text>
    </Clickable>
  );
});

mapRenderTargetLowering(Details, 'tui', (all: DetailsProps): VNode => {
  const { children = [], ...props } = all as DetailsProps & { children?: NormalizedChild[] };
  const { title, open, onToggle, expander, focused, id, ...rest } = props;
  const where = expander ?? 'start';
  const summaryStyle = focused ? [styles.bold, styles.accent] : [styles.bold];
  const marker = <Expander open={open} style={summaryStyle} />;
  return (
    <Box direction="column" {...rest}>
      <Clickable
        id={id}
        direction="row"
        gap={1}
        onClick={onToggle ? () => onToggle(!open) : undefined}
      >
        {where === 'start' ? marker : null}
        <Text style={summaryStyle}>{title}</Text>
        {where === 'end' ? marker : null}
      </Clickable>
      {open ? (
        <Box direction="column" paddingX={2}>
          {children}
        </Box>
      ) : null}
    </Box>
  );
});

mapRenderTargetLowering(TabList, 'tui', (all: TabListProps): VNode => {
  const { children = [], ...props } = all as TabListProps & { children?: NormalizedChild[] };
  const { items, value, onChange, id, ...rest } = props;
  return (
    <Box direction="row" gap={2} {...rest}>
      {items.map((item) => (
        <Clickable
          key={item.key}
          id={id !== undefined ? `${id}:${item.key}` : undefined}
          disabled={item.disabled}
          onClick={onChange && item.key !== value ? () => onChange(item.key) : undefined}
        >
          <Text
            style={
              item.disabled
                ? [styles.dim]
                : item.key === value
                  ? [styles.bold, styles.underline]
                  : [styles.dim]
            }
          >
            {item.label}
          </Text>
        </Clickable>
      ))}
    </Box>
  );
});

mapRenderTargetLowering(Tabs, 'tui', (all: TabsProps): VNode => {
  const { children = [], ...props } = all as TabsProps & { children?: NormalizedChild[] };
  const rest = props;
  return (
    <Box direction="column" gap={1}>
      <TabList {...rest} />
      <Box direction="column">{children}</Box>
    </Box>
  );
});
