/**
* internal:scheduler/readiness — run parked isolates over a shared TypeScript
* readiness loop.
*
* This is a focused scheduler prototype. Each workload is a separate V8
* isolate, but all of its `readable()` and `writable()` waits are forwarded as
* scalar `{ fd }` requests to the scheduler isolate. The scheduler registers
* those waits on its own `internal:runtime/loop`, then resolves the workload
* promise when readiness arrives. Reads, writes, buffers, retry loops, and
* protocol policy stay inside the workload's TypeScript.
*
* The prototype intentionally handles readiness and async-FFI wakeups only. It
* does not yet provide placement, migration, budgets, or delegated timers and
* platform-specific watches.
*
* ```ts no_run
* import { runReadinessWorkload } from 'internal:scheduler/readiness';
*
* const result = await runReadinessWorkload('./worker.ts', { fd: socketFd });
* ```
*
* @internal
*/
import * as hostLoop from 'internal:runtime/loop';
import { Isolate, type HostOperation, type PumpOutcome } from './isolate.ts';
async function performReadinessOperation(operation: HostOperation): Promise<unknown> {
  const fd = Number(operation.args?.fd);
  if (!Number.isInteger(fd) || fd < 0) {
    throw new TypeError(`invalid readiness fd: ${String(operation.args?.fd)}`);
  }
  switch (operation.operation) {
    case 'readable': return await hostLoop.readable(fd);
    case 'writable':
      await hostLoop.writable(fd);
      return null;
    case 'removeRead':
      hostLoop.removeRead(fd);
      return null;
    case 'removeWrite':
      hostLoop.removeWrite(fd);
      return null;
    default: throw new Error(`unsupported scheduler host operation: ${operation.operation}`);
  }
}
interface PendingOperation {
  operation: HostOperation;
  promise: Promise<void>;
}
function startOperation(isolate: Isolate, operation: HostOperation, pending: Set<PendingOperation>): void {
  let record!: PendingOperation;
  const promise = (async () => {
    try {
      let ok = true;
      let value: unknown;
      try {
        value = await performReadinessOperation(operation);
      } catch (error) {
        ok = false;
        value = { message: error instanceof Error ? error.message : String(error) };
      }
      isolate.complete(operation.id, ok, JSON.stringify(value));
    } finally {
      pending.delete(record);
    }
  })();
  record = {
    operation,
    promise
  };
  pending.add(record);
}
function cancelOperation(operation: HostOperation): void {
  const fd = Number(operation.args?.fd);
  if (!Number.isInteger(fd) || fd < 0) return;
  if (operation.operation === 'readable') {
    hostLoop.removeRead(fd);
  } else if (operation.operation === 'writable') {
    hostLoop.removeWrite(fd);
  }
}
/**
* Run one workload isolate to completion on the caller's readiness loop.
*
* `entryPath` must default-export a function. `input` is JSON-serialized and
* passed to that function. The workload may use ordinary Fino stream and socket
* APIs: their actual syscalls and buffer handling execute inside the workload,
* while readiness promises are registered on the caller's single loop backend.
*
* Multiple calls may run concurrently. They share the caller's io_uring,
* kqueue, or poll backend without sharing V8 state. The returned promise rejects
* for unsupported host operations or workload failures, and the isolate is
* always disposed after settlement. Concurrent readiness requests resume the
* workload on the first completion; losing watches are cancelled at teardown
* rather than forming an all-operations barrier.
*
* ```ts no_run
* const [left, right] = await Promise.all([
*   runReadinessWorkload('./reader.ts', { fd: leftFd }),
*   runReadinessWorkload('./reader.ts', { fd: rightFd }),
* ]);
* ```
*
* @internal
*/
export async function runReadinessWorkload<T = unknown>(entryPath: string, input: unknown): Promise<T> {
  const isolate = new Isolate(entryPath);
  const pending = new Set<PendingOperation>();
  let wake: Promise<number> | undefined;
  let request = JSON.stringify(input);
  try {
    while (true) {
      const outcome: PumpOutcome = isolate.pump(request);
      request = '{}';
      switch (outcome.kind) {
        case 'settled': return outcome.value as T;
        case 'hostOperations': {
          for (const operation of outcome.operations) {
            startOperation(isolate, operation, pending);
          }
          await Promise.race(Array.from(pending, (operation) => operation.promise));
          break;
        }
        case 'pending': {
          wake ??= hostLoop.readable(isolate.wakeFd).finally(() => {
            wake = undefined;
          });
          if (pending.size === 0) {
            await wake;
          } else {
            await Promise.race([wake, ...Array.from(pending, (operation) => operation.promise)]);
          }
          break;
        }
      }
    }
  } finally {
    if (wake !== undefined) hostLoop.removeRead(isolate.wakeFd);
    for (const { operation } of pending) cancelOperation(operation);
    pending.clear();
    isolate.terminate();
  }
}
