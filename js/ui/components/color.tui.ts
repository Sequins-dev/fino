/** Shared terminal color adaptation for component lowerings. @internal */
import { nearestAnsi256 } from 'fino:tty/style';
import type { Color } from 'fino:tty/style';

/** Adapt an RGB tuple to truecolor or its nearest xterm-256 fallback. */
export function terminalColor(rgb: readonly [number, number, number], truecolor: boolean): Color {
  const [r, g, b] = rgb.map((value) => Math.max(0, Math.min(255, Math.round(value)))) as [
    number,
    number,
    number,
  ];
  return truecolor ? { rgb: [r, g, b] } : { ansi256: nearestAnsi256(r, g, b) };
}
