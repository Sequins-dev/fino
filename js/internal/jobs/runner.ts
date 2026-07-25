/**
* internal/jobs/runner — job execution: task registry, wire envelopes, and
* the dispatch logic shared by every processor kind.
*
* This module is the seam between the jobs scheduler and the user's task
* definitions. It knows nothing about queues, leases, or timers — it takes a
* single `JobsWireCall` envelope, finds the named `Task`, runs it, and hands
* back a `JobsWireResult`. Every processor kind reuses it: the inline
* processor (`fino:jobs` client mode), the in-realm service processor, and the
* pool-worker default export all funnel through `dispatchJob`.
*
* Errors are returned as values, never thrown across a processor boundary.
* A `RealmPool` worker communicates over a serialization wire that flattens a
* thrown `Error` to `{message, stack}` and drops everything else, so the
* scheduler-critical fields — whether a failure is `retryable`, and whether a
* durable run `parked` rather than finished — would not survive the trip. By
* modelling those as ordinary result variants, dispatch behaves identically
* whether it runs in the same realm or across a process boundary.
*
* Plain tasks run once per call. Durable tasks perform exactly one workflow
* drive against a `WorkflowStore` and report a park (a pending timer or signal
* wait) instead of blocking on it; the scheduler owns the timers and issues a
* fresh call when the wait is due. Retryability is derived from the error name
* (`NonRetryableJobError` / `NonRetryableWorkflowError` opt out) so tasks can
* signal "do not retry" without the runner knowing their domain.
*
* ```ts no_run
* import { collectTasks, dispatchJob } from 'internal:jobs/runner';
* import { InMemoryWorkflowStore } from 'fino:workflow';
*
* const registry = collectTasks([greetTask, checkoutWorkflow]);
* const result = await dispatchJob(
*   registry,
*   { kind: 'run', jobId: 'j-1', task: 'greet', input: { name: 'Ada' }, attempt: 1 },
*   new InMemoryWorkflowStore(),
* );
* if (result.ok) console.log(result.output);
* ```
*
* @internal
*/
import { Task } from '../../task.ts';
import { DurableTask } from '../../task/durable.ts';
import type { WorkflowStore, WorkflowWait } from '../../workflow.ts';

/**
* One job execution request delivered to a processor.
*
* This is the envelope the scheduler puts on the wire for a single attempt.
* `jobId` identifies the job row; `task` is the registered task name to look
* up; `input` is the task payload, serialized across a pool boundary. `attempt`
* starts at 1 and increments on each retry. For durable tasks `workflowRunId`
* names the workflow run to start or resume — when omitted the runner derives
* one from `jobId` — and `timeoutMs`, when set, bounds a plain-task run.
*
* The `kind: 'run'` discriminant distinguishes a real execution request from
* the control envelopes a worker also accepts (see `taskWorker`), so a
* processor can branch on `call.kind` before trusting the other fields.
*
* ```ts no_run
* const call: JobsWireCall = {
*   kind: 'run',
*   jobId: 'job-9f2',
*   task: 'sendEmail',
*   input: { to: 'ada@example.com', subject: 'Hi' },
*   attempt: 1,
*   timeoutMs: 30_000,
* };
* ```
*
* @internal
*/
export interface JobsWireCall {
  /** Discriminant marking this as an execution request rather than a control envelope. */
  kind: 'run';
  /** Identifier of the job row this attempt belongs to. */
  jobId: string;
  /** Registered task name to look up in the processor's registry. */
  task: string;
  /** Task payload, serialized when the call crosses a pool-worker boundary. */
  input: unknown;
  /** Attempt number, starting at 1 and incremented on each retry. */
  attempt: number;
  /** Workflow run to start or resume for a durable task; defaults to a value derived from `jobId`. */
  workflowRunId?: string;
  /** Optional wall-clock bound, in milliseconds, for a plain-task run. */
  timeoutMs?: number;
}
/**
* Processor execution outcome.
*
* A tagged union with three arms, discriminated by which key is present:
* `ok: true` carries the task's `output`; `ok: false` carries a flattened
* `error` with a `retryable` flag the scheduler uses to decide whether to
* re-enqueue; and `parked: true` reports that a durable run suspended on a
* timer or signal (`waitingOn`) under `workflowRunId`, so the scheduler should
* arm the wait rather than treat the job as finished or failed.
*
* The shape is deliberately plain data with no thrown state, so it round-trips
* unchanged across the pool serialization wire.
*
* ```ts no_run
* function handle(result: JobsWireResult) {
*   if ('ok' in result && result.ok) return result.output;
*   if ('parked' in result) return armWait(result.workflowRunId, result.waitingOn);
*   if ('ok' in result) throw new Error(result.error.message);
* }
* ```
*
* @internal
*/
export type JobsWireResult = {
  ok: true;
  output: unknown;
} | {
  ok: false;
  error: {
    message: string;
    stack?: string;
    retryable: boolean;
  };
} | {
  parked: true;
  workflowRunId: string;
  waitingOn: WorkflowWait;
};

/**
* Collect a task and its descendants into a name-keyed registry.
*
* Walks each root depth-first, following `task.list()` so that tasks composed
* as sub-tasks become individually addressable by name — a processor can then
* dispatch any task in the tree, not just the roots. The returned map is what
* `dispatchJob` and `taskWorker` look a call's `task` name up in.
*
* Task names must be globally unique across the whole collected set, since the
* wire only carries a name. Throws if the same name appears twice anywhere in
* the tree, because a silent collision would route jobs to the wrong task.
*
* ```ts no_run
* import { collectTasks } from 'internal:jobs/runner';
*
* const registry = collectTasks([emailTasks, billingWorkflow]);
* for (const name of registry.keys()) console.log('registered:', name);
* ```
*
* @internal
*/
export function collectTasks(roots: Task[]): Map<string, Task> {
  const registry = new Map<string, Task>();
  const visit = (task: Task) => {
    if (registry.has(task.name)) {
      throw new Error(`duplicate task name "${task.name}" in jobs registry`);
    }
    registry.set(task.name, task);
    for (const child of task.list()) visit(child);
  };
  for (const root of roots) visit(root);
  return registry;
}

function errorResult(err: unknown): JobsWireResult {
  const name = err instanceof Error ? err.name : '';
  return {
    ok: false,
    error: {
      message: err instanceof Error ? err.message : String(err),
      ...err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {},
      retryable: name !== 'NonRetryableJobError' && name !== 'NonRetryableWorkflowError'
    }
  };
}

/**
* Execute one job against a registry of tasks.
*
* Looks `call.task` up in `registry` and runs it, returning the outcome as a
* `JobsWireResult` value. An unknown task name is a non-retryable error — no
* amount of retrying will make it appear — so it returns immediately rather
* than throwing.
*
* Plain tasks run once per call via `task.run()`, and their return value
* becomes `output`. Durable tasks perform exactly one workflow drive against
* `workflowStore`, starting or resuming `call.workflowRunId` (or a run id
* derived from `jobId` when the call omits one). A durable run that suspends
* returns the `parked` variant with its `waitingOn`; one that finishes returns
* `ok: true`; and one that errored or was cancelled returns `ok: false`, with
* `retryable` cleared for cancellations and for errors whose message names a
* non-retryable failure. This function never waits out a park — the scheduler
* owns the timers and re-dispatches when the wait is due.
*
* Any error thrown by the task itself is caught and converted to an
* `ok: false` result; it is not propagated to the caller.
*
* ```ts no_run
* import { collectTasks, dispatchJob } from 'internal:jobs/runner';
* import { InMemoryWorkflowStore } from 'fino:workflow';
*
* const registry = collectTasks([checkoutWorkflow]);
* const store = new InMemoryWorkflowStore();
* const result = await dispatchJob(
*   registry,
*   { kind: 'run', jobId: 'j-42', task: 'checkout', input: { cart: 7 }, attempt: 1 },
*   store,
* );
* if ('parked' in result) {
*   console.log('suspended on', result.waitingOn.type);
* } else if (result.ok) {
*   console.log('done', result.output);
* }
* ```
*
* @internal
*/
export async function dispatchJob(registry: Map<string, Task>, call: JobsWireCall, workflowStore: WorkflowStore): Promise<JobsWireResult> {
  const task = registry.get(call.task);
  if (task === undefined) {
    return {
      ok: false,
      error: {
        message: `no task named "${call.task}" is registered with this processor`,
        retryable: false
      }
    };
  }
  try {
    if (task instanceof DurableTask) {
      const workflowRunId = call.workflowRunId ?? `job-${call.jobId}`;
      const handle = await task.start(call.input, {
        runId: workflowRunId,
        store: workflowStore
      });
      if (handle.status === 'waiting') {
        return {
          parked: true,
          workflowRunId,
          waitingOn: handle.waitingOn!
        };
      }
      if (handle.status === 'done') {
        return {
          ok: true,
          output: handle.result
        };
      }
      return {
        ok: false,
        error: {
          message: handle.error?.message ?? `durable run ended with status ${handle.status}`,
          ...handle.error?.stack !== undefined ? { stack: handle.error.stack } : {},
          retryable: handle.status !== 'cancelled' && !/NonRetryable/.test(handle.error?.message ?? '')
        }
      };
    }
    const output = await task.run(call.input, { runId: call.jobId });
    return {
      ok: true,
      output
    };
  } catch (err) {
    return errorResult(err);
  }
}

/**
* Build the pool-worker dispatcher for a task tree.
*
* Returns the function a `RealmPool` worker realm default-exports: the pool
* invokes it once per delivered envelope. It collects `root` and its
* descendants into a registry once, then handles two envelope kinds. A
* `{ kind: 'tasks' }` control envelope returns the list of registered task
* names (the pool owner uses this to route jobs to workers that can serve
* them). A `{ kind: 'run', ... }` envelope is dispatched through `dispatchJob`.
* Anything else is rejected as a malformed, non-retryable call rather than
* throwing across the wire.
*
* Durable checkpoints need a `WorkflowStore`, which a worker realm cannot own
* directly. The store is resolved lazily by importing the
* `fino:jobs/checkpoints` facade the pool owner injects at spawn, and adapting
* its `save`/`load`/`list`/`remove` calls to the `WorkflowStore` contract. The
* import happens only the first time a durable task actually runs and is cached
* thereafter, so plain-task-only workers never import the facade. If a durable
* task runs in a realm where the facade was not injected, the failed import is
* surfaced as a retryable error result explaining that the facade is missing.
*
* ```ts no_run
* // Inside a pool-worker entry module:
* import { taskWorker } from 'internal:jobs/runner';
* import { emailTasks } from '../tasks/email.ts';
*
* export default taskWorker(emailTasks);
* ```
*
* @internal
*/
export function taskWorker(root: Task): (call: JobsWireCall) => Promise<JobsWireResult> {
  const registry = collectTasks([root]);
  let facadeStore: Promise<WorkflowStore> | undefined;
  const resolveStore = (): Promise<WorkflowStore> => {
    facadeStore ??= import('fino:jobs/checkpoints').then((mod) => {
      const facade = mod as {
        save(state: unknown): Promise<void>;
        load(runId: string): Promise<unknown>;
        list(filter?: unknown): Promise<unknown[]>;
        remove(runId: string): Promise<void>;
      };
      return {
        save: (state) => facade.save(state),
        load: (runId) => facade.load(runId),
        list: (filter) => facade.list(filter),
        delete: (runId) => facade.remove(runId)
      } as WorkflowStore;
    }, (err) => {
      throw new Error(`durable jobs need the fino:jobs/checkpoints facade in this worker realm: ${err instanceof Error ? err.message : String(err)}`);
    });
    return facadeStore;
  };
  return async (call: JobsWireCall | {
    kind: 'tasks';
  }): Promise<JobsWireResult | string[]> => {
    if (call !== null && typeof call === 'object' && call.kind === 'tasks') {
      return [...registry.keys()];
    }
    if (call === null || typeof call !== 'object' || call.kind !== 'run') {
      return {
        ok: false,
        error: {
          message: 'jobs worker received a malformed call envelope',
          retryable: false
        }
      };
    }
    const needsStore = registry.get(call.task) instanceof DurableTask;
    let store: WorkflowStore;
    try {
      store = needsStore ? await resolveStore() : undefined as unknown as WorkflowStore;
    } catch (err) {
      return errorResult(err);
    }
    return dispatchJob(registry, call, store);
  };
}
