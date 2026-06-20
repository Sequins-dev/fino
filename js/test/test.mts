/**
 * fino:test — TAP-13 test framework with nesting and BDD-style describe/it.
 *
 * Two equivalent but non-mixable patterns:
 *
 *   **Pattern 1: suite + test**
 *   ```js
 *   import { test, suite } from './test.mts';
 *
 *   test('standalone', (t) => { t.ok(true); });
 *
 *   suite('math', () => {
 *     test('adds', (t) => { t.equal(1 + 1, 2); });
 *     test('subs', (t) => { t.equal(2 - 1, 1); });
 *   });
 *   ```
 *
 *   **Pattern 2: describe + it + lifecycle hooks**
 *   ```js
 *   import { describe, it } from './test.mts';
 *
 *   describe('math', () => {
 *     before(async () => { ... });       // once, before first it
 *     beforeEach(async () => { ... });   // before each it
 *     afterEach(async () => { ... });    // after each it (always runs)
 *     after(async () => { ... });        // once, after last it (always runs)
 *
 *     it('adds', (t) => { t.equal(1 + 1, 2); });
 *     it('subs', (t) => { t.equal(2 - 1, 1); });
 *   });
 *   ```
 *
 * Mixing is forbidden: `it()` inside `suite()`, `test()` inside `describe()`,
 * `suite()` inside `describe()`, or `describe()` inside `suite()` all throw.
 * `it()` and hook functions throw if used at the top level.
 *
 *
 * ## TAP-13 output and captured diagnostics
 *
 * Nested groups produce standard TAP subtests (indented 4 spaces per level):
 *
 *   TAP version 13
 *   1..2
 *   ok 1 - standalone
 *   # Subtest: math
 *       1..2
 *       ok 1 - adds
 *       ok 2 - subs
 *   ok 2 - math
 *   # tests 2
 *   # pass  2
 *
 * Console output from tests is captured by default so passing tests keep TAP
 * output clean. Failing tests print a final `# Failure details` section with
 * their captured stdout, stderr, and thrown errors. The CLI exposes this as
 * `fino test --show-output=failures|always|never`: `failures` is the default,
 * `always` streams output live for debugging, and `never` suppresses captured
 * output even when tests fail.
 *
 * ## Internal representation
 *
 * Both APIs share a tree of nodes:
 *
 *   Leaf:  { name, fn, children: null, skip: string|null }
 *   Group: { name, kind: 'suite'|'describe', children: [],
 *            before, beforeEach, after, afterEach,
 *            skip: string|null }
 *
 * `_current` points at the group being registered into (`null` = top level).
 * The unified runner `_runEntries(entries, depth, parentNode)` recurses the tree,
 * applying hooks from `parentNode` to each leaf inside a `describe` group.
 */

import console, { _pushConsoleCapture, type ConsoleCaptureRecord } from '../internal/globals/console.mts';
import { Assert, AssertionError } from './assert.mts';
import { scheduleSync as _scheduleSync } from 'internal:async-context';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface LeafNode {
  name: string;
  fn: (t: Assert) => void | Promise<void>;
  children: null;
  skip: string | null;
}

interface GroupNode {
  name: string;
  kind: 'suite' | 'describe';
  children: TestNode[];
  before:     (() => void | Promise<void>) | null;
  beforeEach: (() => void | Promise<void>) | null;
  after:      (() => void | Promise<void>) | null;
  afterEach:  (() => void | Promise<void>) | null;
  skip: string | null;
}

type TestNode = LeafNode | GroupNode;
type RunStatus = 'pass' | 'fail' | 'skip';
type ShowOutputMode = 'failures' | 'always' | 'never';

interface FailureDiagnostic {
  title: string;
  errors: unknown[];
  output: ConsoleCaptureRecord[];
}

interface RunResult {
  passed: number;
  failed: number;
  skipped: number;
  diagnostics: FailureDiagnostic[];
}

interface LeafRunResult {
  status: RunStatus;
  diagnostic: FailureDiagnostic | null;
}

interface RunContext {
  showOutput: ShowOutputMode;
}

/**
 * Options passed to `run()` when executing registered tests manually.
 *
 * `filter` keeps only matching `describe()` paths and their ancestors. The CLI
 * passes this from `fino test --filter`.
 *
 * `showOutput` controls test console output. `failures` captures output and
 * prints it only in final failure diagnostics, `always` writes output as tests
 * run, and `never` keeps captured output hidden. The CLI passes this from
 * `fino test --show-output`.
 */
export interface RunOptions {
  filter?: string;
  showOutput?: ShowOutputMode;
}

/**
 * Value accepted by the `skip` registration option.
 *
 * `true` skips without a reason, and a string is printed as the TAP skip
 * reason.
 */
export type SkipOption = boolean | string;

/**
 * Options accepted by `test()`, `suite()`, `describe()`, and `it()`.
 */
export type RegisterOptions = { skip?: SkipOption };

/**
 * Callback used by `test()` and `it()`.
 *
 * The assertion helper collects failures for TAP output. Returning a promise
 * lets the runner await async test work.
 */
export type TestFn = (t: Assert) => void | Promise<void>;

/**
 * Registration callback used by `suite()` and `describe()`.
 */
export type GroupFn = () => void;

/**
 * Lifecycle hook callback used by `before()`, `after()`, `beforeEach()`, and
 * `afterEach()`.
 */
export type HookFn = () => void | Promise<void>;

/** Top-level test/suite/describe entries. */
const _tests: TestNode[] = [];

/** The group node currently being registered into, or null for top-level. */
let _current: GroupNode | null = null;

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

/**
 * Parse the optional middle `opts` argument from `name, [opts], fn` signatures.
 */
function _parseArgs<TFn extends (...args: any[]) => any>(optsOrFn: TFn | RegisterOptions | null | undefined, maybeFn?: TFn): { opts: RegisterOptions | null; fn: TFn } {
  if (typeof optsOrFn === 'function') return { opts: null, fn: optsOrFn };
  return { opts: optsOrFn ?? null, fn: maybeFn as TFn };
}

/**
 * Normalise a `skip` option value to a string reason ('' if no reason given)
 * or `null` if the test should not be skipped.
 */
function _skipReason(opts: RegisterOptions | null): string | null {
  if (!opts || !opts.skip) return null;
  return typeof opts.skip === 'string' ? opts.skip : '';
}

function _requireOutside(kind: 'suite' | 'describe', callerName: string): void {
  if (_current !== null && _current.kind !== kind) {
    const other = kind === 'suite' ? 'describe' : 'suite';
    throw new Error(`${callerName}() cannot be used inside ${other}()`);
  }
}

function _requireInside(kind: 'suite' | 'describe', callerName: string): void {
  if (_current === null || _current.kind !== kind) {
    const where = _current === null ? 'top level' : `${_current.kind}()`;
    throw new Error(`${callerName}() must be called inside ${kind === 'describe' ? 'describe()' : 'suite()'}, not at ${where}`);
  }
}

function _push(node: TestNode): void {
  if (_current === null) {
    _tests.push(node);
  } else {
    _current.children.push(node);
  }
}

// ---------------------------------------------------------------------------
// Public API — suite + test
// ---------------------------------------------------------------------------

/**
 * Register a test case. Can be top-level or inside `suite()`.
 * Throws inside `describe()`.
 *
 * The callback receives an `Assert` instance that collects all assertion
 * failures before the runner reports the test result. Pass `{ skip: true }` or
 * `{ skip: 'reason' }` as the middle argument to mark the test skipped.
 *
 * ```ts no_run
 * import { test } from 'fino:test/test';
 *
 * test('adds numbers', (t) => {
 *   t.equal(1 + 1, 2);
 * });
 * ```
 */
export function test(name: string, optsOrFn: TestFn | RegisterOptions, maybeFn?: TestFn): void {
  const { opts, fn } = _parseArgs(optsOrFn, maybeFn);
  _requireOutside('suite', 'test');
  _push({ name, fn, children: null, skip: _skipReason(opts) });
}

/**
 * Register a group of tests. Can be nested inside other `suite()` calls.
 * Throws inside `describe()`.
 *
 * Suites are grouping-only; they do not support lifecycle hooks. Use
 * `describe()` when tests need `before`, `after`, `beforeEach`, or
 * `afterEach`.
 *
 * ```ts no_run
 * import { suite, test } from 'fino:test/test';
 *
 * suite('math', () => {
 *   test('adds', (t) => t.equal(1 + 1, 2));
 * });
 * ```
 */
export function suite(name: string, optsOrFn: GroupFn | RegisterOptions, maybeFn?: GroupFn): void {
  const { opts, fn } = _parseArgs(optsOrFn, maybeFn);
  _requireOutside('suite', 'suite');
  const node: GroupNode = { name, kind: 'suite', children: [], before: null, beforeEach: null, after: null, afterEach: null, skip: _skipReason(opts) };
  const prev = _current;
  _current = node;
  fn();
  _current = prev;
  _push(node);
}

// ---------------------------------------------------------------------------
// Public API — describe + it + lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Register a BDD-style test group with optional lifecycle hooks.
 * Can be nested inside other `describe()` calls.
 * Throws inside `suite()`.
 *
 * The registration callback runs immediately and should only register tests and
 * hooks. Runtime work belongs inside `it()` callbacks or lifecycle hooks.
 *
 * ```ts no_run
 * import { describe, it } from 'fino:test/test';
 *
 * describe('api', () => {
 *   it('responds', (t) => t.ok(true));
 * });
 * ```
 */
export function describe(name: string, optsOrFn: GroupFn | RegisterOptions, maybeFn?: GroupFn): void {
  const { opts, fn } = _parseArgs(optsOrFn, maybeFn);
  _requireOutside('describe', 'describe');
  const node: GroupNode = { name, kind: 'describe', children: [], before: null, beforeEach: null, after: null, afterEach: null, skip: _skipReason(opts) };
  const prev = _current;
  _current = node;
  fn();
  _current = prev;
  _push(node);
}

/**
 * Register a test case inside `describe()`. Throws outside `describe()`.
 *
 * The callback may be synchronous or async and receives the same assertion
 * helper used by `test()`. A parent `describe({ skip })` propagates to all
 * child `it()` calls.
 *
 * ```ts no_run
 * import { describe, it } from 'fino:test/test';
 *
 * describe('user lookup', () => {
 *   it('returns a user', async (t) => {
 *     t.ok(await Promise.resolve({ id: 1 }));
 *   });
 * });
 * ```
 */
export function it(name: string, optsOrFn: TestFn | RegisterOptions, maybeFn?: TestFn): void {
  const { opts, fn } = _parseArgs(optsOrFn, maybeFn);
  _requireInside('describe', 'it');
  _push({ name, fn, children: null, skip: _skipReason(opts) });
}

/**
 * Run `fn` once before the first `it` in this `describe` block.
 * Throws outside `describe()`.
 *
 * A failing `before()` marks each entry in the group failed. Use it for shared
 * setup that every test in the block requires.
 *
 * ```ts no_run
 * import { before, describe, it } from 'fino:test/test';
 *
 * describe('database', () => {
 *   before(async () => {
 *     // connect
 *   });
 *   it('queries', (t) => t.ok(true));
 * });
 * ```
 */
export function before(fn: HookFn): void {
  _requireInside('describe', 'before');
  if (_current === null) throw new Error('before() must be called inside describe()');
  _current.before = fn;
}

/**
 * Run `fn` once after the last `it` in this `describe` block.
 * Always runs even if tests fail. Throws outside `describe()`.
 *
 * Errors thrown by `after()` are swallowed so cleanup does not mask test
 * failures. Keep assertions inside `it()` or `afterEach()` when failures should
 * be reported.
 *
 * ```ts no_run
 * import { after, describe, it } from 'fino:test/test';
 *
 * describe('server', () => {
 *   after(async () => {
 *     // close server
 *   });
 *   it('starts', (t) => t.ok(true));
 * });
 * ```
 */
export function after(fn: HookFn): void {
  _requireInside('describe', 'after');
  if (_current === null) throw new Error('after() must be called inside describe()');
  _current.after = fn;
}

/**
 * Run `fn` before each `it` in this `describe` block.
 * Throws outside `describe()`.
 *
 * If `beforeEach()` fails, the test body is skipped and the entry is reported
 * failed. Use it for per-test state that must be fresh.
 *
 * ```ts no_run
 * import { beforeEach, describe, it } from 'fino:test/test';
 *
 * describe('counter', () => {
 *   let value = 0;
 *   beforeEach(() => { value = 0; });
 *   it('increments', (t) => t.equal(++value, 1));
 * });
 * ```
 */
export function beforeEach(fn: HookFn): void {
  _requireInside('describe', 'beforeEach');
  if (_current === null) throw new Error('beforeEach() must be called inside describe()');
  _current.beforeEach = fn;
}

/**
 * Run `fn` after each `it` in this `describe` block.
 * Always runs even if the test fails. Throws outside `describe()`.
 *
 * Failures from `afterEach()` are collected with assertion failures from the
 * same test. Use it for cleanup that should be visible when it fails.
 *
 * ```ts no_run
 * import { afterEach, describe, it } from 'fino:test/test';
 *
 * describe('temp files', () => {
 *   afterEach(async () => {
 *     // remove temp files
 *   });
 *   it('writes', (t) => t.ok(true));
 * });
 * ```
 */
export function afterEach(fn: HookFn): void {
  _requireInside('describe', 'afterEach');
  if (_current === null) throw new Error('afterEach() must be called inside describe()');
  _current.afterEach = fn;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function _indent(depth: number): string {
  return '    '.repeat(depth);
}

function _log(depth: number, msg: string): void {
  console.log(_indent(depth) + msg);
}

function _formatErrorLines(err: unknown): string[] {
  const lines: string[] = [];
  if (err instanceof AggregateError) {
    for (const e of err.errors) {
      if (e instanceof Error && typeof e.stack === 'string') {
        lines.push(...e.stack.split('\n'));
      } else if (e instanceof Error) {
        lines.push(e.message);
      } else {
        lines.push('threw ' + e);
      }
    }
  } else {
    const stack = err instanceof Error ? err.stack : undefined;
    if (typeof stack === 'string') {
      lines.push(...stack.split('\n'));
    } else if (err instanceof Error) {
      lines.push(err.message);
    } else {
      lines.push('threw ' + err);
    }
  }
  return lines;
}

function _commentLine(msg: string = ''): void {
  console.log('#' + (msg.length > 0 ? ' ' + msg : ''));
}

function _printFailureDetails(diagnostics: FailureDiagnostic[], showOutput: ShowOutputMode): void {
  _commentLine('Failure details');
  for (let i = 0; i < diagnostics.length; i++) {
    const diagnostic = diagnostics[i];
    if (diagnostic === undefined) continue;
    _commentLine(`${i + 1}) ${diagnostic.title}`);
    if (diagnostic.errors.length > 0) {
      _commentLine('Error:');
      for (const error of diagnostic.errors) {
        for (const line of _formatErrorLines(error)) _commentLine('  ' + line);
      }
    }
    if (showOutput === 'failures') {
      const stdout = diagnostic.output.filter((entry) => entry.fd === 1);
      const stderr = diagnostic.output.filter((entry) => entry.fd === 2);
      if (stdout.length > 0) {
        _commentLine('Captured stdout:');
        for (const entry of stdout) _commentLine('  ' + entry.text);
      }
      if (stderr.length > 0) {
        _commentLine('Captured stderr:');
        for (const entry of stderr) _commentLine('  ' + entry.text);
      }
    }
    if (i < diagnostics.length - 1) _commentLine();
  }
}

async function _captureConsole<T>(ctx: RunContext, output: ConsoleCaptureRecord[], fn: () => T | Promise<T>): Promise<T> {
  if (ctx.showOutput === 'always') {
    return await fn();
  }
  const release = _pushConsoleCapture((record) => output.push(record));
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Run a single leaf node (test or it) with optional surrounding hooks.
 *
 * @param {object}  entry      Leaf node { name, fn, skip }.
 * @param {number}  num        1-based index for TAP output.
 * @param {number}  depth      Indentation level.
 * @param {object|null} hooks  Parent describe node (for beforeEach/afterEach), or null.
 * @param {string|null} inheritedSkip  Skip reason inherited from a parent group, or null.
 * @returns {'pass'|'fail'|'skip'}
 */
async function _runLeaf(ctx: RunContext, path: string[], entry: LeafNode, num: number, depth: number, hooks: GroupNode | null, inheritedSkip: string | null = null): Promise<LeafRunResult> {
  const skipReason = inheritedSkip ?? entry.skip;
  if (skipReason !== null) {
    const suffix = skipReason !== '' ? ' # SKIP ' + skipReason : ' # SKIP';
    _log(depth, 'ok ' + num + ' - ' + entry.name + suffix);
    return { status: 'skip', diagnostic: null };
  }
  const failures: unknown[] = [];
  const t = new Assert({ onFail(err) { failures.push(err); } });
  let output: ConsoleCaptureRecord[] = [];

  try {
    await _captureConsole(ctx, output, async () => {
      // Run beforeEach (hook failure skips the body but still runs afterEach).
      let beforeError = null;
      if (hooks?.beforeEach) {
        try { await hooks.beforeEach(); }
        catch (e) { beforeError = e; }
      }

      // Run the test body (skipped if beforeEach threw).
      let bodyError = null;
      if (beforeError === null) {
        try {
          // Call via scheduleSync so the function executes outside the microtask
          // checkpoint — this allows spin() to drain microtasks correctly.
          const result = await _scheduleSync(() => entry.fn(t));
        } catch (e) {
          bodyError = e;
        }
      }

      // Run afterEach — always, as long as beforeEach didn't throw.
      if (hooks?.afterEach && beforeError === null) {
        try { await hooks.afterEach(); }
        catch (e) { failures.push(e); }
      }

      // Determine pass/fail.
      const firstError = beforeError ?? bodyError;
      if (firstError) throw firstError;
      if (failures.length > 0) throw new AggregateError(failures, failures.length + ' assertion(s) failed');
    });

    _log(depth, 'ok ' + num + ' - ' + entry.name);
    return { status: 'pass', diagnostic: null };
  } catch (err) {
    _log(depth, 'not ok ' + num + ' - ' + entry.name);
    return {
      status: 'fail',
      diagnostic: {
        title: [...path, entry.name].join(' > '),
        errors: [err],
        output,
      },
    };
  }
}

/**
 * Recursively run a list of entries, printing TAP output at the given depth.
 *
 * Prints the `1..N` plan line first, then runs each entry. For group nodes,
 * recurses with `depth + 1`. For leaf nodes inside a `describe` group,
 * applies `beforeEach`/`afterEach` hooks.
 *
 * @param {Array}       entries    Nodes to run.
 * @param {number}      depth      Current indentation level (0 = top level).
 * @param {object|null} parentNode The group node containing these entries, or null.
 * @param {string|null} inheritedSkip  Skip reason inherited from a parent group, or null.
 * @returns {{ passed: number, failed: number, skipped: number }}
 */
async function _runEntries(ctx: RunContext, entries: TestNode[], depth: number, parentNode: GroupNode | null, inheritedSkip: string | null = null, path: string[] = []): Promise<RunResult> {
  _log(depth, '1..' + entries.length);

  // A skip on the parent group propagates to all children.
  const groupSkip = inheritedSkip ?? parentNode?.skip ?? null;

  // Extract hooks from the parent describe (not suite — suite has no hooks).
  const hooks = (parentNode?.kind === 'describe') ? parentNode : null;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const diagnostics: FailureDiagnostic[] = [];
  let beforeDiagnostic: FailureDiagnostic | null = null;
  let afterDiagnostic: FailureDiagnostic | null = null;

  // Run 'before' once before the first leaf/group (skip if group is skipped).
  let beforeFailed = false;
  if (!groupSkip && hooks?.before) {
    const output: ConsoleCaptureRecord[] = [];
    try {
      await _captureConsole(ctx, output, () => hooks.before!());
      if (output.length > 0) {
        beforeDiagnostic = {
          title: 'before hook: ' + path.join(' > '),
          errors: [],
          output,
        };
      }
    }
    catch (err) {
      // before() failure — mark all entries as failed immediately.
      for (let i = 0; i < entries.length; i++) {
        const failedEntry = entries[i];
        if (failedEntry === undefined) continue;
        _log(depth, 'not ok ' + (i + 1) + ' - ' + failedEntry.name);
        failed++;
      }
      diagnostics.push({
        title: 'before hook: ' + path.join(' > '),
        errors: [err],
        output,
      });
      beforeFailed = true;
    }
  }

  if (!beforeFailed) {
    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry === undefined) continue;
        const num = i + 1;

        if (entry.children === null) {
          // Leaf node.
          const result = await _runLeaf(ctx, path, entry, num, depth, hooks, groupSkip);
          if (result.status === 'pass') passed++;
          else if (result.status === 'fail') {
            failed++;
            if (result.diagnostic !== null) diagnostics.push(result.diagnostic);
          }
          else skipped++;
        } else {
          // Group node — recurse.
          _log(depth, '# Subtest: ' + entry.name);
          const childSkip = groupSkip ?? entry.skip ?? null;
          const childPath = entry.kind === 'describe' ? [...path, entry.name] : path;
          const { passed: gp, failed: gf, skipped: gs, diagnostics: gd } = await _runEntries(ctx, entry.children, depth + 1, entry, childSkip !== entry.skip ? childSkip : null, childPath);
          _log(depth, '');
          if (gf === 0 && gp === 0 && gs > 0) {
            // All children skipped — mark the group as skipped too.
            const suffix = childSkip !== null && childSkip !== '' ? ' # SKIP ' + childSkip : ' # SKIP';
            _log(depth, 'ok ' + num + ' - ' + entry.name + suffix);
            skipped++;
          } else if (gf === 0) {
            _log(depth, 'ok ' + num + ' - ' + entry.name);
            passed++;
          } else {
            _log(depth, 'not ok ' + num + ' - ' + entry.name);
            failed++;
            diagnostics.push(...gd);
          }
        }
      }
    } finally {
      // Run 'after' once after all entries, even if some failed (skip if group is skipped).
      if (!groupSkip && hooks?.after) {
        const output: ConsoleCaptureRecord[] = [];
        try {
          await _captureConsole(ctx, output, () => hooks.after!());
          if (output.length > 0) {
            afterDiagnostic = {
              title: 'after hook: ' + path.join(' > '),
              errors: [],
              output,
            };
          }
        }
        catch (_) { /* after() errors are silently swallowed to not mask test failures */ }
      }
    }
  }

  if (failed > 0) {
    if (beforeDiagnostic !== null) diagnostics.unshift(beforeDiagnostic);
    if (afterDiagnostic !== null) diagnostics.push(afterDiagnostic);
  }

  return { passed, failed, skipped, diagnostics };
}

function _filterEntries(entries: TestNode[], filter: string, path: string[] = []): TestNode[] {
  const filtered: TestNode[] = [];

  for (const entry of entries) {
    const nextPath = entry.children === null || entry.kind === 'describe'
      ? [...path, entry.name]
      : path;
    const fullPath = nextPath.join(' ');

    if (entry.children === null) {
      if (fullPath.includes(filter)) filtered.push(entry);
      continue;
    }

    if (entry.kind === 'suite') {
      const children = _filterEntries(entry.children, filter, path);
      if (children.length > 0) filtered.push({ ...entry, children });
      continue;
    }

    if (fullPath.includes(filter)) {
      filtered.push(entry);
      continue;
    }

    const children = _filterEntries(entry.children, filter, nextPath);
    if (children.length > 0) filtered.push({ ...entry, children });
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run all registered tests and print TAP-13 output.
 *
 * Called automatically by the `fino test` command. User test files
 * only need to call `test()` / `suite()` / `describe()` — never `run()`.
 *
 * @throws {Error} If any test fails (causes the process to exit with code 1).
 *
 * ```ts no_run
 * import { run, test } from 'fino:test/test';
 *
 * test('manual runner', (t) => t.ok(true));
 * await run({ filter: 'manual' });
 * ```
 */
export async function run(options: RunOptions = {}): Promise<void> {
  const showOutput = options.showOutput ?? 'failures';
  console.log('TAP version 13');

  const entries = options.filter ? _filterEntries(_tests, options.filter) : _tests;
  const { passed, failed, skipped, diagnostics } = await _runEntries({ showOutput }, entries, 0, null);
  const total = passed + failed + skipped;

  console.log('');
  console.log('# tests ' + total);
  console.log('# pass  ' + passed);
  if (skipped > 0) console.log('# skip  ' + skipped);
  if (failed > 0) {
    console.log('# fail  ' + failed);
    if (diagnostics.length > 0) _printFailureDetails(diagnostics, showOutput);
    throw new Error(failed + ' test(s) failed');
  }
}
