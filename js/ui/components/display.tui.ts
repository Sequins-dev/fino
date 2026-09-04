/** Terminal lowerings for display components. @internal */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { Box, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import type { Style } from 'fino:tty/style';
import { Card, EmptyState, Stat, StatusDot } from 'internal:ui/components/display';
import type { StatusDotStatus, Trend } from 'internal:ui/components/display';
import { iconForm } from 'internal:ui/components/icons';
import { mapComponentLowering } from 'internal:ui/components/target';

const STATUS_STYLE: Record<StatusDotStatus, Style> = {
  ok: styles.success,
  busy: styles.info,
  error: styles.danger,
  idle: styles.muted,
  warning: styles.warning,
};
const TREND_GLYPH: Record<Trend, string> = { up: '▲', down: '▼', flat: '–' };
const TREND_STYLE: Record<Trend, Style> = {
  up: styles.success,
  down: styles.danger,
  flat: styles.muted,
};

mapComponentLowering(Card, 'tui', (props, children) => {
  const { title, subtitle, image, actions, id, ...rest } = props;
  return h(
    Box,
    { ...rest, border: true, direction: 'column', paddingX: 1, id } as Props,
    image === undefined ? null : h(Text, { style: [styles.dim] }, `[ ${image.alt} ]`),
    title === undefined ? null : h(Text, { bold: true }, title),
    subtitle === undefined ? null : h(Text, { style: [styles.dim] }, subtitle),
    ...children,
    actions === undefined ? null : h(Box, { direction: 'row', gap: 1, justify: 'end' }, actions),
  );
});

mapComponentLowering(Stat, 'tui', (props) => {
  const { label, value, hint, trend, id, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: 'column', id } as Props,
    h(Text, { style: [styles.dim] }, label),
    h(
      Box,
      { direction: 'row', gap: 1 },
      h(Text, { bold: true }, value),
      trend === undefined ? null : h(Text, { style: [TREND_STYLE[trend]] }, TREND_GLYPH[trend]),
    ),
    hint === undefined ? null : h(Text, { style: [styles.dim] }, hint),
  );
});

mapComponentLowering(StatusDot, 'tui', (props) => {
  const { status, label, id, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: 'row', gap: 1, id } as Props,
    h(Text, { style: [STATUS_STYLE[status]] }, '●'),
    label === undefined ? null : h(Text, null, label),
  );
});

mapComponentLowering(EmptyState, 'tui', (props) => {
  const { icon, title, description, action, icons, id, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: 'column', align: 'center', justify: 'center', gap: 1, id } as Props,
    icon === undefined ? null : h(Text, { style: [styles.dim] }, iconForm(icon, 'tui', icons)),
    h(Text, { bold: true, align: 'center' }, title),
    description === undefined
      ? null
      : h(Text, { style: [styles.dim], align: 'center' }, description),
    action === undefined ? null : h(Box, { direction: 'row', justify: 'center' }, action),
  );
});
