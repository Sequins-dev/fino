/**
 * fino:ai/transcript — durable JSONL transcripts for agent sessions.
 *
 * An agent's authoritative state lives in its `SessionStore`: message
 * history, run checkpoints, suspend tokens. That format is built for resuming
 * a run, not for reading. This module mirrors the human-facing timeline of a
 * session into append-only JSONL files — one JSON object per line, ordered by
 * time — so a conversation is auditable by people and readable by models: an
 * agent with file tools can read its own past sessions with ordinary reads
 * and greps.
 *
 * The mirror is write-only and best-effort. Every I/O error is swallowed, and
 * deleting the files loses nothing operational; the store remains the record
 * of truth.
 *
 * Layout under the transcript directory: `<threadId>.jsonl` for a session's
 * main conversation and `<threadId>/<childId>.jsonl` for each sub-agent's
 * parent↔child conversation.
 *
 * `foldEventsToTranscript()` writes the `assistant`, `tool_start`, and
 * `tool_result` lines it can derive from an `AgentEvent` stream. Every other
 * line kind is application-defined: an application appends whatever `type`
 * describes its own timeline — `fino code`, for example, writes `user`,
 * `steering`, `approval`, `subagent`, and `turn_end` lines around the folded
 * ones. Lines are plain JSON objects, so no schema is imposed beyond the `ts`
 * timestamp added on append.
 *
 * ```ts no_run
 * import { SessionTranscript, foldEventsToTranscript } from 'fino:ai/transcript';
 *
 * const transcript = new SessionTranscript('/repo/.fino/transcripts', 'thread-1');
 * transcript.parent().append({ type: 'user', text: 'hello' });
 * const fold = foldEventsToTranscript(transcript.parent());
 * await agentSession.run('hello', { onEvent: fold.onEvent });
 * fold.flush();
 * await transcript.close();
 * ```
 */
import { DiskFileSystem } from 'fino:file';
import { dirname, join } from 'fino:file/path';
import type { AgentEvent } from 'fino:ai/runtime';

const encoder = new TextEncoder();

async function mkdirRecursive(fs: DiskFileSystem, dir: string): Promise<void> {
  try {
    await fs.mkdir(dir);
    return;
  } catch (_) {
    // parent may be missing, or the directory already exists
  }
  const parent = dirname(dir).toString();
  if (parent !== dir) {
    await mkdirRecursive(fs, parent);
    try {
      await fs.mkdir(dir);
    } catch (_) {
      // already exists
    }
  }
}

/**
 * Append-only JSONL writer for one transcript file.
 *
 * Appends are serialized through an internal queue and flushed per line, so
 * events land in order and survive abrupt exits up to the last completed
 * line. All I/O errors are swallowed — the transcript is a mirror, and a
 * failing mirror must never break the session it mirrors.
 *
 * ```ts no_run
 * import { TranscriptWriter } from 'fino:ai/transcript';
 *
 * const writer = new TranscriptWriter('/repo/.fino/transcripts/thread-1.jsonl');
 * writer.append({ type: 'user', text: 'what changed in the loader?' });
 * await writer.close();
 * ```
 */
export class TranscriptWriter {
  #fs = new DiskFileSystem();
  #path: string;
  #handle?: Awaited<ReturnType<DiskFileSystem['open']>>;
  #writer?: ReturnType<Awaited<ReturnType<DiskFileSystem['open']>>['writer']>;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;

  /**
   * Create a writer for `path`. The file and its parent directories are
   * created lazily on the first append.
   */
  constructor(path: string) {
    this.#path = path;
  }

  /**
   * Queue one event line. A `ts` timestamp is added when absent.
   */
  append(event: Record<string, unknown>): void {
    if (this.#closed) return;
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    this.#pending = this.#pending.then(() => this.#write(line)).catch(() => {});
  }

  async #write(line: string): Promise<void> {
    if (this.#closed) return;
    if (!this.#writer) {
      await mkdirRecursive(this.#fs, dirname(this.#path).toString());
      this.#handle = await this.#fs.open(this.#path, 'a');
      this.#writer = this.#handle.writer();
    }
    await this.#writer.write(encoder.encode(line));
    await this.#writer.flush();
  }

  /**
   * Drain queued appends and close the file.
   */
  async close(): Promise<void> {
    await this.#pending.catch(() => {});
    this.#closed = true;
    try {
      await this.#writer?.close();
      await this.#handle?.close();
    } catch (_) {
      // best-effort mirror
    }
    this.#writer = undefined;
    this.#handle = undefined;
  }
}

/**
 * Transcript file set for one agent session: a parent conversation file plus
 * one file per sub-agent, created lazily.
 *
 * Sub-agent ids come from the caller — a `fino:ai/subagents` child id, a
 * delegated thread id, or anything else the application uses to name a nested
 * conversation.
 *
 * ```ts no_run
 * import { SessionTranscript } from 'fino:ai/transcript';
 *
 * const transcript = new SessionTranscript('/repo/.fino/transcripts', 'thread-1');
 * transcript.parent().append({ type: 'user', text: 'review the diff' });
 * transcript.child('sa_1').append({ type: 'user', text: 'read src/loader.rs' });
 * await transcript.close();
 * ```
 */
export class SessionTranscript {
  #dir: string;
  #threadId: string;
  #parent?: TranscriptWriter;
  #children = new Map<string, TranscriptWriter>();

  /**
   * Create the file set rooted at `dir` for `threadId`. Nothing touches the
   * filesystem until the first append.
   */
  constructor(dir: string, threadId: string) {
    this.#dir = dir;
    this.#threadId = threadId;
  }

  /** Writer for the main parent conversation. */
  parent(): TranscriptWriter {
    this.#parent ??= new TranscriptWriter(join(this.#dir, `${this.#threadId}.jsonl`).toString());
    return this.#parent;
  }

  /** Writer for one sub-agent's conversation. */
  child(childId: string): TranscriptWriter {
    let writer = this.#children.get(childId);
    if (!writer) {
      writer = new TranscriptWriter(join(this.#dir, this.#threadId, `${childId}.jsonl`).toString());
      this.#children.set(childId, writer);
    }
    return writer;
  }

  /** Close every open writer. */
  async close(): Promise<void> {
    await this.#parent?.close();
    for (const writer of this.#children.values()) await writer.close();
    this.#children.clear();
  }
}

/**
 * Fold streaming agent events into transcript lines.
 *
 * Text deltas buffer into one `assistant` line, flushed when a tool starts, a
 * step ends, the run suspends, or `flush()` is called at turn end; tool
 * activity maps to `tool_start`/`tool_result` lines. Attach the returned
 * `onEvent` alongside a UI observer — it only reads events, so the same
 * stream can drive both.
 *
 * ```ts no_run
 * import { TranscriptWriter, foldEventsToTranscript } from 'fino:ai/transcript';
 *
 * const fold = foldEventsToTranscript(new TranscriptWriter('/tmp/thread-1.jsonl'));
 * await agentSession.run('summarize the release', { onEvent: fold.onEvent });
 * fold.flush();
 * ```
 */
export function foldEventsToTranscript(writer: TranscriptWriter): {
  onEvent: (ev: AgentEvent) => void;
  flush: () => void;
} {
  let buffer = '';
  const flush = (): void => {
    if (buffer.trim().length > 0) writer.append({ type: 'assistant', text: buffer });
    buffer = '';
  };
  return {
    onEvent(ev: AgentEvent): void {
      if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
        buffer += ev.event.text;
      } else if (ev.type === 'tool_start') {
        flush();
        writer.append({
          type: 'tool_start',
          id: ev.id,
          name: ev.name,
          ...(ev.args !== undefined ? { args: previewText(JSON.stringify(ev.args)) } : {}),
        });
      } else if (ev.type === 'tool_result') {
        writer.append({
          type: 'tool_result',
          id: ev.id,
          name: ev.name,
          ...(ev.isError ? { isError: true } : {}),
          ...(ev.content !== undefined ? { output: previewText(contentText(ev.content)) } : {}),
        });
      } else if (ev.type === 'step_end') {
        flush();
      } else if (ev.type === 'suspend') {
        flush();
      }
    },
    flush,
  };
}

const PREVIEW_MAX = 4_000;

/**
 * Flatten a tool result's content parts into plain text.
 *
 * Non-text parts collapse to a `[type]` marker, so an image or audio result
 * still leaves a readable placeholder in the line.
 *
 * ```ts
 * import { contentText } from 'fino:ai/transcript';
 *
 * contentText([{ type: 'text', text: 'ok' }, { type: 'image' }]); // 'ok\n[image]'
 * ```
 */
export function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
    .join('\n');
}

/**
 * Truncate a payload preview so transcripts stay readable.
 *
 * Tool arguments and outputs can be arbitrarily large; a mirror is meant to
 * be read, so oversized payloads are cut at `limit` and annotated with how
 * much was dropped.
 *
 * ```ts
 * import { previewText } from 'fino:ai/transcript';
 *
 * previewText('abcdef', 3); // 'abc… [truncated 3 chars]'
 * ```
 */
export function previewText(text: string, limit = PREVIEW_MAX): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}
