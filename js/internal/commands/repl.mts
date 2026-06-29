/**
 * internal/commands/repl — internal runtime module.
 *
 * Implements the Fino CLI REPL. The parent realm handles terminal input and
 * output while a child realm performs evaluation through the inspector bridge,
 * allowing REPL code to run in a normal module-like runtime context.
 *
 * ```js
 * import { createReplCommand } from 'internal:commands/repl';
 * const command = createReplCommand();
 * console.log(command.name);
 * ```
 *
 * @internal
 */

import { Task } from '../../task.mts';
import { Realm } from '../../realm/index.mts';
import { stdin, stdout } from '../../process.mts';
import { TextEncoder as _TextEncoder } from '../../globals/encoding.mts';

const enc = new _TextEncoder();

async function print(text: string): Promise<void> {
  await stdout().write(enc.encode(text));
  await stdout().flush();
}

async function prompt(text: string): Promise<void> {
  await print(text);
}

function formatResult(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// Simple bracket/quote balance heuristic for multi-line continuation.
// Returns true if the input looks complete (safe to send), false if more input expected.
function isComplete(buf: string): boolean {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    const next = buf[i + 1] ?? '';

    if (escaped) { escaped = false; continue; }
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === '\\') { escaped = true; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth <= 0 && !inString && !inBlockComment;
}

/**
 * Start the interactive REPL loop.
 *
 * The loop reads lines from stdin, keeps reading while bracket or quote balance
 * suggests an incomplete expression, sends complete snippets to a child realm,
 * and prints JSON-formatted results. `.exit`, Ctrl-C, Ctrl-D on an empty line,
 * or stdin EOF terminate the loop. Evaluation errors are printed and do not
 * terminate the session.
 *
 * This is a small Fino REPL, not Node's `repl` module. It does not provide a
 * persistent history file, completion API, raw terminal editing contract, or
 * pluggable writer. The returned promise resolves after the child realm is
 * asked to terminate.
 *
 * ```js
 * import { runReplCommand } from 'internal:commands/repl';
 * await runReplCommand();
 * ```
 *
 * @returns A promise that resolves when the REPL has shut down.
 * @internal
 */
export async function runReplCommand(): Promise<void> {
  const realm = new Realm({ repl: true });
  const port = realm.port as MessagePort;
  port.start();
  // Register the realm for stepping — required so the embedded child is
  // driven by the parent loop. The run() Promise resolves when the realm exits.
  const runPromise = realm.run();

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  port.addEventListener('message', function onReplMessage(ev: Event) {
    const msg = (ev as MessageEvent<Record<string, unknown>>).data;
    if (!msg || typeof msg !== 'object') return;
    const id = msg['id'] as number;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (msg['__eval_result'] === true) {
      entry.resolve(msg['value']);
    } else if (msg['__eval_error'] === true) {
      entry.reject(new Error((msg['message'] as string | undefined) ?? 'eval error'));
    }
  });

  async function evalCode(code: string): Promise<unknown> {
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ __eval: true, id, code });
    });
  }

  async function readLine(promptText: string): Promise<string | null> {
    await prompt(promptText);
    let line = '';
    while (true) {
      const b = await stdin().readByte();
      if (b === null) return null;
      if (b === 0x0a || b === 0x0d) break;       // \n or \r
      if (b === 0x03) return null;                // Ctrl-C
      if (b === 0x04 && line.length === 0) return null; // Ctrl-D on empty
      if (b === 0x7f || b === 0x08) {
        if (line.length > 0) line = line.slice(0, -1);
      } else {
        line += String.fromCharCode(b);
      }
    }
    return line;
  }

  let buffer = '';
  await prompt('Fino REPL\nType .exit to quit.\n\n');

  while (true) {
    const line = await readLine(buffer.length === 0 ? '> ' : '... ');
    if (line === null) break;
    if (line === '.exit') break;

    buffer += (buffer.length > 0 ? '\n' : '') + line;

    if (!isComplete(buffer)) continue;

    const code = buffer;
    buffer = '';

    try {
      const result = await evalCode(code);
      const formatted = formatResult(result);
      if (formatted) {
        await print(formatted + '\n');
      }
    } catch (err) {
      await print((err instanceof Error ? err.message : String(err)) + '\n');
    }
  }

  port.postMessage({ __terminate: true });
  port.close();
  await runPromise;
}

/**
 * Create the `repl` subcommand used by the root Fino CLI.
 *
 * The command has no positional arguments or options and delegates directly to
 * `runReplCommand()`. Errors from child realm setup, stdin, or stdout propagate
 * to the CLI command runner.
 *
 * ```js
 * import { createReplCommand } from 'internal:commands/repl';
 * const repl = createReplCommand();
 * await repl.parse([]);
 * ```
 *
 * @returns A configured `Task` instance for `fino repl`.
 * @internal
 */
export function createReplCommand(): Task {
  return new Task({
    name: 'repl',
    description: 'Start an interactive REPL',
    outputMode: 'text',
    run: runReplCommand,
  });
}
