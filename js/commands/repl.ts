/**
* fino:commands/repl — reusable `fino repl` command task.
*
* Implements the interactive REPL behind both `fino repl` and bare `fino`.
* The parent realm owns the terminal — reading stdin, editing the current
* line, and printing results — while each complete snippet is evaluated in an
* embedded child realm created with `Realm({ repl: true })`. The child routes
* code through the inspector bridge (`internal:repl/handler`) over the
* realm's `MessagePort`, so snippets run in a normal runtime context with
* top-level `await` and redeclarable bindings, and the CLI shell itself stays
* out of scope.
*
* When both stdin and stdout are TTYs the loop switches the terminal to raw
* mode for the duration of the session, enabling cursor movement, Home/End,
* Backspace/Delete editing, and up/down navigation through in-memory input
* history. Without a TTY it degrades to plain line reading, which makes the
* REPL scriptable: pipe source into stdin and read results from stdout.
* Multi-line input uses a bracket/quote balance heuristic — while the
* accumulated buffer looks incomplete the prompt changes to `... ` and lines
* keep accumulating. `.exit`, Ctrl-C, Ctrl-D on an empty line, or stdin EOF
* end the session.
*
* The default export is the `repl` `Task`. The root Fino CLI mounts it as a
* subcommand and also delegates to it when `fino` is invoked with no script.
*
* ```ts no_run
* import { Task } from 'fino:task';
* import replCommand from 'fino:commands/repl';
*
* // Run the REPL loop directly; resolves when the session ends.
* await replCommand.run({});
*
* // Or mount it as a subcommand of a larger CLI.
* const cli = new Task({
*   name: 'mycli',
*   description: 'My tool',
*   outputMode: 'text',
*   run: async () => 'usage: mycli repl',
*   children: [replCommand],
* });
* await cli.parse(['repl']);
* ```
*/
import { Task } from '../task.ts';
import { Realm } from '../realm/index.ts';
import { stdin, stdout } from '../process.ts';
import { stdinIsTTY, stdoutIsTTY } from '../tty.ts';
import { enterRawMode } from '../internal/tty/bindings.ts';
import { TextEncoder as _TextEncoder } from '../globals/encoding.ts';
const enc = new _TextEncoder();
async function print(text: string): Promise<void> {
  await stdout().write(enc.encode(text));
  await stdout().flush();
}
/**
* Normalize text for terminals while raw mode is active.
*
* Raw mode disables the terminal's usual newline translation, so line feeds
* must be written as CRLF to return subsequent lines to column zero. Existing
* CRLF endings are preserved rather than doubled.
*
* @internal
*/
function formatRawTerminalOutput(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
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
type ReplKey = {
  type: 'text';
  value: string;
} | {
  type: 'enter';
} | {
  type: 'ctrl-c';
} | {
  type: 'ctrl-d';
} | {
  type: 'backspace';
} | {
  type: 'delete';
} | {
  type: 'left';
} | {
  type: 'right';
} | {
  type: 'up';
} | {
  type: 'down';
} | {
  type: 'home';
} | {
  type: 'end';
} | {
  type: 'unknown';
};
function decodeReplKey(first: number, readByte: () => Promise<number | null>): Promise<ReplKey> | ReplKey {
  if (first === 10 || first === 13) return { type: 'enter' };
  if (first === 3) return { type: 'ctrl-c' };
  if (first === 4) return { type: 'ctrl-d' };
  if (first === 127 || first === 8) return { type: 'backspace' };
  if (first !== 27) return {
    type: 'text',
    value: String.fromCharCode(first)
  };
  return (async () => {
    const second = await readByte();
    if (second === null) return { type: 'unknown' };
    if (second !== 91) return { type: 'unknown' };
    const third = await readByte();
    switch (third) {
      case 65: return { type: 'up' };
      case 66: return { type: 'down' };
      case 67: return { type: 'right' };
      case 68: return { type: 'left' };
      case 70: return { type: 'end' };
      case 72: return { type: 'home' };
      case 51: {
        const fourth = await readByte();
        return fourth === 126 ? { type: 'delete' } : { type: 'unknown' };
      }
      default: return { type: 'unknown' };
    }
  })();
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
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === '\'' || c === '`') {
      inString = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth <= 0 && !inString && !inBlockComment;
}
/**
* Start the interactive REPL loop.
*
* The loop reads lines from stdin, keeps reading while bracket or quote balance
* suggests an incomplete expression, sends complete snippets to the child
* realm, and prints JSON-formatted results (strings print as-is, `undefined`
* prints nothing). `.exit`, Ctrl-C, Ctrl-D on an empty line, or stdin EOF
* terminate the loop. Evaluation errors are printed and do not terminate the
* session.
*
* This is a small Fino REPL, not Node's `repl` module. Interactive TTY
* sessions enter raw input mode while the loop is running so left/right
* arrows edit the current line and up/down arrows navigate in-memory input
* history for the current session; raw mode is restored on exit even when the
* loop throws. It does not provide a persistent history file, completion API,
* or pluggable writer. The returned promise resolves after the child realm
* has been asked to terminate and its run loop has finished.
*
* ```ts no_run
* import replCommand from 'fino:commands/repl';
* await replCommand.run({});
* ```
*/
async function runReplCommand(): Promise<void> {
  const realm = new Realm({ repl: true });
  const port = realm.port as MessagePort;
  port.start();
  // Register the realm for stepping — required so the embedded child is
  // driven by the parent loop. The run() Promise resolves when the realm exits.
  const runPromise = realm.run();
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
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
      entry.reject(new Error(msg['message'] as string | undefined ?? 'eval error'));
    }
  });
  async function evalCode(code: string): Promise<unknown> {
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject
      });
      port.postMessage({
        __eval: true,
        id,
        code
      });
    });
  }
  const interactive = stdinIsTTY && stdoutIsTTY;
  let restoreRaw: (() => void) | null = null;
  if (interactive) {
    try {
      restoreRaw = enterRawMode(0);
    } catch (_) {
      restoreRaw = null;
    }
  }
  const rawInput = restoreRaw !== null;
  const history: string[] = [];
  async function terminalPrint(text: string): Promise<void> {
    await print(rawInput ? formatRawTerminalOutput(text) : text);
  }
  async function terminalPrompt(text: string): Promise<void> {
    await terminalPrint(text);
  }
  async function redrawInput(promptText: string, line: string, cursor: number): Promise<void> {
    if (!rawInput) return;
    const right = Array.from(line.slice(cursor)).length;
    await terminalPrint('\r' + promptText + line + '\x1B[K' + (right > 0 ? `\x1B[${right}D` : ''));
  }
  async function readLine(promptText: string): Promise<string | null> {
    await terminalPrompt(promptText);
    let line = '';
    let cursor = 0;
    let historyIndex: number | null = null;
    let draft = '';
    while (true) {
      const b = await stdin().readByte();
      if (b === null) return null;
      const key = await decodeReplKey(b, () => stdin().readByte());
      if (key.type === 'enter') {
        if (rawInput) await terminalPrint('\n');
        break;
      }
      if (key.type === 'ctrl-c') return null;
      if (key.type === 'ctrl-d' && line.length === 0) return null;
      if (key.type === 'left') {
        cursor = Math.max(0, cursor - 1);
        await redrawInput(promptText, line, cursor);
        continue;
      }
      if (key.type === 'right') {
        cursor = Math.min(line.length, cursor + 1);
        await redrawInput(promptText, line, cursor);
        continue;
      }
      if (key.type === 'home') {
        cursor = 0;
        await redrawInput(promptText, line, cursor);
        continue;
      }
      if (key.type === 'end') {
        cursor = line.length;
        await redrawInput(promptText, line, cursor);
        continue;
      }
      if (key.type === 'up') {
        if (history.length > 0) {
          if (historyIndex === null) {
            draft = line;
            historyIndex = history.length - 1;
          } else {
            historyIndex = Math.max(0, historyIndex - 1);
          }
          line = history[historyIndex] ?? '';
          cursor = line.length;
          await redrawInput(promptText, line, cursor);
        }
        continue;
      }
      if (key.type === 'down') {
        if (historyIndex !== null) {
          if (historyIndex >= history.length - 1) {
            historyIndex = null;
            line = draft;
          } else {
            historyIndex++;
            line = history[historyIndex] ?? '';
          }
          cursor = line.length;
          await redrawInput(promptText, line, cursor);
        }
        continue;
      }
      if (key.type === 'backspace') {
        if (cursor > 0) {
          line = line.slice(0, cursor - 1) + line.slice(cursor);
          cursor--;
          await redrawInput(promptText, line, cursor);
        }
        continue;
      }
      if (key.type === 'delete') {
        if (cursor < line.length) {
          line = line.slice(0, cursor) + line.slice(cursor + 1);
          await redrawInput(promptText, line, cursor);
        }
        continue;
      }
      if (key.type === 'text') {
        line = line.slice(0, cursor) + key.value + line.slice(cursor);
        cursor += key.value.length;
        await redrawInput(promptText, line, cursor);
      }
    }
    return line;
  }
  let buffer = '';
  try {
    await terminalPrompt('Fino REPL\nType .exit to quit.\n\n');
    while (true) {
      const line = await readLine(buffer.length === 0 ? '> ' : '... ');
      if (line === null) break;
      if (line === '.exit') break;
      buffer += (buffer.length > 0 ? '\n' : '') + line;
      if (!isComplete(buffer)) continue;
      const code = buffer;
      buffer = '';
      if (code.length > 0 && history[history.length - 1] !== code) history.push(code);
      try {
        const result = await evalCode(code);
        const formatted = formatResult(result);
        if (formatted) {
          await terminalPrint(formatted + '\n');
        }
      } catch (err) {
        await terminalPrint((err instanceof Error ? err.message : String(err)) + '\n');
      }
    }
  } finally {
    restoreRaw?.();
  }
  port.postMessage({ __terminate: true });
  port.close();
  await runPromise;
}
/**
* The `repl` subcommand task consumed by the root Fino CLI.
*
* A `Task` named `repl` with text output mode and no positional arguments or
* command-specific options; it delegates directly to the private REPL loop.
* Errors from child realm setup, stdin, or stdout propagate to the caller —
* evaluation errors inside the session do not, since the loop prints them and
* continues.
*
* Invoke it programmatically with `run({})`, or parse an argv slice the way
* the CLI dispatcher does. Either form resolves once the session ends.
*
* ```ts no_run
* import repl from 'fino:commands/repl';
*
* await repl.parse([]);   // as the CLI would invoke it
* await repl.run({});     // direct invocation, same session
* ```
*/
const command = new Task({
  name: 'repl',
  description: 'Start an interactive REPL',
  outputMode: 'text',
  run: runReplCommand
});
export { command as default };
