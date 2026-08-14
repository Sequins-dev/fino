/**
 * internal:commands/code/transcript — append-only JSONL transcript mirrors.
 *
 * `fino code` persists its authoritative state in the SQLite session store;
 * this module mirrors the human-facing timeline into JSONL files so
 * conversations are auditable by people and by LLMs (the agent can read its
 * own past sessions with `read_file`/`search_files`). One JSON object per
 * line, ordered by time: user inputs, steering, assistant messages, tool
 * activity, approvals, and sub-agent status transitions. The mirror is
 * write-only and best-effort — deleting it loses nothing operational.
 *
 * Layout under the transcripts directory: `<threadId>.jsonl` for a session's
 * main conversation and `<threadId>/<childId>.jsonl` for each sub-agent's
 * parent↔child conversation.
 *
 * ```ts no_run
 * import { SessionTranscript } from 'internal:commands/code/transcript';
 *
 * const transcript = new SessionTranscript('/repo/.fino/code/transcripts', threadId);
 * transcript.parent().append({ type: 'user', text: 'hello' });
 * const fold = foldEventsToTranscript(transcript.parent());
 * fold.onEvent(agentEvent);
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
 * Transcript file set for one `fino code` session: a parent conversation
 * file plus one file per sub-agent, created lazily.
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
 * Text deltas buffer into one `assistant` line, flushed when a tool starts,
 * a step ends, or `flush()` is called at turn end; tool activity maps to
 * `tool_start`/`tool_result` lines. Attach the returned `onEvent` alongside
 * a UI observer.
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
 */
export function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
    .join('\n');
}

/**
 * Truncate transcript payload previews so mirrors stay readable.
 */
export function previewText(text: string, limit = PREVIEW_MAX): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}
