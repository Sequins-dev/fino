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
import { createSignal, mapRenderTargetLowering } from 'fino:ui';
import { timeout as loopTimeout } from 'internal:runtime/loop';
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

/**
 * One clock, shared by every spinner.
 *
 * A spinner is the only component whose appearance changes without its props
 * changing, so it cannot be driven the way everything else is. Every spinner
 * with no pinned `tick` reads this one signal, which both selects the frame
 * and — because a root re-renders whatever it read — repaints all of them
 * together off a single timer. Ten spinners cost one timer, not ten.
 *
 * The loop only runs while a live terminal app exists *and* a spinner asked
 * for it. A one-shot `renderFrame` therefore never starts a timer for a frame
 * it has already painted, and an app showing no spinner does not wake up.
 * Restarting is the spinner's job rather than the app's: whenever a lowering
 * pass wants a frame it calls `ensureClock()`, so a loop that ends for any
 * reason is started again by the next render instead of leaving the spinner
 * frozen until the app restarts.
 */
const FRAME_MS = 80;
const clock = createSignal(0);
let wanted = false;
let ticking = false;
let liveApps = 0;

function ensureClock(): void {
  if (ticking || liveApps === 0) return;
  ticking = true;
  void (async (): Promise<void> => {
    try {
      while (liveApps > 0 && wanted) {
        await loopTimeout(FRAME_MS);
        if (liveApps === 0) break;
        // Cleared before the write: the re-render it triggers sets it again
        // if any spinner is still on screen, and leaves it false if none is.
        wanted = false;
        clock.set(clock.get() + 1);
      }
    } finally {
      ticking = false;
    }
  })();
}

/**
 * Register a live terminal app, returning its release function.
 *
 * The clock is bounded by app lifetime so nothing keeps the event loop awake
 * after the last app stops.
 */
export function holdSpinnerClock(): () => void {
  liveApps += 1;
  ensureClock();
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    liveApps -= 1;
  };
}

mapRenderTargetLowering(Badge, 'tui', (props: BadgeProps): VNode => {
  const { label, variant, ...rest } = props;
  return (
    <Text style={[styles[variant ?? 'accent'], styles.inverse]} {...rest}>{` ${label} `}</Text>
  );
});

mapRenderTargetLowering(Spinner, 'tui', (props: SpinnerProps): VNode => {
  const { tick, frames, ...rest } = props;
  const set = frames !== undefined && frames.length > 0 ? frames : SPINNER_FRAMES;
  let index: number;
  if (tick === undefined) {
    wanted = true;
    ensureClock();
    index = clock.get();
  } else {
    index = tick;
  }
  const frame = set[((index % set.length) + set.length) % set.length]!;
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
