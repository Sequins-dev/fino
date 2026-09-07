/**
 * internal:test-worker — execute one test module inside an isolated Realm.
 *
 * The worker imports its module once, snapshots the top-level registrations,
 * and reports their count before any test closure runs. The parent then admits
 * individual top-level entries through its concurrency channel. Entry results
 * are structured-clone-safe buffered TAP records. A worker serializes its own
 * entries because they share module state, while different file Realms overlap.
 *
 * Shutdown hooks run only after every registered entry settles. Direct writes
 * to stdout or stderr still bypass console capture.
 *
 * @internal
 */
import { allowInternalForTests } from 'internal:loader-hooks';
import { port } from 'fino:realm/self';
import { runShutdownHooks } from 'internal:shutdown';
import { _activeHandleCounts } from 'internal:runtime/loop';
import { installProcessExitHandler } from 'internal:process/exit';
import type { ConsoleCaptureRecord } from 'internal:globals/console';
import type { RunOptions } from '../test/test.ts';

const COMPLETION_ACK_TIMEOUT_MS = 1_000;

/** Registration message sent after a test module's top level has run. @internal */
export interface TestFileRegistration {
  kind: 'fino:test:registered';
  tests: Array<{ exclusive: boolean }>;
}

/** Admission message sent when one top-level entry may execute. @internal */
export interface TestGroupStart {
  kind: 'fino:test:start';
  index: number;
}

/** Plain structured-clone-safe result for one top-level test entry. @internal */
export interface TestGroupResult {
  /** Buffered TAP records for one root entry. */
  output: ConsoleCaptureRecord[];
  /** Structured failure details held until the aggregate summary. */
  diagnostics: Array<import('../test/test.ts').PreparedTestEntryResult['diagnostics'][number]>;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  error?: string;
}

/** Actual test/hook progress, carrying that operation's timeout. @internal */
export interface TestGroupProgress {
  kind: 'fino:test:progress';
  index: number;
  name: string;
  timeout: number;
}

/** Completion message for one admitted top-level entry. @internal */
export interface TestGroupCompletion {
  kind: 'fino:test:result';
  index: number;
  result: TestGroupResult;
}

/** Completion sent after every entry and Realm shutdown hook settles. @internal */
export interface TestFileCompletion {
  kind: 'fino:test:complete';
  shutdownError?: string;
  activeHandles?: string;
}

/** Parent acknowledgement that permits the worker Realm to exit. @internal */
export interface TestFileCompletionAck {
  kind: 'fino:test:complete-ack';
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** Import one file and execute its top-level entries as separately admitted tasks. @internal */
export default async function runTestFile(
  specifier: string,
  options: RunOptions,
): Promise<TestFileCompletion> {
  if (port === undefined) throw new Error('test worker requires a Realm port');
  installProcessExitHandler((code) => {
    throw new Error(`test file requested process exit with code ${code}`);
  });
  allowInternalForTests();
  const testModule = await import('fino:test/test');
  let prepared: ReturnType<typeof testModule._prepareRun> | undefined;
  let loadError: string | undefined;
  try {
    await import(specifier);
    prepared = testModule._prepareRun(options);
  } catch (error) {
    testModule._prepareRun(options);
    loadError = errorText(error);
  }

  const count = loadError === undefined ? prepared!.count : 1;
  let remaining = count;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Set<number>();
  let executionTail = Promise.resolve();
  let acknowledgeCompletion!: () => void;
  const completionAcknowledged = new Promise<void>((resolve) => {
    acknowledgeCompletion = resolve;
  });
  const onMessage = (event: Event) => {
    const message = (event as MessageEvent).data as
      | TestGroupStart
      | TestFileCompletionAck
      | undefined;
    if (message?.kind === 'fino:test:complete-ack') {
      acknowledgeCompletion();
      return;
    }
    if (message?.kind !== 'fino:test:start') return;
    const index = message.index;
    if (!Number.isSafeInteger(index) || index < 0 || index >= count || started.has(index)) return;
    started.add(index);
    executionTail = executionTail.then(async () => {
      let result: TestGroupResult;
      if (loadError !== undefined) {
        result = {
          output: [],
          diagnostics: [],
          tests: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          error: loadError,
        };
      } else {
        try {
          const entry = await testModule._runPreparedEntry(
            prepared!,
            index,
            options,
            (name, timeout) => {
              port.postMessage({
                kind: 'fino:test:progress',
                index,
                name,
                timeout,
              } satisfies TestGroupProgress);
            },
          );
          result = {
            ...entry,
            tests: entry.passed + entry.failed + entry.skipped,
          };
        } catch (error) {
          result = {
            output: [],
            diagnostics: [],
            tests: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            error: errorText(error),
          };
        }
      }
      port.postMessage({
        kind: 'fino:test:result',
        index,
        result,
      } satisfies TestGroupCompletion);
      remaining--;
      if (remaining === 0) finish();
    });
  };
  port.addEventListener('message', onMessage);
  port.start();
  port.postMessage({
    kind: 'fino:test:registered',
    tests:
      loadError === undefined
        ? prepared!.exclusive.map((exclusive) => ({ exclusive }))
        : [{ exclusive: false }],
  } satisfies TestFileRegistration);
  if (remaining > 0) await finished;
  let completion: TestFileCompletion;
  try {
    await runShutdownHooks();
    completion = {
      kind: 'fino:test:complete',
      activeHandles: JSON.stringify(_activeHandleCounts()),
    };
  } catch (error) {
    completion = {
      kind: 'fino:test:complete',
      shutdownError: errorText(error),
      activeHandles: JSON.stringify(_activeHandleCounts()),
    };
  }
  port.postMessage(completion);
  let ackTimeout: ReturnType<typeof setTimeout> | undefined;
  // Keep this deadline referenced: after posting completion it is the sole
  // guarantee that a lost parent acknowledgement cannot strand the worker.
  await Promise.race([
    completionAcknowledged,
    new Promise<void>((resolve) => {
      ackTimeout = setTimeout(resolve, COMPLETION_ACK_TIMEOUT_MS);
    }),
  ]);
  if (ackTimeout !== undefined) clearTimeout(ackTimeout);
  port.removeEventListener('message', onMessage);
  return completion;
}
