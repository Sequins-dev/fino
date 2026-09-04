/** Terminal lowerings and the shared bounded spinner clock. @internal */
import { createSignal, h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { Box, Clickable, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { timeout as loopTimeout } from 'internal:runtime/loop';
import {
  Badge,
  KeyHint,
  ProgressBar,
  SPINNER_FRAMES,
  Spinner,
  Tag,
  normalizeProgress,
} from 'internal:ui/components/feedback';
import { mapComponentLowering } from 'internal:ui/components/target';

const FRAME_MS = 80;
const clock = createSignal(0);
let wanted = false;
let ticking = false;
let liveApps = 0;

function ensureClock(): void {
  if (ticking || liveApps === 0 || !wanted) return;
  ticking = true;
  void (async (): Promise<void> => {
    try {
      while (liveApps > 0 && wanted) {
        await loopTimeout(FRAME_MS);
        if (liveApps === 0) break;
        wanted = false;
        clock.set(clock.get() + 1);
      }
    } finally {
      ticking = false;
    }
  })();
}

/** Hold the one spinner clock for a live terminal app and return an idempotent release. */
export function holdSpinnerClock(): () => void {
  liveApps += 1;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    liveApps = Math.max(0, liveApps - 1);
  };
}

mapComponentLowering(Badge, 'tui', (props) => {
  const { label, variant, ...rest } = props;
  return h(
    Text,
    { ...rest, style: [styles[variant ?? 'accent'], styles.inverse] } as Props,
    ` ${label} `,
  );
});

mapComponentLowering(Spinner, 'tui', (props) => {
  const { tick, frames, ...rest } = props;
  const set = frames !== undefined && frames.length > 0 ? frames : SPINNER_FRAMES;
  let index = tick;
  if (index === undefined) {
    wanted = true;
    ensureClock();
    index = clock.get();
  }
  const frame = set[((index % set.length) + set.length) % set.length]!;
  return h(Text, { ...rest, style: [styles.accent] } as Props, frame);
});

mapComponentLowering(ProgressBar, 'tui', (props) => {
  const { value, width, showPercent, id, ...rest } = props;
  const cells = Math.max(1, Math.floor(width ?? 20));
  const progress = normalizeProgress(value);
  const filled = Math.round(progress.fraction * cells);
  return h(
    Box,
    { ...rest, direction: 'row', id } as Props,
    h(Text, { style: [styles.accent] }, '█'.repeat(filled)),
    h(Text, { style: [styles.muted] }, '░'.repeat(cells - filled)),
    showPercent === true ? h(Text, { style: [styles.dim] }, ` ${progress.percent}%`) : null,
  );
});

mapComponentLowering(KeyHint, 'tui', (props) => {
  const { keys, separator, id, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: 'row', id } as Props,
    ...keys.flatMap((entry, index) => [
      index === 0 ? null : h(Text, { key: `s:${index}`, style: [styles.dim] }, separator ?? ' · '),
      h(Text, { key: `k:${index}`, style: [styles.bold] }, entry.key),
      h(Text, { key: `l:${index}`, style: [styles.dim] }, ` ${entry.label}`),
    ]),
  );
});

mapComponentLowering(Tag, 'tui', (props) => {
  const { label, onRemove, color, id, ...rest } = props;
  const style = [styles[color ?? 'accent'], styles.inverse];
  return h(
    Box,
    { ...rest, direction: 'row', id } as Props,
    h(Text, { style }, ` ${label} `),
    onRemove === undefined
      ? null
      : h(
          Clickable,
          {
            id: id === undefined ? undefined : `${id}:remove`,
            focusable: false,
            onClick: onRemove,
          },
          h(Text, { style }, '× '),
        ),
  );
});
