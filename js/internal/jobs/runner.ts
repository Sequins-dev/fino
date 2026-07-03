/**
* internal/jobs/runner — job execution: task registry, wire envelopes, and
* the dispatch logic shared by every processor kind.
*
* Errors are returned as values, never thrown across a processor boundary —
* the pool wire flattens thrown errors to `{message, stack}` and the
* scheduler needs `retryable` and `parked` to survive the trip.
*
* @internal
*/
import { Task } from '../../task.ts';
import { DurableTask } from '../../task/durable.ts';
import type { WorkflowStore, WorkflowWait } from '../../workflow.ts';

/**
* One job execution request delivered to a processor.
*
* @internal
*/
export interface JobsWireCall {
  kind: 'run';
  jobId: string;
  task: string;
  input: unknown;
  attempt: number;
  workflowRunId?: string;
  timeoutMs?: number;
}
/**
* Processor execution outcome.
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
* @throws On duplicate names anywhere in the collected set.
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
* Plain tasks run once per call; durable tasks perform exactly one workflow
* drive against `workflowStore` (starting or resuming `workflowRunId`) and
* report parks instead of waiting them out — the scheduler owns timers.
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
* Build the pool-worker dispatcher for a task tree: the default-export
* function contract of `RealmPool`, executing `JobsWireCall` envelopes.
*
* Durable checkpoints flow through the `fino:jobs/checkpoints` facade the
* pool owner injects at spawn; plain-task-only workers never import it.
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
