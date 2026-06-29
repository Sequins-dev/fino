/**
* standard Console API installed on globalThis.
*
* Console Standard: https://console.spec.whatwg.org/
*
* Provides `console.log`, `warn`, `error`, `info`, `debug`, `assert`,
* `dir`, `table`, `group`, `groupCollapsed`, `groupEnd`, `time`, `timeEnd`,
* and `timeLog`. Output goes to stdout (fd 1) or stderr (fd 2) through
* `writeLine()` from `internal:runtime/libc`, which calls `write(2)` directly.
*
* **Why JS instead of Rust?**
* Implementing console in JS keeps all output on a single path through
* `write(2)` via FFI, consistent with the rest of the standard library.
* It also lets contributors modify console formatting without touching Rust.
*
*
* ## Value formatting: inspect()
*
* `inspect(value, depth)` is a simplified version of Node.js's `util.inspect`.
* It recurses into arrays and plain objects up to `depth` levels deep,
* then collapses deeper structures to `[Array]` or `[Object]`. At the top
* level (depth=2, the default for `console.log`), strings are printed bare
* (without quotes). Nested strings are quoted with JSON.stringify so the
* difference between a string and a number is visible.
*
* Key choices:
* - `-0` is rendered as `"-0"` (not `"0"`), matching Node.js.
* - BigInt values are suffixed with `n` (e.g. `42n`).
* - Functions show as `[Function: name]` (or `[Function: (anonymous)]`).
* - Single-line layout is used when the result fits in 72 characters;
*   otherwise a multi-line indented layout is used.
*
*
* ## printf-style substitution: format()
*
* `format(args)` handles `%s`, `%d`, `%i`, `%f`, `%o`, `%O`, and `%%` in
* the first argument when additional arguments are present. Remaining args
* after all substitutions are exhausted are appended with `inspect()`.
*
*
* ## group / timer state
*
* `_groupDepth` is a module-level counter incremented by `group()` and
* decremented by `groupEnd()`. All output is prefixed with `INDENT` repeated
* `_groupDepth` times. `groupCollapsed()` is identical to `group()` — the
* "collapsed" hint is only meaningful for browser DevTools GUIs that fino
* doesn't have.
*
* Timer state is stored in a module-level `Map<label, startMs>`. `time()`
* sets the start, `timeEnd()` removes it and prints the elapsed time.
*
*
* ## Contributing
*
* - `console.table()` currently falls back to JSON.stringify. A proper
*   column-aligned table renderer would be a good first contribution.
* - `console.count()` and `console.countReset()` maintain per-label counters.
* - `console.clear()` and `console.timeStamp()` are no-ops in this terminal
*   runtime, and `console.dirxml()` delegates to normal formatting because
*   there is no DOM renderer.
* - Do not switch output to process.stdout streams — the direct `writeLine`
*   call is intentional (no buffering, works before the event loop starts).
*
* ## Example
*
* ```typescript no_run
* console.group('request');
* console.log({ method: 'GET', url: '/health' });
* console.time('work');
* console.timeEnd('work');
* console.groupEnd();
* ```
*
*/
import { writeLine } from 'internal:runtime/libc';
// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------
const INDENT = '  ';
interface ConsoleShape {
  group(...args: unknown[]): void;
}
/**
*  Captured console output record used by internal test tooling. */
export interface ConsoleCaptureRecord {
  fd: 1 | 2;
  text: string;
}
/**
*  Callback that receives formatted console lines while capture is active. */
export type ConsoleCaptureSink = (record: ConsoleCaptureRecord) => void;
/**
* Convert a single value to a human-readable string, similar to Node's
* util.inspect (simplified).
*
* @param {unknown} value
* @param {number} depth  - remaining nesting depth before collapsing to [Object]
* @returns {string}
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
* Format a list of arguments the way console.log does:
* - If the first arg is a string containing %s/%d/%i/%f/%o/%O, substitute.
* - Otherwise join with spaces.
*
* @param {unknown[]} args
* @returns {string}
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
* This is intentionally internal: normal console calls still write directly to
* stdout/stderr unless a runtime tool such as the test runner installs a sink.
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
* ```typescript no_run
* console.log('ready');
* console.warn('slow path');
* ```
*/
const console: ConsoleShape & {
  readonly [Symbol.toStringTag]: string;
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  assert(condition: unknown, ...args: unknown[]): void;
  dir(obj: unknown, opts?: {
    depth?: number;
    colors?: boolean;
  }): void;
  table(data: unknown): void;
  group(...args: unknown[]): void;
  groupCollapsed(...args: unknown[]): void;
  groupEnd(): void;
  time(label?: string): void;
  timeEnd(label?: string): void;
  timeLog(label?: string, ...args: unknown[]): void;
  count(label?: string): void;
  countReset(label?: string): void;
  clear(): void;
  trace(...args: unknown[]): void;
  dirxml(...args: unknown[]): void;
  timeStamp(_label?: string): void;
} = {
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
