/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/feedback.tui — terminal forms for the feedback
 * components.
 *
 * Imported by the terminal target rather than by the components themselves,
 * so a web-only program never loads the glyph vocabulary, and a component
 * never has to know which targets exist.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import { Box, Clickable, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import {
  Badge,
  KeyHint,
  ProgressBar,
  Spinner,
  SPINNER_FRAMES,
  Tag,
} from 'internal:ui/components/feedback';
import type {
  BadgeProps,
  KeyHintProps,
  ProgressBarProps,
  SpinnerProps,
  TagProps,
} from 'internal:ui/components/feedback';
import type { VNode } from 'fino:ui';

mapRenderTargetLowering(Badge, 'tui', (props: BadgeProps): VNode => {
  const { label, variant, ...rest } = props;
  return (
    <Text style={[styles[variant ?? 'accent'], styles.inverse]} {...rest}>{` ${label} `}</Text>
  );
});

mapRenderTargetLowering(Spinner, 'tui', (props: SpinnerProps): VNode => {
  const { tick, frames, ...rest } = props;
  const set = frames !== undefined && frames.length > 0 ? frames : SPINNER_FRAMES;
  const frame = set[(((tick ?? 0) % set.length) + set.length) % set.length]!;
  return (
    <Text style={[styles.accent]} {...rest}>
      {frame}
    </Text>
  );
});

mapRenderTargetLowering(ProgressBar, 'tui', (props: ProgressBarProps): VNode => {
  const { value, width, showPercent, id, ...rest } = props;
  const cells = Math.max(1, width ?? 20);
  const fraction = Math.max(0, Math.min(1, value));
  const filled = Math.round(fraction * cells);
  return (
    <Box direction="row" id={id} {...rest}>
      <Text style={[styles.accent]}>{'█'.repeat(filled)}</Text>
      <Text style={[styles.muted]}>{'░'.repeat(cells - filled)}</Text>
      {showPercent ? <Text style={[styles.dim]}>{` ${Math.round(fraction * 100)}%`}</Text> : null}
    </Box>
  );
});

mapRenderTargetLowering(KeyHint, 'tui', (props: KeyHintProps): VNode => {
  const { keys, separator, id, ...rest } = props;
  const sep = separator ?? ' · ';
  const parts: VNode[] = [];
  keys.forEach((hint, index) => {
    if (index > 0) {
      parts.push(
        <Text key={`s${index}`} style={[styles.dim]}>
          {sep}
        </Text>,
      );
    }
    parts.push(
      <Text key={`k${index}`} style={[styles.bold]}>
        {hint.key}
      </Text>,
    );
    parts.push(<Text key={`l${index}`} style={[styles.dim]}>{` ${hint.label}`}</Text>);
  });
  return (
    <Box direction="row" id={id} {...rest}>
      {parts}
    </Box>
  );
});

mapRenderTargetLowering(Tag, 'tui', (props: TagProps): VNode => {
  const { label, onRemove, color, id, ...rest } = props;
  const swatch = styles[color ?? 'accent'];
  return (
    <Box direction="row" id={id} {...rest}>
      <Text style={[swatch, styles.inverse]}>{` ${label} `}</Text>
      {onRemove ? (
        <Clickable
          id={id !== undefined ? `${id}:remove` : undefined}
          focusable={false}
          onClick={onRemove}
        >
          <Text style={[swatch, styles.inverse]}>{'× '}</Text>
        </Clickable>
      ) : null}
    </Box>
  );
});
