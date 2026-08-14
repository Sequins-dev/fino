/**
 * internal:commands/code/ui/stream — the streaming assistant tail.
 *
 * Bridges a streaming assistant message onto the inline commit pipeline:
 * settled markdown blocks flow out through {@link StreamTail.takeSettled}
 * into scrollback, while the still-unsettled tail renders fresh each paint
 * for the footer. Committed lines keep the width they were written at; a
 * terminal resize is handled by rebuilding the transcript from source, not
 * by rewriting what is already in scrollback.
 */
import { MarkdownTerminalStream } from 'fino:format/markdown';
import { stripAnsi } from 'fino:tty/tui';

/**
 * Incremental settled/tail splitter for one streaming assistant message.
 *
 * Feed the deltas with {@link push}; on each paint tick call
 * {@link takeSettled} and commit its result, then show {@link tailLines} in
 * the footer. When the message ends, {@link finish} returns everything not
 * yet committed.
 */
export class StreamTail {
  #renderer: MarkdownTerminalStream;
  #width: number;
  #text = '';
  #tail: string[] = [];
  #flushed = 0;
  #finished = false;

  /** Create a tail for one message at the width it will commit at. */
  constructor(width: number) {
    this.#width = width;
    this.#renderer = new MarkdownTerminalStream({ width });
  }

  /** The commit width this stream was created at. */
  get width(): number {
    return this.#width;
  }

  /** The whole message accumulated so far. */
  get text(): string {
    return this.#text;
  }

  /** Whether any content has been pushed. */
  get opened(): boolean {
    return this.#text.length > 0;
  }

  /** Append a streamed delta. */
  push(delta: string): void {
    this.#text += delta;
  }

  /**
   * Advance the settled boundary and return the newly settled rendered
   * lines, ready to commit. Also refreshes the cached tail render.
   */
  takeSettled(): string[] {
    if (this.#finished) return [];
    const { lines, tail } = this.#renderer.commit(this.#text);
    this.#tail = tail;
    if (lines.length === 0) return [];
    // Lines already committed by takeOverflow() are part of this settled
    // render too; emitting them again would duplicate them in scrollback.
    const skip = Math.min(this.#flushed, lines.length);
    this.#flushed = 0;
    return skip > 0 ? lines.slice(skip) : lines;
  }

  /**
   * Commit the stable head of a block too tall for the footer.
   *
   * A block only settles once the next one begins, so a long block would
   * otherwise have to be held whole — and anything past `capacity` rows would
   * be cut off the top of the footer until it settled. Every rendered line
   * except the last is already final (re-rendering a growing paragraph, list,
   * or code fence never rewrites the lines above the one being written), so
   * the overflow can be committed early and the footer keeps showing the end
   * of the block as it grows. Tables are the exception — a new row can widen
   * a column and rewrite every line above it — so they are held whole.
   */
  takeOverflow(capacity: number): string[] {
    if (this.#finished) return [];
    const { start, end } = this.#visible();
    const shown = end - start;
    if (shown <= capacity || !this.#flushable()) return [];
    // Flush through the same window the footer displays, so no line can fall
    // between what was committed and what is still on screen.
    const drop = Math.min(shown - capacity, shown - 1);
    const stop = start + drop;
    const lines = this.#tail.slice(this.#flushed, stop);
    this.#flushed = stop;
    return lines;
  }

  /** Range of `#tail` the footer shows: unflushed, minus surrounding blanks. */
  #visible(): { start: number; end: number } {
    let end = this.#tail.length;
    while (end > this.#flushed && stripAnsi(this.#tail[end - 1]!).trim() === '') end -= 1;
    let start = this.#flushed;
    while (start < end && stripAnsi(this.#tail[start]!).trim() === '') start += 1;
    return { start, end };
  }

  #flushable(): boolean {
    // Inside a fence every completed line is final, blank lines and all.
    const fences = (this.#text.match(/^```/gm) ?? []).length;
    if (fences % 2 === 1) return true;
    const boundary = this.#text.lastIndexOf('\n\n');
    const block = boundary < 0 ? this.#text : this.#text.slice(boundary + 2);
    return !block.split('\n').some((line) => line.trimStart().startsWith('|'));
  }

  /**
   * The last rendered unsettled tail, capped to its final `max` lines for
   * footer display. The full tail still commits wholesale when it settles.
   *
   * A block's leading separator is produced the moment the previous block
   * settles, which is before the new block has necessarily rendered any
   * visible text — an opening fence, say. Displaying that state would show a
   * blank row between the committed transcript and the live tail for as long
   * as the gap lasts, so the tail is reported only once it has something to
   * show, with its surrounding blank rows left off: the footer owns the one
   * blank that separates it from the transcript.
   */
  tailLines(max: number): string[] {
    const { start, end } = this.#visible();
    if (start >= end) return [];
    const visible = this.#tail.slice(start, end);
    // takeOverflow() normally keeps this within `max`; a block it cannot
    // flush (a table) still shows its end rather than overrunning the footer.
    return visible.length > max ? visible.slice(visible.length - max) : visible;
  }

  /**
   * Flush everything not yet committed and end the stream. Subsequent calls
   * return nothing.
   */
  finish(): string[] {
    if (this.#finished) return [];
    this.#finished = true;
    this.#tail = [];
    const rest = this.#renderer.finish(this.#text);
    const skip = Math.min(this.#flushed, rest.length);
    this.#flushed = 0;
    return skip > 0 ? rest.slice(skip) : rest;
  }
}
