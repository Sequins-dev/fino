/**
 * fino:test — TAP-13 test framework with nesting and BDD-style describe/it.
 *
 * Two equivalent but non-mixable patterns:
 *
 *   **Pattern 1: suite + test**
 *   ```js
 *   import { test, suite } from './test.ts';
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
 *   import { describe, it } from './test.ts';
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
 * The release contract is intentionally smaller than Node's `node:test` API:
 * TAP output, name filters, skip reasons, per-test metadata, duration
 * annotations, lifecycle hooks, captured output, and exclusive parallel groups
 * are supported. `only`, `todo`, per-test timeouts, general intra-file
 * concurrency, subtest creation from an assertion object, and pluggable
 * reporters are not part of this module.
 *
 * ## Internal representation
 *
 * Both APIs share a tree of nodes:
 *
 *   Leaf:  { name, fn, children: null, skip: string|null, exclusive: boolean }
 *   Group: { name, kind: 'suite'|'describe', children: [],
 *            before, beforeEach, after, afterEach,
 *            skip: string|null, exclusive: boolean }
 *
 * `_current` points at the group being registered into (`null` = top level).
 * The unified runner `_runEntries(entries, depth, parentNode)` recurses the tree,
 * applying hooks from `parentNode` to each leaf inside a `describe` group.
 */
import console, { _pushConsoleCapture, type ConsoleCaptureRecord } from '../globals/console.ts';
import { Assert, AssertionError, type AssertCallbacks } from './assert.ts';
import { formatDurationMs } from 'internal:duration';
import { scheduleSync as _scheduleSync } from 'internal:async-context';
// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
interface LeafNode {
  name: string;
  fn: (t: TestContext) => void | Promise<void>;
  children: null;
  skip: string | null;
  exclusive: boolean;
}
interface GroupNode {
  name: string;
  kind: 'suite' | 'describe';
  children: TestNode[];
  before: (() => void | Promise<void>) | null;
  beforeEach: (() => void | Promise<void>) | null;
  after: (() => void | Promise<void>) | null;
  afterEach: (() => void | Promise<void>) | null;
  skip: string | null;
  exclusive: boolean;
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
  durations: boolean;
}
/**
 * Primitive value accepted by `TestContext#meta()`.
 */
export type TestMetadataValue = string | number | boolean | bigint | null | undefined;
/**
 * Metadata object accepted by `TestContext#meta()`.
 *
 * Keys must match `[A-Za-z_][A-Za-z0-9_.:-]*`. Repeated calls merge keys, and
 * later values overwrite earlier values.
 */
export type TestMetadata = Record<string, TestMetadataValue>;
type MetadataCallback = (values: TestMetadata) => void;
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
 *
 * `durations` appends runner-owned `duration=<time>` metadata to every TAP
 * result line. The CLI passes this from `fino test --durations`.
 */
export interface RunOptions {
  filter?: string;
  showOutput?: ShowOutputMode;
  durations?: boolean;
}
/**
 * Opaque snapshot of registered tests created by `_prepareRun()`.
 *
 * The test command uses the `count` before execution to compose a root TAP
 * plan. Prepared runs retain their test closures in the Realm where they were
 * registered and can be consumed exactly once by `_runPrepared()`.
 *
 * @internal
 */
export interface PreparedTestRun {
  /** Number of top-level TAP entries selected by the run options. */
  readonly count: number;
  /** Whether each root entry must run without another admitted test group. */
  readonly exclusive: readonly boolean[];
}

/** Structured result from one top-level entry in a prepared run. @internal */
export interface PreparedTestEntryResult {
  /** Buffered TAP records, without a root plan, summary, or failure details. */
  readonly output: ConsoleCaptureRecord[];
  /** Structured failure details for aggregate formatting after the root summary. */
  readonly diagnostics: PreparedTestDiagnostic[];
  /** One when the entry passed, otherwise zero. */
  readonly passed: number;
  /** One when the entry failed, otherwise zero. */
  readonly failed: number;
  /** One when the entry was skipped, otherwise zero. */
  readonly skipped: number;
}

/** Structured-clone-safe failure detail from one prepared top-level entry. @internal */
interface PreparedTestDiagnostic {
  /** Test or hook path identifying the failure. */
  readonly title: string;
  /** Preformatted error lines, grouped by thrown value. */
  readonly errors: string[][];
  /** Console records captured by the failing test or hook. */
  readonly output: ConsoleCaptureRecord[];
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
export type RegisterOptions = {
  /** Skip this test or group, optionally with a TAP reason. */
  skip?: SkipOption;
  /**
   * Run the containing root group alone when the CLI uses `--parallel`.
   *
   * Use this for process-global state or strict scheduling assertions that
   * cannot overlap unrelated Realm work. Nested entries make their containing
   * top-level group exclusive because root groups are the admission unit.
   */
  exclusive?: boolean;
};
/**
 * Callback used by `test()` and `it()`.
 *
 * The assertion helper collects failures for TAP output. Returning a promise
 * lets the runner await async test work.
 */
export type TestFn = (t: TestContext) => void | Promise<void>;
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
interface PreparedTestRunState {
  entries: TestNode[];
  consumed: boolean[];
}

/** Test trees detached from registration and awaiting execution. */
const _preparedRuns = new WeakMap<PreparedTestRun, PreparedTestRunState>();
// ---------------------------------------------------------------------------
// Test context metadata
// ---------------------------------------------------------------------------
/**
 * Assertion context passed to `test()` and `it()` callbacks.
 *
 * `TestContext` extends `Assert`, so existing assertion calls such as
 * `t.equal(actual, expected)` continue to work. The additional `meta()` method
 * attaches primitive key/value metadata to the leaf test's TAP result line.
 * Repeated calls merge keys and later values overwrite earlier ones.
 *
 * Metadata keys must match `[A-Za-z_][A-Za-z0-9_.:-]*`. Values may be strings,
 * numbers, booleans, bigints, `null`, or `undefined`.
 *
 * ```ts no_run
 * import { test } from 'fino:test/test';
 *
 * test('parses empty input', (t) => {
 *   t.meta({ case: 'empty', rows: 0 });
 *   t.equal(parse(''), []);
 * });
 * ```
 */
export class TestContext extends Assert {
  #onMeta: MetadataCallback;
  /**
   * Create a test context.
   *
   * The runner supplies assertion callbacks and a metadata sink for the current
   * leaf test. Application code normally receives instances from `test()` or
   * `it()` callbacks rather than constructing this class directly.
   *
   * @internal
   */
  constructor(
    callbacks: AssertCallbacks & {
      onMeta?: MetadataCallback;
    } = {},
  ) {
    const { onMeta, ...assertCallbacks } = callbacks;
    super(assertCallbacks);
    this.#onMeta = onMeta ?? (() => {});
  }
  /**
   * Attach primitive metadata to this test's final TAP result line.
   *
   * Later calls merge with previous metadata and overwrite duplicate keys.
   * Invalid keys or unsupported value types throw `TypeError`, which fails the
   * current test like any other thrown error.
   */
  meta(values: TestMetadata): void {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new TypeError('test metadata must be an object');
    }
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(key)) {
        throw new TypeError(`Invalid test metadata key "${key}"`);
      }
      const type = typeof value;
      if (
        value !== null &&
        value !== undefined &&
        type !== 'string' &&
        type !== 'number' &&
        type !== 'boolean' &&
        type !== 'bigint'
      ) {
        throw new TypeError(`Invalid test metadata value for "${key}"`);
      }
    }
    this.#onMeta(values);
  }
}
// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------
/**
 * Parse the optional middle `opts` argument from `name, [opts], fn` signatures.
 */
function _parseArgs<TFn extends (...args: any[]) => any>(
  optsOrFn: TFn | RegisterOptions | null | undefined,
  maybeFn?: TFn,
): {
  opts: RegisterOptions | null;
  fn: TFn;
} {
  if (typeof optsOrFn === 'function')
    return {
      opts: null,
      fn: optsOrFn,
    };
  return {
    opts: optsOrFn ?? null,
    fn: maybeFn as TFn,
  };
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
    throw new Error(
      `${callerName}() must be called inside ${kind === 'describe' ? 'describe()' : 'suite()'}, not at ${where}`,
    );
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
  _push({
    name,
    fn,
    children: null,
    skip: _skipReason(opts),
    exclusive: opts?.exclusive === true,
  });
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
  const node: GroupNode = {
    name,
    kind: 'suite',
    children: [],
    before: null,
    beforeEach: null,
    after: null,
    afterEach: null,
    skip: _skipReason(opts),
    exclusive: opts?.exclusive === true,
  };
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
export function describe(
  name: string,
  optsOrFn: GroupFn | RegisterOptions,
  maybeFn?: GroupFn,
): void {
  const { opts, fn } = _parseArgs(optsOrFn, maybeFn);
  _requireOutside('describe', 'describe');
  const node: GroupNode = {
    name,
    kind: 'describe',
    children: [],
    before: null,
    beforeEach: null,
    after: null,
    afterEach: null,
    skip: _skipReason(opts),
    exclusive: opts?.exclusive === true,
  };
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
  _push({
    name,
    fn,
    children: null,
    skip: _skipReason(opts),
    exclusive: opts?.exclusive === true,
  });
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
 * Errors thrown by `after()` are reported as failures with captured output,
 * while still running after earlier test or hook failures.
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
function _nowMs(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}
function _durationMeta(ctx: RunContext, startMs: number): TestMetadata {
  if (!ctx.durations) return {};
  return { duration: formatDurationMs(_nowMs() - startMs) };
}
function _formatMetadataValue(value: TestMetadataValue): string {
  if (typeof value === 'string') {
    if (!/[\s,"#]/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return String(value);
}
function _formatMetadata(metadata: TestMetadata): string {
  const parts = Object.entries(metadata).map(
    ([key, value]) => `${key}=${_formatMetadataValue(value)}`,
  );
  return parts.length === 0 ? '' : ' # ' + parts.join(', ');
}
function _resultLine(
  status: 'ok' | 'not ok',
  num: number,
  name: string,
  directive: string = '',
  metadata: TestMetadata = {},
): string {
  return status + ' ' + num + ' - ' + name + directive + _formatMetadata(metadata);
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
async function _captureConsole<T>(
  ctx: RunContext,
  output: ConsoleCaptureRecord[],
  fn: () => T | Promise<T>,
): Promise<T> {
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
async function _runLeaf(
  ctx: RunContext,
  path: string[],
  entry: LeafNode,
  num: number,
  depth: number,
  hooks: GroupNode | null,
  inheritedSkip: string | null = null,
): Promise<LeafRunResult> {
  const startMs = _nowMs();
  const skipReason = inheritedSkip ?? entry.skip;
  if (skipReason !== null) {
    const suffix = skipReason !== '' ? ' # SKIP ' + skipReason : ' # SKIP';
    _log(depth, _resultLine('ok', num, entry.name, suffix, _durationMeta(ctx, startMs)));
    return {
      status: 'skip',
      diagnostic: null,
    };
  }
  const failures: unknown[] = [];
  const metadata: TestMetadata = {};
  const t = new TestContext({
    onFail(err) {
      failures.push(err);
    },
    onMeta(values) {
      Object.assign(metadata, values);
    },
  });
  let output: ConsoleCaptureRecord[] = [];
  try {
    await _captureConsole(ctx, output, async () => {
      // Run beforeEach (hook failure skips the body but still runs afterEach).
      let beforeError = null;
      if (hooks?.beforeEach) {
        try {
          await hooks.beforeEach();
        } catch (e) {
          beforeError = e;
        }
      }
      // Run the test body (skipped if beforeEach threw).
      let bodyError = null;
      if (beforeError === null) {
        try {
          // Call via scheduleSync so the function executes outside the microtask
          // checkpoint — this allows spin() to drain microtasks correctly.
          await _scheduleSync(() => entry.fn(t));
        } catch (e) {
          bodyError = e;
        }
      }
      // Run afterEach — always, as long as beforeEach didn't throw.
      if (hooks?.afterEach && beforeError === null) {
        try {
          await hooks.afterEach();
        } catch (e) {
          failures.push(e);
        }
      }
      // Determine pass/fail.
      const firstError = beforeError ?? bodyError;
      if (firstError) throw firstError;
      if (failures.length > 0)
        throw new AggregateError(failures, failures.length + ' assertion(s) failed');
    });
    const lineMetadata = {
      ...metadata,
      ..._durationMeta(ctx, startMs),
    };
    _log(depth, _resultLine('ok', num, entry.name, '', lineMetadata));
    return {
      status: 'pass',
      diagnostic: null,
    };
  } catch (err) {
    const lineMetadata = {
      ...metadata,
      ..._durationMeta(ctx, startMs),
    };
    _log(depth, _resultLine('not ok', num, entry.name, '', lineMetadata));
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
async function _runEntries(
  ctx: RunContext,
  entries: TestNode[],
  depth: number,
  parentNode: GroupNode | null,
  inheritedSkip: string | null = null,
  path: string[] = [],
): Promise<RunResult> {
  const runStartMs = _nowMs();
  _log(depth, '1..' + entries.length);
  // A skip on the parent group propagates to all children.
  const groupSkip = inheritedSkip ?? parentNode?.skip ?? null;
  // Extract hooks from the parent describe (not suite — suite has no hooks).
  const hooks = parentNode?.kind === 'describe' ? parentNode : null;
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
    } catch (err) {
      // before() failure — mark all entries as failed immediately.
      for (let i = 0; i < entries.length; i++) {
        const failedEntry = entries[i];
        if (failedEntry === undefined) continue;
        _log(
          depth,
          _resultLine('not ok', i + 1, failedEntry.name, '', _durationMeta(ctx, runStartMs)),
        );
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
          } else skipped++;
        } else {
          // Group node — recurse.
          const groupStartMs = _nowMs();
          _log(depth, '# Subtest: ' + entry.name);
          const childSkip = groupSkip ?? entry.skip ?? null;
          const childPath = entry.kind === 'describe' ? [...path, entry.name] : path;
          const {
            passed: gp,
            failed: gf,
            skipped: gs,
            diagnostics: gd,
          } = await _runEntries(
            ctx,
            entry.children,
            depth + 1,
            entry,
            childSkip !== entry.skip ? childSkip : null,
            childPath,
          );
          _log(depth, '');
          const groupMetadata = _durationMeta(ctx, groupStartMs);
          if (gf === 0 && gp === 0 && gs > 0) {
            // All children skipped — mark the group as skipped too.
            const suffix =
              childSkip !== null && childSkip !== '' ? ' # SKIP ' + childSkip : ' # SKIP';
            _log(depth, _resultLine('ok', num, entry.name, suffix, groupMetadata));
            skipped++;
          } else if (gf === 0) {
            _log(depth, _resultLine('ok', num, entry.name, '', groupMetadata));
            passed++;
          } else {
            _log(depth, _resultLine('not ok', num, entry.name, '', groupMetadata));
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
        } catch (err) {
          afterDiagnostic = {
            title: 'after hook: ' + path.join(' > '),
            errors: [err],
            output,
          };
          failed++;
        }
      }
    }
  }
  if (failed > 0) {
    if (beforeDiagnostic !== null) diagnostics.unshift(beforeDiagnostic);
    if (afterDiagnostic !== null) diagnostics.push(afterDiagnostic);
  }
  return {
    passed,
    failed,
    skipped,
    diagnostics,
  };
}
function _filterEntries(entries: TestNode[], filter: string, path: string[] = []): TestNode[] {
  const filtered: TestNode[] = [];
  for (const entry of entries) {
    const nextPath =
      entry.children === null || entry.kind === 'describe' ? [...path, entry.name] : path;
    const fullPath = nextPath.join(' ');
    if (entry.children === null) {
      if (fullPath.includes(filter)) filtered.push(entry);
      continue;
    }
    if (entry.kind === 'suite') {
      const children = _filterEntries(entry.children, filter, path);
      if (children.length > 0)
        filtered.push({
          ...entry,
          children,
        });
      continue;
    }
    if (fullPath.includes(filter)) {
      filtered.push(entry);
      continue;
    }
    const children = _filterEntries(entry.children, filter, nextPath);
    if (children.length > 0)
      filtered.push({
        ...entry,
        children,
      });
  }
  return filtered;
}
// ---------------------------------------------------------------------------
// Runner entry points
// ---------------------------------------------------------------------------
/**
 * Detach the currently registered tests without executing their closures.
 *
 * Filtering occurs while the snapshot is created, so `count` is the exact
 * number of top-level TAP entries `_runPrepared()` will emit. The returned
 * handle belongs to this Realm and can be consumed once.
 *
 * @internal
 */
export function _prepareRun(options: RunOptions = {}): PreparedTestRun {
  const registered = _tests.splice(0, _tests.length);
  const entries = options.filter ? _filterEntries(registered, options.filter) : registered;
  const isExclusive = (entry: TestNode): boolean =>
    entry.exclusive || (entry.children?.some(isExclusive) ?? false);
  const prepared: PreparedTestRun = {
    count: entries.length,
    exclusive: entries.map(isExclusive),
  };
  _preparedRuns.set(prepared, {
    entries,
    consumed: entries.map(() => false),
  });
  return prepared;
}

/**
 * Execute one top-level entry from a prepared registration snapshot.
 *
 * Each index can be consumed exactly once. Callers execute at most one entry
 * from a prepared run at a time because entries share their Realm and module
 * state. The result omits the local `1..1` plan because a coordinating parent
 * owns the aggregate plan and numbering.
 *
 * @internal
 */
export async function _runPreparedEntry(
  prepared: PreparedTestRun,
  index: number,
  options: RunOptions = {},
): Promise<PreparedTestEntryResult> {
  const state = _preparedRuns.get(prepared);
  if (state === undefined) throw new Error('Prepared test run has already been consumed');
  if (!Number.isSafeInteger(index) || index < 0 || index >= state.entries.length) {
    throw new RangeError(`Prepared test entry index ${index} is out of range`);
  }
  if (state.consumed[index])
    throw new Error(`Prepared test entry ${index} has already been consumed`);
  state.consumed[index] = true;
  if (state.consumed.every(Boolean)) _preparedRuns.delete(prepared);
  const entry = state.entries[index]!;
  const output: ConsoleCaptureRecord[] = [];
  const showOutput = options.showOutput ?? 'failures';
  const release = _pushConsoleCapture((record) => output.push(record));
  let result: RunResult;
  try {
    result = await _runEntries(
      {
        showOutput,
        durations: options.durations === true,
      },
      [entry],
      0,
      null,
    );
  } finally {
    release();
  }
  const plan = output.findIndex((record) => record.fd === 1 && record.text === '1..1');
  if (plan >= 0) output.splice(plan, 1);
  return {
    output,
    diagnostics: result.diagnostics.map((diagnostic) => ({
      title: diagnostic.title,
      errors: diagnostic.errors.map(_formatErrorLines),
      output: diagnostic.output,
    })),
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
  };
}

/**
 * Execute a prepared registration snapshot and print its standalone TAP
 * document. The handle is consumed before execution begins and cannot be run
 * again, including after a test failure.
 *
 * @internal
 */
export async function _runPrepared(
  prepared: PreparedTestRun,
  options: RunOptions = {},
): Promise<void> {
  const state = _preparedRuns.get(prepared);
  if (state === undefined || state.consumed.some(Boolean)) {
    throw new Error('Prepared test run has already been consumed');
  }
  _preparedRuns.delete(prepared);
  const entries = state.entries;
  const showOutput = options.showOutput ?? 'failures';
  const durations = options.durations === true;
  const runStartMs = _nowMs();
  console.log('TAP version 13');
  const { passed, failed, skipped, diagnostics } = await _runEntries(
    {
      showOutput,
      durations,
    },
    entries,
    0,
    null,
  );
  const total = passed + failed + skipped;
  console.log('');
  console.log('# tests ' + total);
  console.log('# pass  ' + passed);
  if (skipped > 0) console.log('# skip  ' + skipped);
  console.log('# time  ' + formatDurationMs(_nowMs() - runStartMs));
  if (failed > 0) {
    console.log('# fail  ' + failed);
    if (diagnostics.length > 0) _printFailureDetails(diagnostics, showOutput);
    throw new Error(failed + ' test(s) failed');
  }
}

/**
 * Run all registered tests and print TAP-13 output.
 *
 * Called automatically by the `fino test` command. User test files
 * only need to call `test()` / `suite()` / `describe()` — never `run()`.
 * A run consumes the currently registered entries, so another file can
 * register and run a fresh tree afterwards in the same Realm.
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
  await _runPrepared(_prepareRun(options), options);
}
