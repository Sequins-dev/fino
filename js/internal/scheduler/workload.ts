/**
* internal:scheduler/workload — workload-side readiness bridge.
*
* This module is loaded only inside a parked workload isolate. It turns
* readiness calls into scalar host-operation records and resolves their
* promises when the TypeScript scheduler returns a result. Keeping the bridge
* here means native code never owns scheduler policy or I/O semantics.
*
* @internal
*/
import { tick } from 'internal:runtime/loop';
interface WorkloadModule {
  default?: (input: unknown) => unknown;
}
interface HostOperation {
  id: number;
  operation: string;
  args: unknown;
}
interface HostResolver {
  resolve(value: unknown): void;
  reject(reason: Error): void;
}
type SchedulerGlobal = typeof globalThis & {
  __finoSchedulerHostOps: HostOperation[];
  __finoSchedulerHostResolvers: Map<number, HostResolver>;
  __finoSchedulerNextHostOpId: number;
  __finoSchedulerHostOp?: (operation: string, args: unknown) => Promise<unknown>;
  __finoSchedulerTakeHostOps(): string;
  __finoSchedulerCompleteHostOp(id: number, ok: boolean, json: string): void;
  __finoSchedulerSettled(value: unknown): string;
  __finoSchedulerDispatch(input: unknown): Promise<unknown>;
  __finoSchedulerTick(timeoutMs: number): number;
};
/**
* Install the scalar operation bridge for one workload entry module.
*
* `delegatesReadiness` defaults to `true` for the scheduler-hosted model. A
* resident single-workload driver passes `false`, leaving readiness inside this
* isolate's ordinary TypeScript loop while native code retains the entered
* isolate across loop turns.
*
* @internal
*/
export function configureWorkload(entryPromise: Promise<WorkloadModule>, delegatesReadiness = true): void {
  const schedulerGlobal = globalThis as SchedulerGlobal;
  schedulerGlobal.__finoSchedulerHostOps = [];
  schedulerGlobal.__finoSchedulerHostResolvers = new Map();
  schedulerGlobal.__finoSchedulerNextHostOpId = 1;
  if (delegatesReadiness) {
    schedulerGlobal.__finoSchedulerHostOp = function hostOperation(operation, args) {
      const id = schedulerGlobal.__finoSchedulerNextHostOpId++;
      const promise = new Promise<unknown>((resolve, reject) => {
        schedulerGlobal.__finoSchedulerHostResolvers.set(id, {
          resolve,
          reject
        });
      });
      schedulerGlobal.__finoSchedulerHostOps.push({
        id,
        operation,
        args
      });
      return promise;
    };
  }
  schedulerGlobal.__finoSchedulerTakeHostOps = function takeHostOperations() {
    const operations = schedulerGlobal.__finoSchedulerHostOps;
    schedulerGlobal.__finoSchedulerHostOps = [];
    return JSON.stringify(operations);
  };
  schedulerGlobal.__finoSchedulerCompleteHostOp = function completeHostOperation(id, ok, json) {
    const resolver = schedulerGlobal.__finoSchedulerHostResolvers.get(id);
    if (resolver === undefined) return;
    schedulerGlobal.__finoSchedulerHostResolvers.delete(id);
    const value = JSON.parse(json);
    if (ok) resolver.resolve(value);
    else {
      const message = typeof value === 'object' && value !== null && 'message' in value ? String(value.message) : String(value);
      resolver.reject(new Error(message));
    }
  };
  schedulerGlobal.__finoSchedulerSettled = function settled(value) {
    return JSON.stringify({
      kind: 'settled',
      value
    });
  };
  schedulerGlobal.__finoSchedulerDispatch = async function dispatch(input) {
    const entry = await entryPromise;
    if (typeof entry.default !== 'function') {
      throw new Error('scheduler workload entry must default-export a function');
    }
    return await entry.default(delegatesReadiness ? JSON.parse(String(input)) : input);
  };
  schedulerGlobal.__finoSchedulerTick = tick;
}
