/**
 * fino:tty/components/composer — the multiline input widget.
 *
 * Wraps a `TextBuffer` with the app-wide editing keymap and input history.
 * The framework parks the real terminal cursor, so rendering paints no fake
 * cursor cell — `cursor()` reports where the real one belongs.
 */
import { TextBuffer, visibleWidth, type TuiKeyEvent } from '../tui.ts';
import { tk, style } from './theme.ts';
import { clipAnsi } from './text.ts';
/** What a key press did: submitted the text, changed state, or nothing. */
export type ComposerAction = 'submit' | 'edited' | 'unhandled';
const DEFAULT_PROMPT = '❯ ';
/**
 * A multiline prompt input with history recall.
 *
 * `handleKey` applies the editing keymap: Enter submits, Shift/Alt+Enter
 * inserts a newline, arrows move by character, word (`alt`), or wrapped line,
 * `shift` extends the selection, and Up/Down fall through to history at the
 * top and bottom edges. The widget never writes to the terminal.
 *
 * ```ts
 * import { Composer } from 'fino:tty/components/composer';
 *
 * const composer = new Composer();
 * composer.handleKey({ type: 'key', key: 'h', text: 'h' }, 40); // 'edited'
 * composer.handleKey({ type: 'key', key: 'enter' }, 40); // 'submit'
 * ```
 */
export class Composer {
  readonly buffer = new TextBuffer();
  #history: string[] = [];
  #historyIndex = -1;
  /** Replace the history, oldest first. */
  setHistory(entries: string[]): void {
    this.#history = [...entries];
    this.#historyIndex = -1;
  }
  /** Append one history entry. */
  pushHistory(entry: string): void {
    this.#history.push(entry);
    this.#historyIndex = -1;
  }
  /** Current contents. */
  get text(): string {
    return this.buffer.text;
  }
  /** Empty the input and forget the history position. */
  clear(): void {
    this.buffer.clear();
    this.#historyIndex = -1;
  }
  #recall(delta: number): void {
    if (this.#history.length === 0) return;
    if (delta < 0) {
      this.#historyIndex =
        this.#historyIndex === -1
          ? this.#history.length - 1
          : Math.max(0, this.#historyIndex - 1);
      this.buffer.setText(this.#history[this.#historyIndex] ?? '');
      return;
    }
    if (this.#historyIndex === -1) return;
    this.#historyIndex += 1;
    if (this.#historyIndex >= this.#history.length) {
      this.#historyIndex = -1;
      this.buffer.clear();
    } else {
      this.buffer.setText(this.#history[this.#historyIndex] ?? '');
    }
  }
  #innerWidth(width: number, prompt: string): number {
    return Math.max(1, width - visibleWidth(prompt));
  }
  /**
   * Apply one key event.
   *
   * Returns `'submit'` for Enter — the caller reads `text` and calls
   * `clear()` — `'edited'` for anything that changed buffer or history
   * state, and `'unhandled'` for keys the composer does not own.
   */
  handleKey(event: TuiKeyEvent, width: number): ComposerAction {
    const buffer = this.buffer;
    const innerWidth = this.#innerWidth(width, DEFAULT_PROMPT);
    const select = event.shift === true;
    const word = event.alt === true;
    if (event.ctrl === true && event.key === 'u') {
      buffer.clear();
      return 'edited';
    }
    if (event.ctrl === true && event.key === 'a') {
      buffer.selectAll();
      return 'edited';
    }
    if (event.key === 'backspace' || event.key === 'delete') {
      const delta = event.key === 'backspace' ? -1 : 1;
      // Shift and Alt both mean "by word" here, matching the movement keys
      // and the chord terminals actually send for Option+Delete.
      if (select || word) buffer.deleteWord(delta);
      else if (delta < 0) buffer.backspace();
      else buffer.deleteForward();
      return 'edited';
    }
    if (event.key === 'left' || event.key === 'right') {
      buffer.moveBy(event.key === 'left' ? -1 : 1, { word, select });
      return 'edited';
    }
    // Terminals that send Option as a meta prefix report word jumps as alt+b
    // and alt+f rather than modified arrows.
    if (event.alt === true && (event.key === 'b' || event.key === 'f')) {
      buffer.moveBy(event.key === 'b' ? -1 : 1, { word: true, select });
      return 'edited';
    }
    if (event.key === 'home' || event.key === 'end') {
      if (event.key === 'home') buffer.moveLineStart(innerWidth, select);
      else buffer.moveLineEnd(innerWidth, select);
      return 'edited';
    }
    if (event.key === 'enter') {
      if (event.shift === true || event.alt === true) {
        buffer.insert('\n');
        return 'edited';
      }
      return 'submit';
    }
    if (event.key === 'up' || event.key === 'down') {
      const delta = event.key === 'up' ? -1 : 1;
      if (!buffer.isEmpty && buffer.moveVertical(delta, innerWidth, select)) return 'edited';
      this.#recall(delta);
      return 'edited';
    }
    if (event.text !== undefined && event.text !== '' && event.ctrl !== true && event.alt !== true) {
      buffer.insert(event.text);
      return 'edited';
    }
    return 'unhandled';
  }
  /**
   * Render the input as wrapped lines no wider than `opts.width`.
   *
   * The prompt (default `'❯ '`) opens the first row in cyan and continuation
   * rows are indented to match. An empty buffer shows the dim placeholder.
   * Selections paint inverse; no cursor cell is painted — the framework
   * parks the real terminal cursor at `cursor()`.
   */
  render(opts: { width: number; prompt?: string; placeholder?: string }): string[] {
    const prompt = opts.prompt ?? DEFAULT_PROMPT;
    const promptWidth = visibleWidth(prompt);
    const styledPrompt = style(prompt, tk.cyan);
    if (this.buffer.isEmpty) {
      const placeholder = opts.placeholder === undefined ? '' : style(opts.placeholder, tk.dim);
      return [clipAnsi(styledPrompt + placeholder, opts.width)];
    }
    const { lines } = this.buffer.layout(this.#innerWidth(opts.width, prompt));
    const range = this.buffer.selection;
    return lines.map((line, index) => {
      const gutter = index === 0 ? styledPrompt : ' '.repeat(promptWidth);
      if (range === null) return gutter + line.text;
      let out = '';
      const cells = Array.from(line.text);
      for (let cell = 0; cell < cells.length; cell++) {
        const offset = line.start + cell;
        const selected = offset >= range.start && offset < range.end;
        out += selected ? style(cells[cell]!, tk.inverse) : cells[cell]!;
      }
      return gutter + out;
    });
  }
  /**
   * Where the real terminal cursor belongs, 0-based within the rendered
   * lines, accounting for the prompt width.
   */
  cursor(opts: { width: number; prompt?: string }): { row: number; column: number } {
    const prompt = opts.prompt ?? DEFAULT_PROMPT;
    const { row, column } = this.buffer.layout(this.#innerWidth(opts.width, prompt));
    return { row, column: column + visibleWidth(prompt) };
  }
}
