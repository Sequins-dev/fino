/**
 * fino:tty/style — terminal text appearance as data.
 *
 * A `Style` is a fully-resolved cell appearance: colors and attributes, with
 * every absent field meaning "terminal default". Styles are plain data, never
 * escape sequences — SGR bytes exist only at the wire edge, produced by
 * `styleToSgr()` as a minimal transition between two styles.
 *
 * Styles are interned: `internStyle()` returns a canonical object per distinct
 * appearance, so equality on interned styles is a pointer compare. The layout
 * and paint pipeline in `fino:tty/tui` relies on this when compacting adjacent
 * cells into styled runs.
 *
 * ```ts
 * import { internStyle, styleToSgr, EMPTY_STYLE } from 'fino:tty/style';
 *
 * const accent = internStyle({ fg: 'cyan', bold: true });
 * const open = styleToSgr(EMPTY_STYLE, accent); // '\x1b[1;36m'
 * const close = styleToSgr(accent, EMPTY_STYLE); // '\x1b[0m'
 * ```
 */

/**
 * The sixteen standard palette colors plus `default`, the terminal's own
 * foreground or background.
 */
export type NamedColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'
  | 'default';

/**
 * A terminal color: a named palette entry, a 256-color index, or a truecolor
 * triple.
 */
export type Color =
  | NamedColor
  | { readonly ansi256: number }
  | { readonly rgb: readonly [number, number, number] };

/**
 * A fully-resolved cell appearance. Absent fields mean "terminal default";
 * an explicit `false` means the attribute is off (which matters when merging).
 */
export interface Style {
  readonly fg?: Color;
  readonly bg?: Color;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  readonly strike?: boolean;
}

const ATTRS = ['bold', 'dim', 'italic', 'underline', 'inverse', 'strike'] as const;

function colorKey(color: Color | undefined): string {
  if (color === undefined) return '';
  if (typeof color === 'string') return color;
  if ('ansi256' in color) return `i${color.ansi256}`;
  return `r${color.rgb[0]},${color.rgb[1]},${color.rgb[2]}`;
}

function styleKey(style: Style): string {
  let key = colorKey(style.fg) + '/' + colorKey(style.bg);
  for (const attr of ATTRS) key += style[attr] ? '1' : '0';
  return key;
}

const interned = new Map<string, Style>();
const INTERN_LIMIT = 4096;

/** The default appearance: every field absent. */
export const EMPTY_STYLE: Style = Object.freeze({});
interned.set(styleKey(EMPTY_STYLE), EMPTY_STYLE);

/**
 * Return the canonical object for a style, so that two styles describing the
 * same appearance are `===`. Attributes set to `false` normalize to absent.
 *
 * The intern table is bounded; a program generating unbounded distinct styles
 * (say, per-pixel truecolor) resets it rather than growing without limit,
 * which only costs the pointer-equality fast path, never correctness.
 */
export function internStyle(style: Style): Style {
  const key = styleKey(style);
  const existing = interned.get(key);
  if (existing) return existing;
  if (interned.size >= INTERN_LIMIT) {
    interned.clear();
    interned.set(styleKey(EMPTY_STYLE), EMPTY_STYLE);
  }
  const canonical: { -readonly [K in keyof Style]: Style[K] } = {};
  if (style.fg !== undefined) canonical.fg = style.fg;
  if (style.bg !== undefined) canonical.bg = style.bg;
  for (const attr of ATTRS) if (style[attr]) canonical[attr] = true;
  const frozen = Object.freeze(canonical);
  interned.set(key, frozen);
  return frozen;
}

/** Whether two styles describe the same appearance. */
export function styleEquals(a: Style, b: Style): boolean {
  return a === b || styleKey(a) === styleKey(b);
}

/** Whether two colors are the same. */
export function colorEquals(a: Color | undefined, b: Color | undefined): boolean {
  return a === b || colorKey(a) === colorKey(b);
}

/**
 * Layer `over` on top of `under`: absent fields inherit, explicit `false`
 * turns an attribute off, and a set color replaces. Returns an interned style.
 */
export function mergeStyle(under: Style, over: Style): Style {
  const merged: { -readonly [K in keyof Style]: Style[K] } = {};
  const fg = over.fg ?? under.fg;
  const bg = over.bg ?? under.bg;
  if (fg !== undefined) merged.fg = fg;
  if (bg !== undefined) merged.bg = bg;
  for (const attr of ATTRS) {
    const value = over[attr] ?? under[attr];
    if (value) merged[attr] = true;
  }
  return internStyle(merged);
}

const FG_CODES: Record<NamedColor, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
  default: 39,
};

function colorCodes(color: Color, background: boolean): number[] {
  const offset = background ? 10 : 0;
  if (typeof color === 'string') return [FG_CODES[color] + offset];
  if ('ansi256' in color) return [38 + offset, 5, color.ansi256];
  return [38 + offset, 2, color.rgb[0], color.rgb[1], color.rgb[2]];
}

function anySet(style: Style): boolean {
  if (style.fg !== undefined || style.bg !== undefined) return true;
  for (const attr of ATTRS) if (style[attr]) return true;
  return false;
}

/**
 * The minimal SGR sequence that changes a cell painted in `from` to paint in
 * `to`. Returns `''` when the styles are equal. Transitioning to the default
 * appearance emits a bare reset.
 */
export function styleToSgr(from: Style, to: Style): string {
  if (styleEquals(from, to)) return '';
  if (!anySet(to)) return '\x1b[0m';
  const codes: number[] = [];
  if ((from.bold && !to.bold) || (from.dim && !to.dim)) {
    codes.push(22);
    if (to.bold) codes.push(1);
    if (to.dim) codes.push(2);
  } else {
    if (to.bold && !from.bold) codes.push(1);
    if (to.dim && !from.dim) codes.push(2);
  }
  if (to.italic && !from.italic) codes.push(3);
  else if (from.italic && !to.italic) codes.push(23);
  if (to.underline && !from.underline) codes.push(4);
  else if (from.underline && !to.underline) codes.push(24);
  if (to.inverse && !from.inverse) codes.push(7);
  else if (from.inverse && !to.inverse) codes.push(27);
  if (to.strike && !from.strike) codes.push(9);
  else if (from.strike && !to.strike) codes.push(29);
  if (!colorEquals(from.fg, to.fg)) codes.push(...colorCodes(to.fg ?? 'default', false));
  if (!colorEquals(from.bg, to.bg)) codes.push(...colorCodes(to.bg ?? 'default', true));
  if (codes.length === 0) return '';
  return `\x1b[${codes.join(';')}m`;
}

/**
 * Whether a terminal's `COLORTERM` environment value indicates truecolor
 * (24-bit RGB) support. A small pure predicate rather than an env lookup
 * inline at call sites, so detection is unit-testable without touching
 * process state and callers stay explicit about where the value came from —
 * e.g. `supportsTruecolor(env.COLORTERM)` from `fino:process`.
 */
export function supportsTruecolor(colorterm: string | undefined): boolean {
  return colorterm === 'truecolor' || colorterm === '24bit';
}

// The 6-step xterm color cube axis values (indices 0-5 of each of the r/g/b
// axes in the 216-color cube spanning ansi256 indices 16-231).
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

function nearestCubeStep(value: number): number {
  let closest = 0;
  let closestDist = Infinity;
  for (let i = 0; i < CUBE_STEPS.length; i++) {
    const dist = Math.abs(CUBE_STEPS[i]! - value);
    if (dist < closestDist) {
      closestDist = dist;
      closest = i;
    }
  }
  return closest;
}

/**
 * Map a truecolor RGB triple (0-255 each) to the closest xterm 256-color
 * palette index, for terminals that report no truecolor support. Checks both
 * the 6×6×6 color cube (indices 16-231) and the 24-step grayscale ramp
 * (232-255) and returns whichever is closer by squared Euclidean distance.
 *
 * ```ts no_run
 * nearestAnsi256(0, 0, 0);       // 16 — pure black, the cube's black corner
 * nearestAnsi256(255, 255, 255); // 231 — pure white, the cube's white corner
 * nearestAnsi256(128, 128, 128); // a grayscale-ramp index — nearer to gray than any cube step
 * ```
 */
export function nearestAnsi256(r: number, g: number, b: number): number {
  const cr = nearestCubeStep(r);
  const cg = nearestCubeStep(g);
  const cb = nearestCubeStep(b);
  const cubeR = CUBE_STEPS[cr]!;
  const cubeG = CUBE_STEPS[cg]!;
  const cubeB = CUBE_STEPS[cb]!;
  const cubeDist = (r - cubeR) ** 2 + (g - cubeG) ** 2 + (b - cubeB) ** 2;
  const cubeIndex = 16 + 36 * cr + 6 * cg + cb;

  const gray = Math.round((r + g + b) / 3);
  const grayIndex = Math.max(0, Math.min(23, Math.round((gray - 8) / 10)));
  const grayValue = 8 + grayIndex * 10;
  const grayDist = (r - grayValue) ** 2 + (g - grayValue) ** 2 + (b - grayValue) ** 2;

  return grayDist < cubeDist ? 232 + grayIndex : cubeIndex;
}

const FG_NAMES = new Map<number, NamedColor>(
  (Object.entries(FG_CODES) as Array<[NamedColor, number]>).map(([name, code]) => [code, name]),
);

/**
 * Apply one SGR parameter list (the numbers of a `CSI ... m` sequence) to a
 * style, returning the interned result. Unknown parameters are ignored.
 */
export function applySgr(style: Style, params: readonly number[]): Style {
  const next: { -readonly [K in keyof Style]: Style[K] } = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      for (const key of Object.keys(next) as Array<keyof Style>) delete next[key];
    } else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.inverse = true;
    else if (p === 9) next.strike = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p === 27) delete next.inverse;
    else if (p === 29) delete next.strike;
    else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) next.fg = FG_NAMES.get(p);
    else if (p === 39) delete next.fg;
    else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) next.bg = FG_NAMES.get(p - 10);
    else if (p === 49) delete next.bg;
    else if (p === 38 || p === 48) {
      const target: 'fg' | 'bg' = p === 38 ? 'fg' : 'bg';
      const mode = params[i + 1];
      if (mode === 5 && params.length > i + 2) {
        next[target] = { ansi256: params[i + 2]! };
        i += 2;
      } else if (mode === 2 && params.length > i + 4) {
        next[target] = { rgb: [params[i + 2]!, params[i + 3]!, params[i + 4]!] };
        i += 4;
      } else {
        break;
      }
    }
  }
  return internStyle(next);
}
