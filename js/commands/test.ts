/**
 * fino:commands/test — reusable `fino test` command task.
 *
 * Builds the `fino test` command as a `Task` from `fino:task`, so the same
 * command definition backs the root Fino CLI and can be mounted by any other
 * interface (a custom CLI, a tool surface) that speaks the Task protocol.
 *
 * Positional arguments may be direct files, directories, or glob patterns.
 * Directories expand to every `.test.ts` file beneath them, globs are
 * resolved from the current working directory, and direct files are taken
 * as given. Each matched module is dynamically imported — `describe()` and
 * `it()` calls at module top level register tests as a side effect — and
 * then execution is delegated to `run()` from `fino:test/test`, which emits
 * TAP output. With `--parallel`, each file runs in an isolated Realm and
 * returns a structured result whose top-level entries are merged into the
 * ordinary root TAP document. Top-level group execution defaults to ten
 * groups per configured reactor thread. `FINO_TEST_CONCURRENCY` changes that
 * per-reactor multiplier. At most one group executes per file Realm. A
 * completed file admits the next file Realm into the bounded live window.
 *
 * Parallel output remains TAP 13 and has the same top-level shape as serial
 * execution. Completed groups emit atomically in completion order by default,
 * preventing output interleaving without hiding progress behind an earlier
 * long-running group. `--ordered` instead emits groups in deterministic
 * registration order. Both modes enforce the same in-flight cap.
 *
 * Before importing anything the command calls `allowInternalForTests()`,
 * lifting the loader's `internal:*` import restriction so test files can
 * exercise internal modules directly.
 *
 * ```ts no_run
 * import testCommand from 'fino:commands/test';
 *
 * // Run every test under tests/net whose describe path mentions "socket".
 * await testCommand.parse(['--filter', 'socket', 'tests/net']);
 * ```
 */
import { cwd, env, exit as processExit } from '../process.ts';
import { Task } from '../task.ts';
import { DiskFileSystem } from 'fino:file';
import { Realm } from 'fino:realm';
import { allowInternalForTests } from 'internal:loader-hooks';
import { startCoverage } from 'internal:coverage';
import { formatDurationMs } from 'internal:duration';
import { ConcurrentTaskChannel } from 'internal:concurrent-task-channel';
import { captureProcessOutput } from 'internal:runtime/output-capture';
import {
  _activeHandleCounts as activeHandleCounts,
  alive as loopAlive,
  timeout as loopTimeout,
} from 'internal:runtime/loop';
import { configuredReactorThreadCount } from 'internal:scheduler/readiness';
import type runTestFile from '../internal/test-worker.ts';
import { _runActive as testRunActive } from '../test/test.ts';
import { reactorPoolStats } from 'internal:scheduler-native';
import type {
  TestFileCompletion,
  TestFileCompletionAck,
  TestFileRegistration,
  TestGroupCompletion,
  TestGroupResult,
  TestGroupStart,
} from '../internal/test-worker.ts';

type PreparedTestDiagnostic = TestGroupResult['diagnostics'][number];
type ParallelShowOutputMode = NonNullable<Parameters<typeof runTestFile>[1]['showOutput']>;
type ParallelLineWriter = (line?: string) => void;

const DEFAULT_PARALLEL_GROUPS_PER_REACTOR = 10;
const PARALLEL_REALM_EXIT_DIAGNOSTIC_MS = 5_000;
/**
 * Floor for how long the parallel coordinator tolerates no progress at all.
 *
 * The effective threshold is always above the per-test deadline — see
 * `stallThresholdMs`. A single slow test legitimately blocks progress for its
 * whole deadline, so a fixed threshold below that reports a stall for a run
 * that is merely loaded, which is exactly the false alarm this watchdog exists
 * to avoid producing.
 */
const PARALLEL_STALL_FLOOR_MS = 120_000;
/**
 * How long to tolerate no progress, given the run's per-test deadline.
 *
 * A hung test fails itself at its own deadline, so exceeding that plus slack
 * means the coordinator is stuck on something no test owns.
 */
function stallThresholdMs(options: Parameters<typeof runTestFile>[1]): number {
  const perTest = options.timeout;
  if (perTest === 0) return 0;
  const base =
    typeof perTest === 'number' && Number.isFinite(perTest) && perTest > 0 ? perTest : 60_000;
  return Math.max(PARALLEL_STALL_FLOOR_MS, base + 60_000);
}

/**
 * Calculate the parallel test admission limit from the configured reactor pool
 * and an optional per-reactor override. There is intentionally no
 * system-independent cap.
 *
 */
function parallelTestConcurrency(reactorThreadCount: number): number {
  const configured = env.FINO_TEST_CONCURRENCY;
  const perReactor =
    configured === undefined ? DEFAULT_PARALLEL_GROUPS_PER_REACTOR : Number(configured);
  if (!Number.isSafeInteger(perReactor) || perReactor < 1) {
    throw new Error('FINO_TEST_CONCURRENCY must be a positive per-reactor integer');
  }
  const concurrency = reactorThreadCount * perReactor;
  if (!Number.isSafeInteger(concurrency)) {
    throw new Error('total parallel test concurrency exceeds the safe integer range');
  }
  return concurrency;
}

interface ParallelTestFile {
  display: string;
  specifier: string;
}

interface ParallelTestResult {
  file: ParallelTestFile;
  result: TestGroupResult;
}

interface ParallelFileCompletion extends TestFileCompletion {
  callError?: string;
  realmError?: string;
}

interface PreparedParallelTest {
  file: ParallelTestFile;
  registeredTests: TestFileRegistration['tests'];
  execute(index: number, note?: (stage: string) => void): Promise<ParallelTestResult>;
  /** Re-send a group's start message; the worker ignores one it already ran. */
  retryStart(index: number): void;
  completion: Promise<ParallelFileCompletion>;
  completionReported: Promise<TestFileCompletion>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function tapName(name: string): string {
  return name
    .replace(/\\/g, '\\\\')
    .replace(/#/g, '\\#')
    .replace(/[\r\n]/g, ' ');
}

async function prepareParallelFile(
  file: ParallelTestFile,
  options: Parameters<typeof runTestFile>[1],
  signal: AbortSignal,
): Promise<PreparedParallelTest> {
  const realm = new Realm<typeof runTestFile>({
    entry: 'internal:test-worker',
  });
  const completion = realm.run();
  const abort = () => realm.terminate({ force: true });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const call = realm.call(file.specifier, options);
  const completionOutcome = completion.then(
    () => undefined,
    (error) => errorText(error),
  );
  const callOutcome = call.then(
    (result) => ({ result }),
    (error) => ({ error: errorText(error) }),
  );

  let registered = false;
  let canStart = true;
  let startFailure: string | undefined;
  let workerCompletion: TestFileCompletion | undefined;
  let resolveCompletionReported!: (completion: TestFileCompletion) => void;
  const completionReported = new Promise<TestFileCompletion>((resolve) => {
    resolveCompletionReported = resolve;
  });
  let resolveRegistration!: (tests: TestFileRegistration['tests']) => void;
  const registration = new Promise<TestFileRegistration['tests']>((resolve) => {
    resolveRegistration = resolve;
  });
  const finishRegistration = (tests: TestFileRegistration['tests'], startable: boolean) => {
    if (registered) return;
    registered = true;
    canStart = startable;
    resolveRegistration(tests);
  };
  const resultWaiters = new Map<number, (result: TestGroupResult) => void>();
  const failPending = (error: string) => {
    for (const resolve of resultWaiters.values()) {
      resolve({
        output: [],
        diagnostics: [],
        tests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        error,
      });
    }
    resultWaiters.clear();
  };
  const onMessage = (event: Event) => {
    const message = (event as MessageEvent).data as
      | TestFileRegistration
      | TestGroupCompletion
      | TestFileCompletion
      | undefined;
    if (message?.kind === 'fino:test:registered') {
      finishRegistration(message.tests, true);
      return;
    }
    if (message?.kind === 'fino:test:complete') {
      workerCompletion = message;
      resolveCompletionReported(message);
      realm.port.postMessage({ kind: 'fino:test:complete-ack' } satisfies TestFileCompletionAck);
      return;
    }
    if (message?.kind !== 'fino:test:result') return;
    const resolve = resultWaiters.get(message.index);
    if (resolve === undefined) return;
    resultWaiters.delete(message.index);
    resolve(message.result);
  };
  realm.port.addEventListener('message', onMessage);
  realm.port.start();
  void callOutcome.then((outcome) => {
    if ('error' in outcome) {
      startFailure ??= outcome.error;
      finishRegistration([{ exclusive: false }], false);
      failPending(outcome.error);
    }
  });
  void completionOutcome.then((error) => {
    if (error !== undefined) {
      startFailure ??= error;
      finishRegistration([{ exclusive: false }], false);
      failPending(error);
    }
  });
  // A Realm that neither registers, fails, nor exits would hold the file loop
  // here for the life of the job. Terminating it turns that into one reported
  // failure; the outcome handlers above then supply the text.
  const registrationDeadline = workerResultDeadlineMs(options);
  if (registrationDeadline > 0) {
    const expiry = loopTimeout(registrationDeadline);
    expiry.unref();
    const arrived = await Promise.race([registration.then(() => true), expiry.then(() => false)]);
    if (!arrived) {
      startFailure ??= `${file.display} test Realm did not register within ${registrationDeadline}ms`;
      realm.terminate({ force: true });
      finishRegistration([{ exclusive: false }], false);
      failPending(startFailure);
    } else {
      expiry.cancel();
    }
  }
  const registeredTests = await registration;
  const fileCompletion = Promise.all([callOutcome, completionOutcome]).then(
    ([callResult, realmError]): ParallelFileCompletion => {
      signal.removeEventListener('abort', abort);
      realm.port.removeEventListener('message', onMessage);
      if (workerCompletion !== undefined) {
        return {
          ...workerCompletion,
          ...(realmError === undefined ? {} : { realmError }),
        };
      }
      return {
        ...('result' in callResult ? callResult.result : { callError: callResult.error }),
        ...(realmError === undefined ? {} : { realmError }),
      };
    },
  );

  return {
    file,
    registeredTests,
    completion: fileCompletion,
    completionReported,
    retryStart(index: number): void {
      if (!canStart) return;
      // The worker dedupes by index, so a group it already started ignores
      // this. What it does do is write to the transport again, which is the
      // only lever the coordinator has over a Realm that never woke for the
      // first message.
      realm.port.postMessage({ kind: 'fino:test:start', index } satisfies TestGroupStart);
    },
    async execute(index: number, note?: (stage: string) => void): Promise<ParallelTestResult> {
      note?.('start');
      if (!canStart) {
        // `canStart` only goes false from a handler that has already recorded
        // why. Awaiting the call and Realm outcomes here to re-derive the text
        // would block on a Realm that failed to load but has not exited, which
        // holds an admission slot and deadlocks any exclusive group behind it.
        const error = startFailure ?? `${file.display} stopped before test execution`;
        return {
          file,
          result: {
            output: [],
            diagnostics: [],
            tests: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            error,
          },
        };
      }
      const result = new Promise<TestGroupResult>((resolve) => {
        resultWaiters.set(index, resolve);
      });
      note?.('posted');
      realm.port.postMessage({ kind: 'fino:test:start', index } satisfies TestGroupStart);
      // The worker enforces each test's own deadline, but only while it is
      // running one. A Realm that wedges outside a test body — or a reply that
      // never arrives — would otherwise leave this await pending for the life
      // of the job, which is a stall with no test to blame it on.
      const deadline = workerResultDeadlineMs(options);
      if (deadline <= 0) {
        note?.('awaiting-reply-forever');
        return { file, result: await result };
      }
      const timersBefore = activeHandleCounts().timers;
      const expiry = loopTimeout(deadline);
      expiry.unref();
      // A deadline is only as good as the timer behind it. Record whether the
      // loop actually registered one, so a stall dump distinguishes "the reply
      // never came" from "the deadline was never armed".
      const armed = activeHandleCounts().timers > timersBefore;
      note?.(`awaiting-reply-${deadline}ms${armed ? '' : ' [deadline NOT armed]'}`);
      const settled = await Promise.race([
        result.then((value) => ({ value })),
        expiry.then(() => null),
      ]);
      if (settled === null) {
        resultWaiters.delete(index);
        // Groups within a file are chained, so a Realm that has stopped
        // responding would otherwise cost the full deadline once per remaining
        // group -- twelve groups is eighteen minutes of dead run. One missed
        // reply is enough to call the Realm lost: stop it and fail the rest
        // immediately.
        // Include the pool's own view. A Realm that stopped making progress is
        // either parked with nothing queued to wake it, or queued behind work
        // that never drains; `parkedWithNothingQueued` separates the two, and
        // nothing visible from TypeScript otherwise can.
        const pool = reactorPoolStats();
        const error =
          `${file.display} test Realm did not report group ${index} within ${deadline}ms` +
          (pool === null ? '' : `; reactor pool ${JSON.stringify(pool)}`);
        startFailure ??= error;
        canStart = false;
        failPending(error);
        realm.terminate({ force: true });
        return {
          file,
          result: {
            output: [],
            diagnostics: [],
            tests: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            error,
          },
        };
      }
      expiry.cancel();
      return { file, result: settled.value };
    },
  };
}

function printSyntheticFailure(
  write: ParallelLineWriter,
  index: number,
  name: string,
  label: string,
): void {
  write(`not ok ${index} - ${tapName(name)} ${label}`);
}

function isTapLine(line: string): boolean {
  return line === '' || /^\s*(?:#|1\.\.|(?:not )?ok \d+)/.test(line) || /^\s*Bail out!/.test(line);
}

function printParallelResult(
  result: ParallelTestResult,
  offset: number,
  diagnostics: PreparedTestDiagnostic[],
  write: ParallelLineWriter,
): number {
  for (const record of result.result.output) {
    const match = /^(not )?ok (\d+)(\s+-\s.*)$/.exec(record.text);
    if (match === null) {
      write(isTapLine(record.text) ? record.text : `# ${record.text}`);
      continue;
    }
    write(`${match[1] ?? ''}ok ${offset + Number(match[2])}${match[3]}`);
  }
  let synthetic = 0;
  if (result.result.error !== undefined) {
    synthetic++;
    const label = 'failed to load or run';
    printSyntheticFailure(
      write,
      offset + result.result.tests + synthetic,
      result.file.display,
      label,
    );
    // Also emit the reason inline. The end-of-run failure details are the only
    // other place it appears, and a run that bails out never reaches them --
    // which is exactly the run whose reason matters most.
    for (const line of result.result.error.split('\n')) write(`# ${line}`);
    diagnostics.push({
      title: `${result.file.display} ${label}`,
      errors: [result.result.error.split('\n')],
      output: [],
    });
  }
  diagnostics.push(...result.result.diagnostics);
  return synthetic;
}

function printParallelFailureDetails(
  diagnostics: PreparedTestDiagnostic[],
  showOutput: ParallelShowOutputMode,
  write: ParallelLineWriter,
): void {
  if (diagnostics.length === 0) return;
  write('# Failure details');
  for (let index = 0; index < diagnostics.length; index++) {
    const diagnostic = diagnostics[index]!;
    write(`# ${index + 1}) ${diagnostic.title}`);
    if (diagnostic.errors.length > 0) {
      write('# Error:');
      for (const error of diagnostic.errors) {
        for (const line of error) write(`#   ${line}`);
      }
    }
    if (showOutput === 'failures') {
      const stdout = diagnostic.output.filter((entry) => entry.fd === 1);
      const stderr = diagnostic.output.filter((entry) => entry.fd === 2);
      if (stdout.length > 0) {
        write('# Captured stdout:');
        for (const entry of stdout) write(`#   ${entry.text}`);
      }
      if (stderr.length > 0) {
        write('# Captured stderr:');
        for (const entry of stderr) write(`#   ${entry.text}`);
      }
    }
    if (index < diagnostics.length - 1) write('#');
  }
}

function parallelResultPointCount(result: ParallelTestResult): number {
  return result.result.tests + (result.result.error === undefined ? 0 : 1);
}

/**
 * Fail the run if the parallel coordinator makes no progress.
 *
 * A hung test fails itself against its own deadline, so a coordinator that
 * stops advancing is stuck on something no test owns — most often a worker
 * Realm whose loop never drains, which leaves an orphaned child and a CI job
 * that gets cancelled at its own timeout with nothing after the last group.
 *
 * The watchdog timer is unreferenced, so it cannot keep the Realm alive by
 * itself; it only fires while something else is holding the run open.
 */
function startStallWatchdog(
  write: (text: string) => void,
  pending: () => string[],
  admission: () => unknown,
  inFlight: () => string[],
  sweep: () => void,
  tickMs: number,
  thresholdMs: number,
): { progress: () => void; stop: () => void } {
  if (thresholdMs <= 0) return { progress: () => {}, stop: () => {} };
  let last = performance.now();
  let stopped = false;
  let armed: ReturnType<typeof loopTimeout> | null = null;
  const arm = (): void => {
    if (stopped) return;
    const timer = loopTimeout(tickMs);
    timer.unref();
    armed = timer;
    void timer.then(() => {
      if (stopped) return;
      sweep();
      if (performance.now() - last < thresholdMs) {
        arm();
        return;
      }
      const waiting = pending();
      write(
        `Bail out! no test progress for ${Math.round(thresholdMs / 1000)}s; the run is stalled`,
      );
      write(`# still pending: ${waiting.length > 0 ? waiting.join(', ') : '(none reported)'}`);
      const executing = inFlight();
      write(`# in flight: ${executing.length > 0 ? executing.join(', ') : '(none)'}`);
      write(`# admission: ${JSON.stringify(admission())}`);
      write(`# active handles: ${JSON.stringify(activeHandleCounts())}`);
      processExit(1);
    });
  };
  arm();
  return {
    progress: (): void => {
      last = performance.now();
    },
    stop: (): void => {
      stopped = true;
      armed?.cancel();
      armed = null;
    },
  };
}
/**
 * How long the coordinator waits for a worker Realm to report one group.
 *
 * Derived from the per-test deadline so a legitimately slow test is never cut
 * off by it, plus slack for the Realm's own setup and teardown. A run that
 * disables test deadlines disables this too — the caller has said it wants to
 * wait forever, and that should mean everywhere.
 */
/**
 * How often the stall watchdog wakes.
 *
 * It has to be short enough that a group past its deadline is abandoned before
 * the stall threshold is reached, or the run bails out on a condition it was
 * about to recover from on its own.
 */
function watchdogTickMs(options: Parameters<typeof runTestFile>[1]): number {
  const threshold = stallThresholdMs(options);
  const deadline = workerResultDeadlineMs(options);
  const bound = deadline > 0 ? Math.min(threshold, deadline) : threshold;
  // Eighths rather than quarters: the sweep also drives start retransmits, and
  // a Realm that missed its wake-up should not wait a quarter of the deadline
  // for the first one.
  return Math.max(1_000, Math.floor(bound / 8));
}
function workerResultDeadlineMs(options: Parameters<typeof runTestFile>[1]): number {
  const perTest = options.timeout;
  if (perTest === 0) return 0;
  const base =
    typeof perTest === 'number' && Number.isFinite(perTest) && perTest > 0 ? perTest : 60_000;
  return base + 30_000;
}
async function runParallelTests(
  files: ParallelTestFile[],
  options: Parameters<typeof runTestFile>[1],
  signal: AbortSignal,
  ordered: boolean,
): Promise<void> {
  const started = performance.now();
  const capture = captureProcessOutput();
  const write = capture.writeStdoutLine;
  try {
    const concurrency = parallelTestConcurrency(configuredReactorThreadCount());
    const channel = new ConcurrentTaskChannel<ParallelTestResult>(concurrency, {
      outputOrder: ordered ? 'claim' : 'completion',
    });
    write('TAP version 13');
    // Which admitted groups are executing right now, when each was admitted,
    // and how to fail one from outside. A stalled run is one task that never
    // settles; naming it is the difference between "the run hung" and a file
    // to go look at.
    interface InFlightGroup {
      label: string;
      stage: string;
      startedAt: number;
      nudges: number;
      nudge: () => void;
      force: (result: ParallelTestResult) => void;
    }
    const inFlight = new Map<number, InFlightGroup>();
    const groupDeadline = workerResultDeadlineMs(options);
    // `execute()` arms its own deadline, but a deadline is only as good as the
    // timer behind it. Enforcing it a second time from the watchdog -- whose
    // timer is the one thing a stalled run proves still fires -- means a single
    // wedged group can no longer hold an exclusive barrier, and everything
    // queued behind it, for the life of the job.
    const sweepOverdueGroups = (): void => {
      if (groupDeadline <= 0) return;
      const now = performance.now();
      for (const [index, group] of inFlight) {
        const waited = now - group.startedAt;
        if (waited < groupDeadline) {
          // Past a quarter of the deadline, re-send the start message on every
          // tick. The worker ignores a group it already started, so this is a
          // retransmit rather than a re-run: harmless for a merely slow test,
          // and the only lever the coordinator has over a Realm that never
          // woke for the first message. A group that reports only after a
          // retransmit is evidence of a lost wake-up, not of a slow test.
          if (waited >= groupDeadline / 4) {
            if (group.nudges === 0) {
              write(`# re-sending start for ${group.label} after ${Math.round(waited)}ms`);
            }
            group.nudges++;
            group.nudge();
          }
          continue;
        }
        inFlight.delete(index);
        write(
          `# abandoning ${group.label} after ${Math.round(waited)}ms in ${group.stage} and ${group.nudges} retransmit(s); its own deadline did not fire`,
        );
        const pool = reactorPoolStats();
        if (pool !== null) write(`# reactor pool: ${JSON.stringify(pool)}`);
        group.force({
          file: { display: group.label, specifier: group.label },
          result: {
            output: [],
            diagnostics: [],
            tests: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            error: `${group.label} did not report within ${groupDeadline}ms (stage ${group.stage})`,
          },
        });
      }
    };
    const watchdog = startStallWatchdog(
      write,
      () => [...pendingFiles.keys()],
      () => channel.stats(),
      () => [...inFlight.values()].map((group) => `${group.label} [${group.stage}]`),
      sweepOverdueGroups,
      watchdogTickMs(options),
      stallThresholdMs(options),
    );
    const progress = watchdog.progress;
    const stopStallWatchdog = watchdog.stop;
    const output = (async () => {
      let total = 0;
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      const diagnostics: PreparedTestDiagnostic[] = [];
      for await (const entry of channel) {
        const points = parallelResultPointCount(entry);
        if (points !== 1) {
          write(
            `Bail out! ${tapName(entry.file.display)} emitted ${points} points for one admitted test group`,
          );
          throw new Error(`${entry.file.display} emitted an invalid top-level test result`);
        }
        const synthetic = printParallelResult(entry, total, diagnostics, write);
        total += entry.result.tests + synthetic;
        passed += entry.result.passed;
        failed += entry.result.failed + synthetic;
        skipped += entry.result.skipped;
      }
      return { total, passed, failed, skipped, diagnostics };
    })();

    const activeFiles = new Set<Promise<void>>();
    const pendingFiles = new Map<string, PreparedParallelTest>();
    const fileCompletions: Promise<void>[] = [];
    const taskCompletions: Promise<void>[] = [];
    const lifecycleErrors: string[] = [];
    let registeredTests = 0;
    for (const file of files) {
      while (activeFiles.size >= concurrency) await Promise.race(activeFiles);
      const test = await prepareParallelFile(file, options, signal);
      registeredTests += test.registeredTests.length;
      let fileCompletion!: Promise<void>;
      fileCompletion = test.completion
        .then((completion) => {
          if (completion.shutdownError !== undefined) {
            lifecycleErrors.push(`${file.display} shutdown failed: ${completion.shutdownError}`);
          }
          if (completion.callError !== undefined) {
            lifecycleErrors.push(`${file.display} worker failed: ${completion.callError}`);
          }
          if (completion.realmError !== undefined) {
            lifecycleErrors.push(`${file.display} Realm shutdown failed: ${completion.realmError}`);
          }
        })
        .finally(() => activeFiles.delete(fileCompletion));
      activeFiles.add(fileCompletion);
      pendingFiles.set(file.display, test);
      void fileCompletion.finally(() => pendingFiles.delete(file.display));
      void test.completionReported.then((reported) => {
        // This timer also keeps the coordinator Realm alive until the worker's
        // final exit signal is delivered. A pending Promise alone does not keep
        // the event loop referenced, and the acknowledgement clears the
        // worker's own fallback timer before Realm.run() necessarily settles.
        const exitDiagnostic = loopTimeout(PARALLEL_REALM_EXIT_DIAGNOSTIC_MS);
        void exitDiagnostic.then(() => {
          if (!pendingFiles.has(file.display)) return;
          write(
            `# Waiting for ${tapName(file.display)} test Realm to exit; active handles at worker completion: ${reported.activeHandles ?? 'unavailable'}`,
          );
        });
        void fileCompletion.finally(() => exitDiagnostic.cancel());
      });
      fileCompletions.push(fileCompletion);

      let previous: Promise<void> | undefined;
      for (let index = 0; index < test.registeredTests.length; index++) {
        const { exclusive } = test.registeredTests[index]!;
        let release!: () => void;
        const settled = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = previous;
        previous = settled;
        const resolver = channel.claim();
        const groupLabel = `${file.display} group ${index}${exclusive ? ' (exclusive)' : ''}`;
        const task = (async () => {
          await resolver.schedule({ exclusive, ready });
          let forceGroup!: (result: ParallelTestResult) => void;
          const forced = new Promise<ParallelTestResult>((resolve) => {
            forceGroup = resolve;
          });
          const tracked: InFlightGroup = {
            label: groupLabel,
            stage: 'scheduled',
            startedAt: performance.now(),
            nudges: 0,
            nudge: () => test.retryStart(index),
            force: forceGroup,
          };
          inFlight.set(resolver.index, tracked);
          try {
            resolver.resolve(
              await Promise.race([
                test.execute(index, (stage) => {
                  tracked.stage = stage;
                }),
                forced,
              ]),
            );
          } catch (error) {
            resolver.resolve({
              file: test.file,
              result: {
                output: [],
                diagnostics: [],
                tests: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                error: errorText(error),
              },
            });
          } finally {
            inFlight.delete(resolver.index);
            progress();
            release();
          }
        })();
        taskCompletions.push(task);
      }
    }
    channel.close();
    await Promise.all(taskCompletions);
    const totals = await output;
    // Past this point there is no test progress left to watch, and the wait
    // below has its own deadline. Leaving the watchdog armed would let it race
    // that deadline and report a legitimate slow shutdown as a stall.
    stopStallWatchdog();
    // Every group has reported by here; what is left is each worker Realm
    // shutting down. A Realm that never exits would otherwise hold the run
    // open forever with nothing left to report — the original shape of this
    // failure in CI, where the log ends after the last group and the job is
    // cancelled at its own timeout with an orphaned child behind it.
    const shutdownDeadline = stallThresholdMs(options);
    if (shutdownDeadline > 0) {
      const expiry = loopTimeout(shutdownDeadline);
      expiry.unref();
      const finished = await Promise.race([
        Promise.all(fileCompletions).then(() => true),
        expiry.then(() => false),
      ]);
      if (!finished) {
        for (const name of pendingFiles.keys()) {
          lifecycleErrors.push(`${name} test Realm did not exit within ${shutdownDeadline}ms`);
        }
      } else {
        expiry.cancel();
      }
    } else {
      await Promise.all(fileCompletions);
    }
    await capture.finish();
    stopStallWatchdog();
    if (totals.total !== registeredTests) {
      write(`Bail out! registered ${registeredTests} test groups but emitted ${totals.total}`);
      throw new Error('parallel test registration count changed during execution');
    }
    write(`1..${registeredTests}`);
    write('');
    write(`# tests ${totals.total}`);
    write(`# pass  ${totals.passed}`);
    if (totals.skipped > 0) write(`# skip  ${totals.skipped}`);
    write(`# time  ${formatDurationMs(performance.now() - started)}`);
    if (totals.failed > 0) {
      write(`# fail  ${totals.failed}`);
      printParallelFailureDetails(totals.diagnostics, options.showOutput ?? 'failures', write);
    }
    if (lifecycleErrors.length > 0) {
      write('# Realm lifecycle errors');
      for (const error of lifecycleErrors) {
        for (const line of error.split('\n')) write(`# ${line}`);
      }
      write('Bail out! parallel test Realm lifecycle failed');
      throw new Error('parallel test Realm lifecycle failed');
    }
    if (totals.failed > 0) {
      throw new Error(`${totals.failed} test(s) failed`);
    }
  } finally {
    await capture.finish();
  }
}
/**
 * Convert an expanded test file path into an importable module specifier.
 *
 * Absolute and cwd-relative paths become `file://` URLs; anything already
 * carrying a scheme (`file://`, `fino:`, `internal:`) passes through
 * unchanged so built-in modules can be named directly on the command line.
 */
function normalizeModuleSpecifier(path: string): string {
  if (path.startsWith('file://')) return path;
  if (path.startsWith('/')) return `file://${path}`;
  if (path.startsWith('./') || path.startsWith('../')) return `file://${cwd()}/${path}`;
  if (path.includes(':')) return path;
  return `file://${cwd()}/./${path}`;
}
/**
 * Whether a path follows the `*.test.ts` naming convention for test modules.
 *
 * Used after expansion to prefer test modules over helper files that happen
 * to live alongside them.
 */
function isTestModuleFile(path: string): boolean {
  return path.endsWith('.test.ts');
}

/**
 * Expand a single CLI argument into a sorted list of file paths to import.
 *
 * - If the argument contains `*`, `?`, or `{` it is treated as a glob
 *   pattern resolved against the current working directory.
 * - If the argument ends with `/` or has no file extension it is treated as
 *   a directory and expanded to every `.test.ts` file beneath it.
 * - Otherwise it is returned as-is, a single direct file path.
 *
 * Glob and directory expansions are sorted so run order is deterministic; a
 * pattern that matches nothing yields an empty list rather than throwing —
 * the command reports the error after all arguments are expanded.
 */
async function expandArg(arg: string): Promise<string[]> {
  const isGlob = arg.includes('*') || arg.includes('?') || arg.includes('{');
  const isDir = arg.endsWith('/') || !/\.[^/]+$/.test(arg);
  if (!isGlob && !isDir) {
    return [arg];
  }
  const fs = new DiskFileSystem();
  const pattern = isGlob ? arg : arg.replace(/\/$/, '') + '/**/*.test.ts';
  const base = cwd();
  const results: string[] = [];
  for await (const entry of fs.glob(pattern, {
    cwd: base,
    onlyFiles: true,
  })) {
    results.push(entry.path.toString());
  }
  results.sort();
  return results;
}
/**
 * The `test` subcommand mounted by the root Fino CLI.
 *
 * The command requires at least one positional path. Each argument is
 * expanded (directories to their `.test.ts` files, globs from the current
 * working directory, direct files as given); when the expanded set contains
 * any `.test.ts` module, non-test helper files that also matched are dropped
 * so directory and glob inputs only import real test modules. Every surviving
 * file is imported for its registration side effects, then the run is handed
 * to `run()` from `fino:test/test`.
 *
 * Options map straight onto the runner: `--filter` keeps only `describe()`
 * groups whose full path contains the given substring, `--show-output`
 * controls when captured console output is printed (`failures` — the
 * default — `always`, or `never`), and `--durations` appends
 * `duration=<time>` metadata to every TAP result line. `--parallel` runs one
 * isolated Realm per file with up to ten executing top-level groups per reactor
 * thread by default and one active group per Realm. `FINO_TEST_CONCURRENCY`
 * changes the number of groups admitted per reactor. A settled group releases its slot
 * immediately and emits as one atomic TAP block. Results emit in completion
 * order by default; `--ordered` holds later results until all earlier registered
 * groups have completed.
 * `--coverage` enables native V8 precise coverage and writes
 * `coverage/coverage.json`; use the unambiguous inline form
 * `--coverage=<path>` for another artifact location.
 *
 * Output is TAP text by default. When invoked with a `json` writer (for
 * example `fino test --json ...`) the command instead emits a single JSON
 * object describing the run: the raw inputs, the imported files, the
 * effective options, and the runner's output.
 *
 * Throws if no files are supplied, if expansion matches no files, or if
 * `--show-output` is given an unrecognized value. Test failures do not throw
 * here — they are reported through the runner's TAP output and exit code.
 *
 * ```ts no_run
 * import test from 'fino:commands/test';
 *
 * // Everything under tests/, with per-test durations.
 * await test.parse(['--durations', 'tests/']);
 *
 * // Multiplex isolated test files across the process reactor pool.
 * await test.parse(['--parallel', 'tests/']);
 *
 * // Keep parallel TAP groups in deterministic registration order.
 * await test.parse(['--parallel', '--ordered', 'tests/']);
 *
 * // Just the socket suites, showing console output even on success.
 * await test.parse(['--filter', 'socket', '--show-output', 'always', 'tests/net']);
 *
 * // Collect original-source coverage while running the same tests.
 * await test.parse(['--coverage=artifacts/socket.json', 'tests/net']);
 * ```
 */
/**
 * How long the runner waits, after every test has reported, for the Realm to
 * fall idle before it treats the remainder as a leak.
 */
const SHUTDOWN_GRACE_MS = 5_000;
/**
 * Fail the run if the Realm is still held open once the results are in.
 *
 * A test that leaks a descriptor watch, a timer, or a child process does not
 * fail — it finishes, reports `ok`, and then keeps the loop alive so the
 * process never exits. CI sees no failure at all, just a job cancelled at its
 * own timeout with nothing in the log after the last group. This turns that
 * into a diagnosis: which handle kinds are still registered, printed against
 * the run that leaked them.
 *
 * The watchdog timer is unreferenced, so it can only fire while something else
 * is holding the Realm open — exactly the condition worth reporting.
 *
 * Only applies when this command owns the process. `fino test` also runs
 * in-process, nested inside another run's tests, and there the live handles
 * belong to the caller — reporting them would be wrong and exiting would take
 * the caller down with us.
 */
/**
 * Import one test module under a deadline.
 *
 * A module whose top level never settles would otherwise hold a serial run
 * open for the life of the job with no test to blame it on. The import cannot
 * be cancelled, so the only useful outcome is to name the file and exit; the
 * message goes to `console.log` because `exit()` flushes stdout while the
 * command writer buffers separately.
 */
async function importWithin(specifier: string, display: string, deadlineMs: number): Promise<void> {
  if (deadlineMs <= 0) {
    await import(specifier);
    return;
  }
  const expiry = loopTimeout(deadlineMs);
  expiry.unref();
  const loaded = await Promise.race([import(specifier).then(() => true), expiry.then(() => false)]);
  if (!loaded) {
    console.log(`Bail out! ${tapName(display)} did not finish loading within ${deadlineMs}ms`);
    console.log(`# active handles: ${JSON.stringify(activeHandleCounts())}`);
    processExit(1);
  }
  expiry.cancel();
}
async function reportLeakedHandles(ownsProcess: boolean): Promise<boolean> {
  if (!ownsProcess || !loopAlive()) return false;
  const grace = loopTimeout(SHUTDOWN_GRACE_MS);
  grace.unref();
  await grace;
  if (!loopAlive()) return false;
  const counts = activeHandleCounts();
  const held = Object.entries(counts)
    .filter(([, value]) => (typeof value === 'number' ? value > 0 : value === true))
    .map(([name, value]) => `${name}=${String(value)}`);
  // console goes to the same stdout `exit()` flushes synchronously; a task
  // writer buffers separately and would lose the diagnostic on the way out.
  console.log(`# leaked handles: still alive ${SHUTDOWN_GRACE_MS}ms after the last test reported`);
  console.log(
    `# ${held.length > 0 ? held.join(' ') : 'no counted handles; V8 tasks or a wake source'}`,
  );
  console.log('# exiting rather than hanging; find the test that did not clean up');
  return true;
}
const command = new Task({
  name: 'test',
  description: 'Run test files',
  outputMode: 'both',
  run: async function runTestCommand(
    input: {
      files?: unknown[];
      filter?: unknown;
      'show-output'?: unknown;
      durations?: unknown;
      parallel?: unknown;
      ordered?: unknown;
      coverage?: unknown;
      timeout?: unknown;
    },
    ctx,
  ) {
    // `fino test` can be invoked from inside a test — the CLI's own suite does
    // it — and a nested run must not judge the outer run's handles as its own
    // leak, nor exit the process out from under it. A live loop is not the
    // signal: a bare script already has a wake-pipe read registered.
    const ownsProcess = !testRunActive();
    const testFiles = Array.isArray(input.files) ? input.files : [];
    const filter = typeof input.filter === 'string' ? input.filter : undefined;
    const showOutput = typeof input['show-output'] === 'string' ? input['show-output'] : 'failures';
    const durations = input.durations === true;
    const parallel = input.parallel === true;
    const ordered = input.ordered === true;
    const coveragePath = typeof input.coverage === 'string' ? input.coverage : undefined;
    const timeout = typeof input.timeout === 'number' ? input.timeout : undefined;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
      throw new Error(`Invalid --timeout value "${String(input.timeout)}" (expected ms >= 0)`);
    }
    if (showOutput !== 'failures' && showOutput !== 'always' && showOutput !== 'never') {
      throw new Error(
        `Invalid --show-output value "${showOutput}" (expected failures, always, or never)`,
      );
    }
    if (testFiles.length === 0) {
      throw new Error('fino test: no test files specified');
    }
    if (coveragePath !== undefined) await startCoverage(coveragePath);
    allowInternalForTests();
    const expandedFiles: string[] = [];
    for (const raw of testFiles) {
      const expanded = await expandArg(String(raw));
      expandedFiles.push(...expanded);
    }
    const importFiles = expandedFiles.some(isTestModuleFile)
      ? expandedFiles.filter(isTestModuleFile)
      : expandedFiles;
    if (importFiles.length === 0) {
      throw new Error(`fino test: no test files matched ${testFiles.map(String).join(', ')}`);
    }
    const runOptions =
      filter === undefined
        ? {
            showOutput,
            durations,
            timeout,
          }
        : {
            filter,
            showOutput,
            durations,
            timeout,
          };
    let output: unknown;
    const parallelFiles: ParallelTestFile[] = [];
    if (parallel) {
      const seen = new Set<string>();
      for (const file of importFiles) {
        const specifier = normalizeModuleSpecifier(file);
        if (seen.has(specifier)) continue;
        seen.add(specifier);
        parallelFiles.push({
          display: file,
          specifier,
        });
      }
    }
    // A failing run throws, and the leak check has to happen anyway: a test
    // that both fails and leaks would otherwise print its failure and then
    // hang forever on the leaked handle, since nothing after this point runs.
    let runFailure: unknown;
    try {
      if (parallel) {
        output = await runParallelTests(parallelFiles, runOptions, ctx.signal, ordered);
      } else {
        const importDeadline = workerResultDeadlineMs(runOptions);
        for (const file of importFiles) {
          await importWithin(normalizeModuleSpecifier(file), file, importDeadline);
        }
        const { run } = await import('fino:test/test');
        output = await run(runOptions);
      }
    } catch (error) {
      runFailure = error;
    }
    if (await reportLeakedHandles(ownsProcess)) {
      // Throwing would not help: whatever leaked still holds the loop open, so
      // the process would report the failure and then hang anyway. Exiting is
      // the only way to turn the leak into a result CI can see. Print why the
      // run failed first, because exiting skips the CLI's own error reporting.
      if (runFailure !== undefined) console.log(`# ${errorText(runFailure)}`);
      processExit(1);
    }
    if (runFailure !== undefined) throw runFailure;
    if (ctx.writer.mode === 'json') {
      const result = {
        command: 'test',
        ok: true,
        files: testFiles.map(String),
        imported: importFiles,
        filter,
        showOutput,
        durations,
        timeout,
        parallel,
        ordered,
        coverage: coveragePath,
        output,
      };
      await ctx.writer.writeJson(result);
      return result;
    }
    return output;
  },
  cli: {
    options: [
      {
        flags: '--filter',
        type: 'string',
        description: 'Run only describe groups whose full path contains the filter text',
      },
      {
        flags: '--show-output',
        type: 'string',
        description: 'Show captured console output: failures, always, or never',
      },
      {
        flags: '--durations',
        type: 'boolean',
        description: 'Annotate TAP result lines with duration metadata',
      },
      {
        flags: '--parallel',
        type: 'boolean',
        description: 'Run test files in isolated concurrent Realms',
      },
      {
        flags: '--ordered',
        type: 'boolean',
        description: 'Emit parallel test groups in deterministic registration order',
      },
      {
        flags: '--timeout',
        type: 'number',
        description: 'Per-test deadline in ms (default 60000; 0 waits forever)',
      },
      {
        flags: '--coverage',
        type: 'string',
        implicitValue: 'coverage/coverage.json',
        description: 'Collect native V8 coverage; use --coverage=<path> for a custom JSON artifact',
      },
    ],
    positionals: [
      {
        name: 'files',
        type: 'string',
        multiple: true,
        required: true,
        description: 'Test files to import and run',
      },
    ],
  },
});
export { command as default };
