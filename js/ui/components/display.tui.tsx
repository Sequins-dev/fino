/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/display.tui — terminal forms for cards, stats, status dots, empty states.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, VNode } from 'fino:ui';
import { Box, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import type { Style } from 'fino:tty/style';
import { iconForm } from 'internal:ui/components/icons';
import { Card, EmptyState, Stat, StatusDot } from 'internal:ui/components/display';
import type { Trend } from 'internal:ui/components/display';
import type {
  CardProps,
  EmptyStateProps,
  StatProps,
  StatusDotProps,
} from 'internal:ui/components/display';

const STATUS_TONE: Record<StatusDotStatus, Style> = {
  ok: styles.success,
  busy: styles.info,
  error: styles.danger,
  idle: styles.muted,
  warning: styles.warning,
};

const TREND_GLYPH: Record<Trend, string> = { up: '▲', down: '▼', flat: '–' };
const TREND_TONE: Record<Trend, Style> = {
  up: styles.success,
  down: styles.danger,
  flat: styles.muted,
};

mapRenderTargetLowering(Card, 'tui', (all: CardProps): VNode => {
  const { children = [], ...props } = all as CardProps & { children?: NormalizedChild[] };
  const { title, subtitle, image, actions, id, ...rest } = props;
  return (
    <Box border direction="column" paddingX={1} id={id} {...rest}>
      {image !== undefined ? <Text style={[styles.dim]}>{`[ ${image.alt} ]`}</Text> : null}
      {title !== undefined ? <Text bold>{title}</Text> : null}
      {subtitle !== undefined ? <Text style={[styles.dim]}>{subtitle}</Text> : null}
      {children}
      {actions !== undefined ? (
        <Box direction="row" gap={1} justify="end">
          {actions}
        </Box>
      ) : null}
    </Box>
  );
});

mapRenderTargetLowering(Stat, 'tui', (all: StatProps): VNode => {
  const { children = [], ...props } = all as StatProps & { children?: NormalizedChild[] };
  const { label, value, hint, trend, id, ...rest } = props;
  return (
    <Box direction="column" id={id} {...rest}>
      <Text style={[styles.dim]}>{label}</Text>
      <Box direction="row" gap={1}>
        <Text bold>{value}</Text>
        {trend !== undefined ? <Text style={[TREND_TONE[trend]]}>{TREND_GLYPH[trend]}</Text> : null}
      </Box>
      {hint !== undefined ? <Text style={[styles.dim]}>{hint}</Text> : null}
    </Box>
  );
});

mapRenderTargetLowering(StatusDot, 'tui', (all: StatusDotProps): VNode => {
  const { children = [], ...props } = all as StatusDotProps & { children?: NormalizedChild[] };
  const { status, label, id, ...rest } = props;
  return (
    <Box direction="row" gap={1} id={id} {...rest}>
      <Text style={[STATUS_TONE[status]]}>●</Text>
      {label !== undefined ? <Text>{label}</Text> : null}
    </Box>
  );
});

mapRenderTargetLowering(EmptyState, 'tui', (all: EmptyStateProps): VNode => {
  const { children = [], ...props } = all as EmptyStateProps & { children?: NormalizedChild[] };
  const { icon, title, description, action, icons, id, ...rest } = props;
  return (
    <Box direction="column" align="center" justify="center" gap={1} id={id} {...rest}>
      {icon !== undefined ? <Text style={[styles.dim]}>{iconForm(icon, 'tui', icons)}</Text> : null}
      <Text bold align="center">
        {title}
      </Text>
      {description !== undefined ? (
        <Text style={[styles.dim]} align="center">
          {description}
        </Text>
      ) : null}
      {action !== undefined ? (
        <Box direction="row" justify="center">
          {action}
        </Box>
      ) : null}
    </Box>
  );
});
