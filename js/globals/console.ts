/**
* Console globals available as `globalThis.console`.
*
* The console API provides synchronous diagnostic output for programs and
* runtime tooling. Methods write formatted text directly to stdout or stderr,
* so logging is available before stream globals or the event loop are fully
* initialized.
*
* Values are formatted with a small inspector that understands primitives,
* arrays, plain objects, errors, dates, maps, sets, typed arrays, and circular
* references. String-first calls support printf-style substitutions such as
* `%s`, `%d`, `%f`, `%o`, `%O`, `%c`, and `%%`.
*
* Grouping indents later output until `groupEnd()` is called. Timers and
* counters are stored per label, matching the shape of the WHATWG Console API
* while keeping terminal-only operations such as `clear()` and `timeStamp()`
* as no-ops.
*
* ```ts no_run
* console.group('request');
* console.log({ method: 'GET', url: '/health' });
* console.time('work');
* console.timeEnd('work');
* console.groupEnd();
* ```
*
* Console Standard: https://console.spec.whatwg.org/
*/
import { writeLine } from 'internal:runtime/libc';
// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------
const INDENT = '  ';
/**
* The console object installed on `globalThis.console`.
*
* Console methods synchronously format their arguments and write one line to
* stdout or stderr. Formatting supports common JavaScript values, `%` style
* substitutions in string-first calls, indentation groups, timers, and
* counters.
*
* The runtime installs a singleton implementing this interface on
* `globalThis.console`, so no import is needed:
*
* ```ts no_run
* console.log('user %s logged in', 'ada');   // stdout: user ada logged in
* console.error(new Error('boom'));          // stderr: [error] Error: boom ...
* console.time('parse');
* JSON.parse('{"large": "payload"}');
* console.timeEnd('parse');                  // stdout: parse: 0.42ms
* console.count('requests');                 // stdout: requests: 1
* ```
*/
export interface Console {
  /**
  * Brand string used by `Object.prototype.toString.call(console)`.
  */
  readonly [Symbol.toStringTag]: string;
  /**
  * Write a formatted line to stdout.
  */
  log(...args: unknown[]): void;
  /**
  * Write a formatted informational line to stdout.
  */
  info(...args: unknown[]): void;
  /**
  * Write a formatted debug line to stdout.
  */
  debug(...args: unknown[]): void;
  /**
  * Write a formatted warning line to stderr with a warning prefix.
  */
  warn(...args: unknown[]): void;
  /**
  * Write a formatted error line to stderr with an error prefix.
  */
  error(...args: unknown[]): void;
  /**
  * Write an assertion failure to stderr when `condition` is falsy.
  */
  assert(condition: unknown, ...args: unknown[]): void;
  /**
  * Inspect `obj` and write the result to stdout.
  *
  * `depth` controls object and array recursion. `colors` is accepted for
  * compatibility but ignored because console output is plain text.
  */
  dir(obj: unknown, opts?: {
    depth?: number;
    colors?: boolean;
  }): void;
  /**
  * Write table data to stdout.
  *
  * Fino currently prints JSON when possible and falls back to normal object
  * inspection for values that cannot be serialized.
  */
  table(data: unknown): void;
  /**
  * Write an optional heading and indent subsequent console output.
  */
  group(...args: unknown[]): void;
  /**
  * Write an optional heading and indent subsequent output.
  *
  * This is equivalent to `group()` in the terminal runtime because there is no
  * DevTools UI that can collapse groups.
  */
  groupCollapsed(...args: unknown[]): void;
  /**
  * End the current indentation group.
  */
  groupEnd(): void;
  /**
  * Start or replace a timer for `label`.
  *
  * Omitting `label` uses the label `'default'`. Starting a timer that already
  * exists silently restarts it.
  */
  time(label?: string): void;
  /**
  * Print the elapsed time for `label` to stdout and remove the timer.
  *
  * If no timer with that label exists, a `[warn]` line is written to stderr
  * instead.
  */
  timeEnd(label?: string): void;
  /**
  * Print the elapsed time for `label` without removing the timer.
  *
  * Extra arguments are formatted and appended after the elapsed time. If no
  * timer with that label exists, a `[warn]` line is written to stderr instead.
  */
  timeLog(label?: string, ...args: unknown[]): void;
  /**
  * Increment and print the counter for `label`.
  *
  * Omitting `label` uses the label `'default'`. The first call for a label
  * prints `1`.
  */
  count(label?: string): void;
  /**
  * Reset the counter for `label`.
  *
  * If no counter with that label exists, a `[warn]` line is written to stderr.
  */
  countReset(label?: string): void;
  /**
  * Clear the console when an interactive console is available.
  *
  * This is a no-op in Fino's terminal runtime.
  */
  clear(): void;
  /**
  * Write a stack trace to stdout with optional formatted leading text.
  */
  trace(...args: unknown[]): void;
  /**
  * Write XML-like diagnostic output.
  *
  * Because Fino has no DOM renderer, this delegates to normal console
  * formatting.
  */
  dirxml(...args: unknown[]): void;
  /**
  * Record a performance timestamp when a DevTools timeline is available.
  *
  * This is a no-op in Fino's terminal runtime.
  */
  timeStamp(label?: string): void;
}
/**
* One fully formatted console line captured by a `ConsoleCaptureSink`.
*
* The record is produced after all formatting has been applied: printf-style
* substitution, value inspection, group indentation, and level prefixes such
* as `[warn]` or `[error]` are already part of `text`. The trailing newline
* that would be written to the file descriptor is not included.
*
* ```ts no_run
* import { _pushConsoleCapture, type ConsoleCaptureRecord } from 'internal:globals/console';
*
* const lines: ConsoleCaptureRecord[] = [];
* const release = _pushConsoleCapture((record) => lines.push(record));
* console.warn('careful');
* release();
* // lines[0] is { fd: 2, text: '[warn] careful' }
* ```
*
* @internal
*/
export interface ConsoleCaptureRecord {
  /**
  * Which file descriptor the line was destined for: `1` for stdout
  * (`log`, `info`, `debug`, `dir`, `table`, timers, counters) or `2` for
  * stderr (`warn`, `error`, `assert`, and missing-label warnings). */
  fd: 1 | 2;
  /**
  * The complete formatted line, including group indentation and any level
  * prefix, without a trailing newline. */
  text: string;
}
/**
* Callback that receives formatted console lines while capture is active.
*
* Called synchronously from inside each console method, once per output
* line, with the line that would otherwise have been written to stdout or
* stderr. Install one with `_pushConsoleCapture`.
*
* @internal
*/
export type ConsoleCaptureSink = (record: ConsoleCaptureRecord) => void;
/**
* Convert a single value to a human-readable string, similar to a
* simplified version of Node's util.inspect.
*
* `depth` is the remaining nesting budget: arrays and plain objects recurse
* with `depth - 1` and collapse to `[Array]` / `[Object]` once it reaches
* zero. At the top-level default (`depth === 2`) strings are printed bare;
* at any other depth they are quoted with JSON.stringify. Errors render
* their stack, Dates their ISO string, Maps/Sets their entries, and typed
* arrays their first 100 elements. The `seen` set breaks reference cycles
* by rendering revisited objects as `[Circular *]`.
*/
function inspect(value: unknown, depth: number = 2, seen: WeakSet<object> = new WeakSet()): string {
  switch (typeof value) {
    case 'string':
 // When inspect is called as the top-level formatter for console.log,
    // strings are printed bare (no quotes). Nested strings get quotes.
    return depth === 2 ? value : JSON.stringify(value);
    case 'number': return Object.is(value, -0) ? '-0' : String(value);
    case 'bigint': return `${value}n`;
    case 'boolean':
    case 'undefined': return String(value);
    case 'symbol': return value.toString();
    case 'function': return `[Function: ${value.name || '(anonymous)'}]`;
    case 'object': {
      if (value === null) return 'null';
      if (depth <= 0) return Array.isArray(value) ? '[Array]' : '[Object]';
      if (seen.has(value)) return '[Circular *]';
      if (value instanceof Error) {
        return value.stack ?? value.toString();
      }
      if (value instanceof Date) return value.toISOString();
      if (value instanceof RegExp) return String(value);
      seen.add(value);
      try {
        if (value instanceof Map) {
          const entries = [...value.entries()].map(([k, v]) => `${inspect(k, depth - 1, seen)} => ${inspect(v, depth - 1, seen)}`);
          return `Map(${value.size}) { ${entries.join(', ')} }`;
        }
        if (value instanceof Set) {
          const items = [...value].map((v) => inspect(v, depth - 1, seen));
          return `Set(${value.size}) { ${items.join(', ')} }`;
        }
        if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
          const ta = (value as unknown) as {
            constructor: {
              name: string;
            };
            length: number;
          };
          const items = Array.from(value as Uint8Array).slice(0, 100).map(String);
          const tail = ta.length > 100 ? ', ...' : '';
          return `${ta.constructor.name}(${ta.length}) [ ${items.join(', ')}${tail} ]`;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) return '[]';
          const items = value.map((v) => inspect(v, depth - 1, seen));
          const oneLine = `[ ${items.join(', ')} ]`;
          if (oneLine.length <= 72) return oneLine;
          return `[\n${items.map((s) => INDENT + s).join(',\n')}\n]`;
        }
        // Plain object
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);
        if (keys.length === 0) return '{}';
        const pairs = keys.map((k) => `${k}: ${inspect(record[k], depth - 1, seen)}`);
        const oneLine = `{ ${pairs.join(', ')} }`;
        if (oneLine.length <= 72) return oneLine;
        return `{\n${pairs.map((s) => INDENT + s).join(',\n')}\n}`;
      } finally {
        seen.delete(value);
      }
    }
    default: return String(value);
  }
}
/**
* Format an argument list the way console.log does.
*
* When the first argument is a string and more arguments follow, printf-style
* specifiers (`%s`, `%d`, `%i`, `%f`, `%o`, `%O`, `%c`, `%%`) are substituted
* left to right; a specifier with no remaining argument is left in place, and
* arguments left over after substitution are appended with `inspect()`.
* Otherwise every argument is inspected and joined with single spaces.
*/
function format(args: unknown[]): string {
  if (args.length === 0) return '';
  const first = args[0];
  if (typeof first === 'string' && args.length > 1) {
    // Basic printf-style substitution
    let idx = 1;
    const result = first.replace(/%[sdifnoOc%]/g, function formatSpec(spec) {
      if (spec === '%%') return '%';
      if (idx >= args.length) return spec;
      const arg = args[idx++];
      switch (spec) {
        case '%s': return String(arg);
        case '%d':
        case '%i': return String(Math.trunc(Number(arg)));
        case '%f': return String(Number(arg));
        case '%o':
        case '%O': return inspect(arg, 2);
        case '%c': return '';
        default: return spec;
      }
    });
    // Append any remaining args
    const tail = args.slice(idx).map((a) => inspect(a, 2));
    return tail.length ? `${result} ${tail.join(' ')}` : result;
  }
  return args.map((a) => inspect(a, 2)).join(' ');
}
// ---------------------------------------------------------------------------
// Group / timer state
// ---------------------------------------------------------------------------
let _groupDepth = 0;
const _timers = new Map<string, number>();
const _counts = new Map<string, number>();
function labelToString(label: unknown): string {
  return label === undefined ? 'default' : String(label);
}
// Use a monotonic clock when available (performance.now()), fall back to Date.now().
function _now(): number {
  return typeof (globalThis as any).performance?.now === 'function' ? (globalThis as any).performance.now() : Date.now();
}
function prefix(): string {
  return INDENT.repeat(_groupDepth);
}
// ---------------------------------------------------------------------------
// Core output helpers
// ---------------------------------------------------------------------------
const _captureStack: ConsoleCaptureSink[] = [];
/**
* Capture formatted console output until the returned release function runs.
*
* While a sink is installed, every console line is delivered to it as a
* `ConsoleCaptureRecord` instead of being written to stdout/stderr. Sinks
* form a stack: only the most recently pushed sink receives output, and
* releasing it restores the previous sink (or direct fd output when the
* stack is empty). The release function is idempotent and tolerates
* out-of-order release — releasing a sink that is no longer on top removes
* it from wherever it sits in the stack.
*
* This is intentionally internal: normal console calls still write directly to
* stdout/stderr unless a runtime tool such as the test runner or benchmark
* harness installs a sink.
*
* ```ts no_run
* import { _pushConsoleCapture, type ConsoleCaptureRecord } from 'internal:globals/console';
*
* const records: ConsoleCaptureRecord[] = [];
* const release = _pushConsoleCapture((record) => records.push(record));
* try {
*   console.log('hello %s', 'world'); // → { fd: 1, text: 'hello world' }
* } finally {
*   release();
* }
* ```
*
* @internal
*/
export function _pushConsoleCapture(sink: ConsoleCaptureSink): () => void {
  _captureStack.push(sink);
  let active = true;
  return function releaseConsoleCapture(): void {
    if (!active) return;
    active = false;
    const last = _captureStack.pop();
    if (last !== sink) {
      const index = _captureStack.lastIndexOf(sink);
      if (index >= 0) _captureStack.splice(index, 1);
    }
  };
}
function writeConsoleLine(fd: 1 | 2, text: string): void {
  const sink = _captureStack[_captureStack.length - 1];
  if (sink !== undefined) {
    sink({
      fd,
      text
    });
    return;
  }
  writeLine(fd, text);
}
function out(fd: 1 | 2, label: string, args: unknown[]): void {
  const text = prefix() + (label ? `${label} ` : '') + format(args);
  writeConsoleLine(fd, text);
}
// ---------------------------------------------------------------------------
// Exported console object
// ---------------------------------------------------------------------------
/**
* Runtime console singleton exposed as globalThis.console.
*
* Methods write directly to stdout or stderr through internal libc bindings.
* Formatting is intentionally small and synchronous so console works before
* stream globals or the event loop are fully initialized.
*
* ```ts no_run
* console.log('ready');
* console.warn('slow path');
* ```
*/
const console: Console = {
  [Symbol.toStringTag]: 'console',
  log(...args) {
    out(1, '', args);
  },
  info(...args) {
    out(1, '', args);
  },
  debug(...args) {
    out(1, '', args);
  },
  warn(...args) {
    out(2, '[warn]', args);
  },
  error(...args) {
    out(2, '[error]', args);
  },
  assert(condition: unknown, ...args: unknown[]) {
    if (!condition) {
      const msg = args.length ? format(args) : 'Assertion failed';
      out(2, '[assert]', [msg]);
    }
  },
  dir(obj: unknown, opts?: {
    depth?: number;
    colors?: boolean;
  }) {
    const depth = opts != null && typeof opts.depth === 'number' ? opts.depth : 4;
    out(1, '', [inspect(obj, depth)]);
  },
  table(data: unknown) {
    // Minimal table: JSON for now, full column layout can come later.
    try {
      out(1, '', [JSON.stringify(data, null, 2)]);
    } catch {
      out(1, '', [inspect(data, 2)]);
    }
  },
  group(...args) {
    if (args.length) out(1, '', args);
    _groupDepth++;
  },
  groupCollapsed(...args) {
    // Same as group — collapse is a hint for GUIs we don't have.
    console.group(...args);
  },
  groupEnd() {
    if (_groupDepth > 0) _groupDepth--;
  },
  time(label?: unknown) {
    label = labelToString(label);
    _timers.set(label, _now());
  },
  timeEnd(label?: unknown) {
    label = labelToString(label);
    const start = _timers.get(label);
    if (start === undefined) {
      out(2, '[warn]', [`Timer '${label}' does not exist`]);
      return;
    }
    _timers.delete(label);
    out(1, '', [`${label}: ${_now() - start}ms`]);
  },
  timeLog(label?: unknown, ...args) {
    label = labelToString(label);
    const start = _timers.get(label);
    if (start === undefined) {
      out(2, '[warn]', [`Timer '${label}' does not exist`]);
      return;
    }
    out(1, '', [`${label}: ${_now() - start}ms`, ...args]);
  },
  count(label?: unknown) {
    label = labelToString(label);
    const n = (_counts.get(label) ?? 0) + 1;
    _counts.set(label, n);
    out(1, '', [`${label}: ${n}`]);
  },
  countReset(label?: unknown) {
    label = labelToString(label);
    if (!_counts.has(label)) {
      out(2, '[warn]', [`Count for '${label}' does not exist`]);
      return;
    }
    _counts.delete(label);
  },
  clear() {
    // No-op in a non-interactive terminal context.
  },
  trace(...args) {
    const err = new Error();
    const stack = err.stack?.split('\n').slice(1).join('\n') ?? '';
    const msg = (args.length ? format(args) + '\n' : '') + 'Trace' + (stack ? ':\n' + stack : '');
    writeConsoleLine(1, prefix() + msg);
  },
  dirxml(...args) {
    // No DOM — delegate to log.
    out(1, '', args);
  },
  timeStamp(_label?: string) {
    // Performance marker — no-op in non-DevTools environment.
  }
};
Object.setPrototypeOf(console, Object.create(Object.prototype));
Object.defineProperty(console, Symbol.toStringTag, {
  value: 'console',
  writable: false,
  enumerable: false,
  configurable: true
});
for (const method of [
  'assert',
  'table',
  'dir',
  'count',
  'countReset',
  'time',
  'timeLog',
  'timeEnd'
] as const) {
  Object.defineProperty(console[method], 'length', {
    value: 0,
    writable: false,
    enumerable: false,
    configurable: true
  });
}
export default console;
export { console };
