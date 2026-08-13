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
   */
  tailLines(max: number): string[] {
    return this.#tail.length > max ? this.#tail.slice(this.#tail.length - max) : this.#tail;
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
