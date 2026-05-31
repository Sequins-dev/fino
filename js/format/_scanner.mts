/**
 * internal:format/scanner — Shared string scanner for fino:format/* parsers.
 *
 * Tracks byte offset, line, and column as an integer cursor over a decoded
 * string. Hot-path methods operate with charCodeAt() — no substring allocation
 * in the scanning loop.
 *
 * Each format module creates an instance via `new Scanner(src, ErrorClass)`.
 * The ErrorClass must match the signature `(msg, line, col, offset, snippet) => Error`.
 */

type ErrorCtor = (msg: string, line: number, col: number, offset: number, snippet: string) => Error;

export class Scanner {
  #src: string;
  #pos: number = 0;
  #line: number = 1;
  #col: number = 1;
  #err: ErrorCtor;

  constructor(src: string, errorCtor: ErrorCtor) {
    this.#src = src;
    this.#err = errorCtor;
  }

  get pos(): number  { return this.#pos; }
  get line(): number { return this.#line; }
  get col(): number  { return this.#col; }
  get done(): boolean { return this.#pos >= this.#src.length; }

  /** Peek at the character at the current position (or empty string if done). */
  peek(): string {
    return this.#pos < this.#src.length ? this.#src[this.#pos]! : '';
  }

  /** Peek at the character 1 ahead (or empty string if beyond end). */
  peek1(): string {
    const i = this.#pos + 1;
    return i < this.#src.length ? this.#src[i]! : '';
  }

  /** Peek at the character n ahead (or empty string). */
  peekAt(n: number): string {
    const i = this.#pos + n;
    return i < this.#src.length ? this.#src[i]! : '';
  }

  /** Return the char code at the current position (-1 if done). */
  code(): number {
    return this.#pos < this.#src.length ? this.#src.charCodeAt(this.#pos) : -1;
  }

  /** Advance past the current character and return it. */
  eat(): string {
    const ch = this.#src[this.#pos]!;
    this.#advance(ch);
    return ch;
  }

  /** Advance if the current character equals `ch`. Returns true if matched. */
  eatChar(ch: string): boolean {
    if (this.#src[this.#pos] === ch) { this.#advance(ch); return true; }
    return false;
  }

  /** Advance while predicate returns true. Returns the consumed slice. */
  eatWhile(pred: (ch: string, code: number) => boolean): string {
    const start = this.#pos;
    while (this.#pos < this.#src.length) {
      const ch = this.#src[this.#pos]!;
      if (!pred(ch, ch.charCodeAt(0))) break;
      this.#advance(ch);
    }
    return this.#src.slice(start, this.#pos);
  }

  /** Advance if the upcoming text exactly matches `str`. Returns true if matched. */
  match(str: string): boolean {
    if (this.#src.startsWith(str, this.#pos)) {
      for (let i = 0; i < str.length; i++) this.#advance(str[i]!);
      return true;
    }
    return false;
  }

  /** Return the remaining source from current position. */
  rest(): string {
    return this.#src.slice(this.#pos);
  }

  /** Return the source slice [start, current position). */
  slice(start: number): string {
    return this.#src.slice(start, this.#pos);
  }

  /** Throw a positioned FormatParseError. */
  error(msg: string): never {
    const snippetStart = Math.max(0, this.#pos - 20);
    const snippet = this.#src.slice(snippetStart, this.#pos + 20).replace(/\n/g, '↵');
    const caret = ' '.repeat(this.#pos - snippetStart) + '^';
    throw this.#err(msg, this.#line, this.#col, this.#pos, `${snippet}\n  ${caret}`);
  }

  /** Expect a specific character; throw if not found. */
  expect(ch: string): void {
    if (!this.eatChar(ch)) this.error(`expected '${ch}', got '${this.peek() || 'EOF'}'`);
  }

  /** Skip whitespace characters (space and tab only, not newlines). */
  skipSpaceTab(): void {
    while (this.#pos < this.#src.length) {
      const c = this.#src.charCodeAt(this.#pos);
      if (c !== 0x20 && c !== 0x09) break;
      this.#advance(this.#src[this.#pos]!);
    }
  }

  /** Skip space, tab, and newlines. */
  skipWhitespace(): void {
    while (this.#pos < this.#src.length) {
      const c = this.#src.charCodeAt(this.#pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      this.#advance(this.#src[this.#pos]!);
    }
  }

  #advance(ch: string): void {
    if (ch === '\n') { this.#line++; this.#col = 1; }
    else { this.#col++; }
    this.#pos++;
  }
}
