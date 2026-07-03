/**
* internal:orchestrator — root-realm workload management.
*
* The root realm on the main thread is the runtime's orchestrator: user code
* runs in supervised child realms ("workloads") while long-lived runtime
* services (job scheduling, later cluster participation) live here and
* outlive any single workload. `fino run` delegates non-watch script
* execution to `runApp()`, which spawns the entry as an embedded child realm
* and maps its completion onto the CLI exit path.
*
* Workload kinds:
* - `app` — a user entry script realm. Its settlement decides the process
*   exit; the orchestrator does not restart it.
* - `job-pool` — a worker pool owned by the jobs service.
*
* The orchestrator never writes to stdout or touches the terminal — the app
* workload owns the tty. Orchestrator-level failures go to stderr only.
*
* ```js
* import { runApp } from 'internal:orchestrator';
* console.log(typeof runApp);
* ```
*
* @internal
*/
import { Realm, type ImportRule, type RealmOptions } from '../../realm/index.ts';
import { createJobsControlFacade } from '../jobs/control.ts';
import { createSignal } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';

/**
* Kind of a managed workload.
*
* @internal
*/
export type WorkloadKind = 'app' | 'job-pool';

/**
* Lifecycle state of a managed workload.
*
* @internal
*/
export type WorkloadStatus = 'running' | 'done' | 'error' | 'terminated';

/**
* One workload managed by the orchestrator.
*
* @internal
*/
export interface Workload {
  id: string;
  kind: WorkloadKind;
  status: WorkloadStatus;
  handle: unknown;
}

let _nextWorkloadId = 0;
const _workloads = new Map<string, Workload>();
const _workloadsSignal = createSignal<Workload[]>([]);
const _services = new Map<string, unknown>();
const _serviceFactories = new Map<string, () => unknown>();

/**
* Snapshot of the currently managed workloads.
*
* ```js
* import { workloads } from 'internal:orchestrator';
* console.log(workloads().length);
* ```
*
* @internal
*/
export function workloads(): Workload[] {
  return [..._workloads.values()];
}

/**
* Retained signal of the currently managed workloads.
*
* @internal
*/
export function workloadsSignal(): ReadonlySignal<Workload[]> {
  return _workloadsSignal;
}

/**
* Register a workload with the orchestrator and return its record.
*
* Used by orchestrator services (e.g. the jobs service) to attach workloads
* they own, so `workloads()` reflects everything the runtime is running.
*
* @internal
*/
export function registerWorkload(kind: WorkloadKind, handle: unknown): Workload {
  const workload: Workload = {
    id: `${kind}-${_nextWorkloadId++}`,
    kind,
    status: 'running',
    handle
  };
  _workloads.set(workload.id, workload);
  _workloadsSignal.set(workloads());
  return workload;
}

/**
* Mark a workload finished and drop it from the registry.
*
* @internal
*/
export function releaseWorkload(id: string, status: Exclude<WorkloadStatus, 'running'>): void {
  const workload = _workloads.get(id);
  if (workload === undefined) return;
  workload.status = status;
  _workloads.delete(id);
  _workloadsSignal.set(workloads());
}

/**
* Provide a named orchestrator service lazily.
*
* The factory runs on first `resolveService()` call, so services cost nothing
* for scripts that never use them.
*
* @internal
*/
export function provideService(name: string, factory: () => unknown): void {
  if (_serviceFactories.has(name) || _services.has(name)) {
    throw new Error(`orchestrator service already provided: ${name}`);
  }
  _serviceFactories.set(name, factory);
}

/**
* Resolve (and lazily construct) a named orchestrator service.
*
* @throws If no factory was provided for `name`.
*
* @internal
*/
export function resolveService<T>(name: string): T {
  if (_services.has(name)) return _services.get(name) as T;
  const factory = _serviceFactories.get(name);
  if (factory === undefined) {
    throw new Error(`unknown orchestrator service: ${name}`);
  }
  const service = factory();
  _services.set(name, service);
  return service as T;
}

/**
* Options for running a user entry script as an app workload.
*
* @internal
*/
export interface AppOptions {
  entry: string;
  data?: unknown;
  otlpEndpoint?: RealmOptions['otlpEndpoint'];
  overrides?: RealmOptions['overrides'];
}

/**
* Run a user entry script as a supervised app workload.
*
* Spawns the entry as an embedded child realm on the main thread, registers
* it as an `app` workload, terminates it on `beforeunload` (SIGINT), and
* settles with the realm's completion — a rejected entry propagates so the
* CLI exit path reports failure exactly as an in-place import would.
*
* ```js
* import { runApp } from 'internal:orchestrator';
* await runApp({ entry: 'file:///tmp/script.ts' });
* ```
*
* @internal
*/
export async function runApp(opts: AppOptions): Promise<unknown> {
  // Every app realm gets the jobs control facade; its handlers lazy-init the
  // jobs service, so scripts that never use fino:jobs pay nothing.
  const baseOverrides = opts.overrides;
  const rules: ImportRule[] = [
    ...baseOverrides === undefined ? [] : Array.isArray(baseOverrides) ? baseOverrides : baseOverrides.toRules(),
    {
      pattern: 'fino:jobs/control',
      directive: createJobsControlFacade()
    }
  ];
  const realm = new Realm({
    entry: opts.entry,
    ...opts.data !== undefined ? { data: opts.data } : {},
    ...opts.otlpEndpoint !== undefined ? { otlpEndpoint: opts.otlpEndpoint } : {},
    overrides: rules
  });
  const workload = registerWorkload('app', realm);
  (globalThis as Record<string, unknown>).addEventListener?.('beforeunload', () => realm.terminate());
  try {
    const result = await realm.run();
    releaseWorkload(workload.id, 'done');
    return result;
  } catch (err) {
    releaseWorkload(workload.id, 'error');
    throw err;
  }
}
