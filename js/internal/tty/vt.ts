/**
 * VT terminal emulator: a pure state machine over a grid of styled cells.
 *
 * Feed terminal output through `write()` and query the resulting screen:
 * visible text, styled spans, scrollback, cursor position, and tracked
 * private DEC modes. The emulation semantics — DECAWM pending wrap,
 * DECSTBM scroll regions, the alternate screen, and resize anchoring —
 * are ported from the Python screen model in the PTY test harness, which
 * was validated against real terminal behavior. No I/O happens here.
 *
 * This implements the cursor, erasure, scrolling, and SGR subset of
 * [ECMA-48](https://ecma-international.org/publications-and-standards/standards/ecma-48/)
 * needed by Fino's terminal assertions, plus the documented DEC private modes
 * and OSC captures. It is not a general-purpose or byte-for-byte VT emulator;
 * unsupported control functions are consumed without affecting the grid.
 *
 * @internal
 */

import { EMPTY_STYLE, applySgr, styleToSgr } from 'fino:tty/style';
import type { Style } from 'fino:tty/style';

export interface VtCell {
  char: string;
  sgr: readonly number[];
}

export interface VtSpan {
  text: string;
  sgr: readonly number[];
}

const EMPTY_SGR: readonly number[] = Object.freeze([]);
const CSI_RE = /^\x1b\[([0-9:;<=>?]*)(?:[ -/]*)([@-~])/;
const CSI_PARTIAL_RE = /^\x1b(?:\[[0-9:;<=>? -/]*)?$/;

function styleAsSgr(style: Style): readonly number[] {
  const encoded = styleToSgr(EMPTY_STYLE, style);
  if (encoded === '') return EMPTY_SGR;
  const params = encoded.slice(2, -1).split(';').map(Number);
  return Object.freeze(params);
}

export class Terminal {
  #cols: number;
  #rows: number;
  #cells: string[][];
  #styles: (readonly number[])[][];
  #cx = 0;
  #cy = 0;
  #style: Style = EMPTY_STYLE;
  #sgr: readonly number[] = EMPTY_SGR;
  #pending = '';
  #top: number;
  #bottom: number;
  #saved: readonly [number, number] | null = null;
  #scrolled: string[] = [];
  #modes = new Set<number>([7, 25]);
  #alt = false;
  #primary: {
    cells: string[][];
    styles: (readonly number[])[][];
    cx: number;
    cy: number;
  } | null = null;
  // DECAWM defers the wrap until the next printable char, so a write that
  // exactly fills a row leaves the cursor parked in the last column.
  #wrapPending = false;
  #decoder = new TextDecoder();
  #osc52: string[] = [];
  #title = '';

  constructor(options: { cols: number; rows: number }) {
    assertDimensions(options.cols, options.rows);
    this.#cols = options.cols;
    this.#rows = options.rows;
    this.#cells = this.#blankGrid();
    this.#styles = this.#blankStyles();
    this.#top = 0;
    this.#bottom = this.#rows - 1;
  }

  get cols(): number {
    return this.#cols;
  }

  get rows(): number {
    return this.#rows;
  }

  get cursor(): { row: number; col: number } {
    return { row: this.#cy, col: this.#cx };
  }

  get cursorVisible(): boolean {
    return this.#modes.has(25);
  }

  set cursorVisible(on: boolean) {
    if (on) this.#modes.add(25);
    else this.#modes.delete(25);
  }

  get modes(): ReadonlySet<number> {
    return this.#modes;
  }

  get altScreen(): boolean {
    return this.#alt;
  }

  get osc52(): string[] {
    return [...this.#osc52];
  }

  get title(): string {
    return this.#title;
  }

  write(data: string | Uint8Array): void {
    const chunk = typeof data === 'string' ? data : this.#decoder.decode(data, { stream: true });
    // A write can split an escape sequence; hold the tail until it completes
    // or it would be painted to the screen as literal text.
    const s = this.#pending + chunk;
    this.#pending = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        if (s.startsWith('\x1b]', i)) {
          const bel = s.indexOf('\x07', i);
          const st = s.indexOf('\x1b\\', i);
          let end: number;
          let next: number;
          if (st !== -1 && (bel === -1 || st < bel)) {
            end = st;
            next = st + 2;
          } else if (bel !== -1) {
            end = bel;
            next = bel + 1;
          } else {
            this.#pending = s.slice(i);
            return;
          }
          this.#osc(s.slice(i + 2, end));
          i = next;
          continue;
        }
        const m = CSI_RE.exec(s.slice(i));
        if (!m) {
          if (CSI_PARTIAL_RE.test(s.slice(i))) {
            this.#pending = s.slice(i);
            return;
          }
          i += 1;
          continue;
        }
        this.#csi(m[1]!, m[2]!);
        i += m[0].length;
        continue;
      }
      if (ch === '\r') {
        this.#cx = 0;
        this.#wrapPending = false;
        i += 1;
        continue;
      }
      if (ch === '\n') {
        this.#wrapPending = false;
        this.#lineFeed();
        i += 1;
        continue;
      }
      if (ch === '\b') {
        this.#cx = Math.max(0, this.#cx - 1);
        this.#wrapPending = false;
        i += 1;
        continue;
      }
      if (ch === '\t') {
        this.#cx = Math.min((Math.floor(this.#cx / 8) + 1) * 8, this.#cols - 1);
        this.#wrapPending = false;
        i += 1;
        continue;
      }
      const glyph = String.fromCodePoint(s.codePointAt(i)!);
      const codePoint = glyph.codePointAt(0)!;
      if (codePoint >= 0x20 && codePoint !== 0x7f) this.#print(glyph);
      i += glyph.length;
    }
  }

  resize(cols: number, rows: number, anchor: 'cursor' | 'bottom' = 'cursor'): void {
    assertDimensions(cols, rows);
    // Shrinking the height scrolls content up rather than dropping the
    // bottom rows, so rows that fall off the top enter scrollback — which
    // is what real emulators do. 'cursor' scrolls only far enough to keep
    // the cursor on screen; 'bottom' always scrolls by the height delta.
    let shed = 0;
    if (rows < this.#rows) {
      if (anchor === 'bottom') shed = Math.min(this.#rows - rows, this.#rows);
      else if (this.#cy > rows - 1) shed = Math.min(this.#cy - (rows - 1), this.#rows);
      for (let y = 0; y < shed; y++) {
        if (!this.#alt) this.#scrolled.push(trimRight(this.#cells[y]!.join('')));
      }
      this.#cells = this.#cells.slice(shed);
      this.#styles = this.#styles.slice(shed);
    }
    this.#cols = cols;
    this.#rows = rows;
    this.#cells = this.#fit(this.#cells, ' ');
    this.#styles = this.#fit(this.#styles, EMPTY_SGR);
    if (this.#primary) {
      this.#primary = {
        cells: this.#fit(this.#primary.cells, ' '),
        styles: this.#fit(this.#primary.styles, EMPTY_SGR),
        cx: Math.min(this.#primary.cx, cols - 1),
        cy: Math.min(this.#primary.cy, rows - 1),
      };
    }
    this.#cx = Math.min(this.#cx, cols - 1);
    this.#cy = Math.min(this.#cy - shed, rows - 1);
    this.#top = Math.min(this.#top, rows - 1);
    this.#bottom = Math.min(this.#bottom, rows - 1);
    if (this.#bottom < this.#top) {
      this.#top = 0;
      this.#bottom = rows - 1;
    }
    this.#wrapPending = false;
  }

  text(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.#rows; y++) out.push(this.#line(y));
    return out;
  }

  scrollback(): string[] {
    return [...this.#scrolled];
  }

  spans(row: number): VtSpan[] {
    if (row < 0 || row >= this.#rows) {
      throw new RangeError(`row ${row} out of range`);
    }
    const out: VtSpan[] = [];
    let cur = '';
    let curSgr: readonly number[] = EMPTY_SGR;
    let curKey: string | null = null;
    for (let x = 0; x < this.#cols; x++) {
      const sgr = this.#styles[row]![x]!;
      const key = sgr.join(';');
      if (key !== curKey) {
        if (cur.trim()) out.push({ text: cur, sgr: curSgr });
        cur = '';
        curKey = key;
        curSgr = sgr;
      }
      cur += this.#cells[row]![x];
    }
    if (cur.trim()) out.push({ text: cur, sgr: curSgr });
    return out;
  }

  cellAt(row: number, col: number): VtCell {
    if (row < 0 || row >= this.#rows || col < 0 || col >= this.#cols) {
      throw new RangeError(`cell ${row},${col} out of range`);
    }
    return { char: this.#cells[row]![col]!, sgr: this.#styles[row]![col]! };
  }

  #line(row: number): string {
    return trimRight(this.#cells[row]!.join(''));
  }

  #blankGrid(): string[][] {
    const grid: string[][] = [];
    for (let y = 0; y < this.#rows; y++) {
      grid.push(new Array<string>(this.#cols).fill(' '));
    }
    return grid;
  }

  #blankStyles(): (readonly number[])[][] {
    const grid: (readonly number[])[][] = [];
    for (let y = 0; y < this.#rows; y++) {
      grid.push(new Array<readonly number[]>(this.#cols).fill(EMPTY_SGR));
    }
    return grid;
  }

  #fit<T>(grid: T[][], blank: T): T[][] {
    const out: T[][] = [];
    for (let y = 0; y < Math.min(grid.length, this.#rows); y++) {
      const row = grid[y]!.slice(0, this.#cols);
      while (row.length < this.#cols) row.push(blank);
      out.push(row);
    }
    while (out.length < this.#rows) {
      out.push(new Array<T>(this.#cols).fill(blank));
    }
    return out;
  }

  #lineFeed(): void {
    if (this.#cy >= this.#bottom) this.#scrollRegion();
    else this.#cy += 1;
  }

  #scrollRegion(): void {
    if (!this.#alt && this.#top === 0) {
      this.#scrolled.push(this.#line(this.#top));
    }
    for (let y = this.#top; y < this.#bottom; y++) {
      this.#cells[y] = this.#cells[y + 1]!;
      this.#styles[y] = this.#styles[y + 1]!;
    }
    this.#cells[this.#bottom] = new Array<string>(this.#cols).fill(' ');
    this.#styles[this.#bottom] = new Array<readonly number[]>(this.#cols).fill(EMPTY_SGR);
  }

  #print(ch: string): void {
    if (this.#wrapPending && this.#modes.has(7)) {
      this.#wrapPending = false;
      this.#cx = 0;
      this.#lineFeed();
    }
    if (this.#cy >= 0 && this.#cy < this.#rows && this.#cx >= 0 && this.#cx < this.#cols) {
      this.#cells[this.#cy]![this.#cx] = ch;
      this.#styles[this.#cy]![this.#cx] = this.#sgr;
    }
    if (this.#cx >= this.#cols - 1) {
      // Autowrap off means the last column just keeps overprinting.
      this.#wrapPending = this.#modes.has(7);
    } else {
      this.#cx += 1;
    }
  }

  #move(cx: number, cy: number): void {
    this.#cx = Math.max(0, Math.min(cx, this.#cols - 1));
    this.#cy = Math.max(0, Math.min(cy, this.#rows - 1));
    this.#wrapPending = false;
  }

  #eraseCell(y: number, x: number): void {
    this.#cells[y]![x] = ' ';
    this.#styles[y]![x] = EMPTY_SGR;
  }

  #blankLine(y: number): void {
    this.#cells[y] = new Array<string>(this.#cols).fill(' ');
    this.#styles[y] = new Array<readonly number[]>(this.#cols).fill(EMPTY_SGR);
  }

  #params(params: string): number[] {
    if (params === '') return [];
    return params.split(/[;:]/).map((p) => (p === '' ? 0 : parseInt(p, 10)));
  }

  #csi(params: string, cmd: string): void {
    switch (cmd) {
      case 'H':
      case 'f': {
        const p = this.#params(params);
        this.#move((p[1] ?? 1) - 1, (p[0] ?? 1) - 1);
        break;
      }
      case 'A': {
        const n = this.#params(params)[0] || 1;
        this.#move(this.#cx, this.#cy - n);
        break;
      }
      case 'B': {
        const n = this.#params(params)[0] || 1;
        this.#move(this.#cx, this.#cy + n);
        break;
      }
      case 'C': {
        const n = this.#params(params)[0] || 1;
        this.#move(this.#cx + n, this.#cy);
        break;
      }
      case 'D': {
        const n = this.#params(params)[0] || 1;
        this.#move(this.#cx - n, this.#cy);
        break;
      }
      case 'G': {
        const n = this.#params(params)[0] || 1;
        this.#move(n - 1, this.#cy);
        break;
      }
      case 'd': {
        const n = this.#params(params)[0] || 1;
        this.#move(this.#cx, n - 1);
        break;
      }
      case 'J': {
        const mode = /^\d+$/.test(params) ? parseInt(params, 10) : 0;
        if (mode === 0) {
          if (this.#cy >= 0 && this.#cy < this.#rows) {
            for (let x = this.#cx; x < this.#cols; x++) {
              this.#eraseCell(this.#cy, x);
            }
          }
          for (let y = this.#cy + 1; y < this.#rows; y++) this.#blankLine(y);
        } else if (mode === 1) {
          for (let y = 0; y < Math.min(this.#cy, this.#rows); y++) {
            this.#blankLine(y);
          }
          if (this.#cy >= 0 && this.#cy < this.#rows) {
            for (let x = 0; x <= Math.min(this.#cx, this.#cols - 1); x++) {
              this.#eraseCell(this.#cy, x);
            }
          }
        } else if (mode === 2) {
          this.#cells = this.#blankGrid();
          this.#styles = this.#blankStyles();
        } else if (mode === 3) {
          this.#scrolled = [];
        }
        break;
      }
      case 'K': {
        const mode = /^\d+$/.test(params) ? parseInt(params, 10) : 0;
        if (this.#cy < 0 || this.#cy >= this.#rows) break;
        if (mode === 0) {
          for (let x = this.#cx; x < this.#cols; x++) {
            this.#eraseCell(this.#cy, x);
          }
        } else if (mode === 1) {
          for (let x = 0; x <= Math.min(this.#cx, this.#cols - 1); x++) {
            this.#eraseCell(this.#cy, x);
          }
        } else if (mode === 2) {
          this.#blankLine(this.#cy);
        }
        break;
      }
      case 'r': {
        const parts = params.split(';').filter((p) => p !== '');
        const top = parts.length > 0 ? parseInt(parts[0]!, 10) - 1 : 0;
        const bottom = parts.length > 1 ? parseInt(parts[1]!, 10) - 1 : this.#rows - 1;
        this.#top = Math.max(0, Math.min(top, this.#rows - 1));
        this.#bottom = Math.max(0, Math.min(bottom, this.#rows - 1));
        if (this.#bottom < this.#top) {
          this.#top = 0;
          this.#bottom = this.#rows - 1;
        }
        this.#move(0, 0);
        break;
      }
      case 's':
        this.#saved = [this.#cx, this.#cy];
        break;
      case 'u':
        if (this.#saved) this.#move(this.#saved[0], this.#saved[1]);
        break;
      case 'h':
      case 'l': {
        if (!params.startsWith('?')) break;
        // Mouse and cursor modes are terminal-global; only 1049 swaps the
        // grid underneath them.
        for (const part of params.slice(1).split(';')) {
          if (part === '') continue;
          const n = parseInt(part, 10);
          if (n === 1049) this.#setAlt(cmd === 'h');
          if (cmd === 'h') this.#modes.add(n);
          else this.#modes.delete(n);
        }
        break;
      }
      case 'm':
        this.#applySgr(params);
        break;
      default:
        break;
    }
  }

  #setAlt(on: boolean): void {
    if (on === this.#alt) return;
    if (on) {
      this.#primary = {
        cells: this.#cells,
        styles: this.#styles,
        cx: this.#cx,
        cy: this.#cy,
      };
      this.#cells = this.#blankGrid();
      this.#styles = this.#blankStyles();
      this.#cx = 0;
      this.#cy = 0;
    } else if (this.#primary) {
      this.#cells = this.#primary.cells;
      this.#styles = this.#primary.styles;
      this.#cx = this.#primary.cx;
      this.#cy = this.#primary.cy;
      this.#primary = null;
    }
    this.#alt = on;
    this.#top = 0;
    this.#bottom = this.#rows - 1;
    this.#wrapPending = false;
  }

  #applySgr(params: string): void {
    const parts =
      params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : parseInt(p, 10)));
    this.#style = applySgr(this.#style, parts);
    this.#sgr = styleAsSgr(this.#style);
  }

  #osc(content: string): void {
    const sep = content.indexOf(';');
    const code = sep === -1 ? content : content.slice(0, sep);
    if (code === '52') {
      const rest = content.slice(sep + 1);
      const pay = rest.indexOf(';');
      this.#osc52.push(pay === -1 ? rest : rest.slice(pay + 1));
    } else if (code === '0' || code === '2') {
      this.#title = sep === -1 ? '' : content.slice(sep + 1);
    }
  }
}

function assertDimensions(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
    throw new RangeError(`terminal dimensions must be positive integers, received ${cols}x${rows}`);
  }
}

function trimRight(s: string): string {
  let end = s.length;
  while (end > 0 && /\s/.test(s[end - 1]!)) end -= 1;
  return s.slice(0, end);
}
