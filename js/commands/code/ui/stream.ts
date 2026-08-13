/**
 * fino:commands/code/ui/stream — the streaming assistant tail.
 *
 * Bridges a streaming assistant message onto the inline commit pipeline:
 * settled markdown blocks flow out through {@link StreamTail.takeSettled}
 * into scrollback, while the still-unsettled tail renders fresh each paint
 * for the footer. Width is frozen at construction — committed lines never
 * depend on later resizes.
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
    return lines;
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
    let end = this.#tail.length;
    while (end > 0 && stripAnsi(this.#tail[end - 1]!).trim() === '') end -= 1;
    let start = 0;
    while (start < end && stripAnsi(this.#tail[start]!).trim() === '') start += 1;
    if (start >= end) return [];
    const visible = this.#tail.slice(start, end);
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
    return this.#renderer.finish(this.#text);
  }
}
