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
* Services are the counterpart to workloads: named singletons registered with
* `provideService()` and constructed lazily on the first `resolveService()`
* call, so a script that never touches (say) the jobs service pays nothing for
* it. `workloadsSignal()` exposes the live set of workloads as a reactive
* signal for supervisory UIs.
*
* ```ts no_run
* import { runApp } from 'internal:orchestrator';
*
* // `fino run` delegates a non-watch script to the orchestrator; the resolved
* // value / thrown error flows straight to the CLI exit path.
* const result = await runApp({ entry: 'file:///srv/app/main.ts' });
* console.log('app finished:', result);
* ```
*
* @internal
*/
import { Realm, type ImportRule, type RealmOptions } from '../../realm/index.ts';
import { createJobsControlFacade } from '../jobs/control.ts';
import { SchedulerNode } from './scheduler-node.ts';
import { createSignal } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
import type { PriorityClass, SchedulerShardSummary, ShardId } from '../scheduler/types.ts';

export { NodeIsolateCollection } from './node.ts';
export type { NodeWorkloadSpec, ReleaseReason } from './node.ts';
export { SchedulerNode } from './scheduler-node.ts';
export type { SchedulerNodeOptions, NodeRoundConfig } from './scheduler-node.ts';
export { BudgetWatchdog } from './budget-watchdog.ts';
export type { BudgetWatchdogOptions } from './budget-watchdog.ts';

/**
* Kind of a managed workload.
*
* @internal
*/
export type WorkloadKind = 'app' | 'job-pool' | 'tenant';

/**
* Lifecycle state of a managed workload.
*
* @internal
*/
export type WorkloadStatus = 'running' | 'done' | 'error' | 'terminated';

/**
* One workload managed by the orchestrator.
*
* A workload pairs a stable identity and lifecycle state with the opaque
* runtime object that actually runs the work (a `Realm`, a worker pool, etc.).
* Records are created by `registerWorkload()` and surface through `workloads()`
* and `workloadsSignal()`.
*
* @internal
*/
export interface Workload {
  /** Stable identifier, unique for the process lifetime, of the form `${kind}-${n}`. */
  id: string;
  /** Which category of work this is — decides how the orchestrator supervises it. */
  kind: WorkloadKind;
  /** Current lifecycle state; `'running'` until `releaseWorkload()` settles it. */
  status: WorkloadStatus;
  /** The opaque object backing the workload (e.g. the `Realm` for an `app`); the orchestrator does not interpret it. */
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
* Unlike `workloads()`, which returns a one-shot snapshot, this returns a
* long-lived reactive signal that emits a fresh array every time a workload is
* registered or released. Supervisory UIs and health probes subscribe to it to
* track the runtime's live footprint. The signal never completes for the
* process lifetime, so callers should hold onto the returned dispose function.
*
* ```ts no_run
* import { workloadsSignal } from 'internal:orchestrator';
*
* const dispose = workloadsSignal().subscribe((list) => {
*   console.error(`orchestrator running ${list.length} workload(s)`);
* });
* // ...later, when the observer is no longer needed:
* dispose();
* ```
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
* Sets the record's terminal status and removes it, then republishes the
* workloads signal so subscribers observe the shrink. Calling it with an `id`
* that is not (or is no longer) registered is a no-op, so double-release is
* safe.
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
* for scripts that never use them. Registration is idempotent-hostile on
* purpose: providing the same `name` twice — or providing a name that has
* already been resolved — throws, so accidental double-registration surfaces
* immediately rather than silently shadowing the earlier service.
*
* Throws if a factory or constructed instance already exists for `name`.
*
* ```ts no_run
* import { provideService, resolveService } from 'internal:orchestrator';
*
* provideService('jobs', () => createJobsService());
* // The factory does not run until the first resolve:
* const jobs = resolveService<JobsService>('jobs');
* ```
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
* On first call for a given `name` the registered factory runs and its result
* is cached; every later call returns that same instance, making services
* effectively process-wide singletons. The type parameter `T` is the caller's
* assertion of the service shape — it is not checked at runtime.
*
* Throws if no factory was provided for `name` via `provideService()`.
*
* ```ts no_run
* import { resolveService } from 'internal:orchestrator';
*
* // Same instance every time, constructed on first use:
* const a = resolveService<JobsService>('jobs');
* const b = resolveService<JobsService>('jobs');
* console.log(a === b); // true
* ```
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
  /** Module specifier of the entry script, typically a `file:` URL, loaded as the child realm's entry. */
  entry: string;
  /** Optional structured value handed to the child realm and readable there via its bootstrap data. */
  data?: unknown;
  /** OTLP endpoint the child realm exports telemetry to; inherits the realm default when omitted. */
  otlpEndpoint?: RealmOptions['otlpEndpoint'];
  /** Import overrides layered under the always-added `fino:jobs/control` facade to widen or narrow the realm's capabilities. */
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
* Every app realm is granted the `fino:jobs/control` facade automatically; any
* `overrides` passed in are layered underneath it. The realm is terminated on
* the `beforeunload` event (SIGINT), so an interrupted script tears down
* cleanly rather than leaking.
*
* ```ts no_run
* import { runApp } from 'internal:orchestrator';
*
* try {
*   const result = await runApp({
*     entry: 'file:///srv/app/main.ts',
*     data: { region: 'us-east-1' },
*   });
*   console.log('exited cleanly with', result);
* } catch (err) {
*   // Propagated from the entry realm; the CLI maps this to a non-zero exit.
*   console.error('app failed:', err);
* }
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

/**
* One tenant workload to place on a multi-tenant node.
*
* @internal
*/
export interface TenantDeployment {
  /** Trust boundary the workload belongs to; workloads of one tenant may be colocated, different tenants never share an isolate. */
  tenantId: string;
  /** Module specifier of the workload entry, loaded on whichever scheduler thread the orchestrator places it on. */
  entry: string;
  /** Structured seed value handed to the workload's dispatch. */
  data?: unknown;
  /** Scheduling priority class; defaults to `service`. */
  priority?: PriorityClass;
  /** Pin to a specific scheduler thread. Reserved for core services — ordinary app deployment omits it and lets the orchestrator place. */
  affinity?: ShardId;
}

/**
* Options for {@link deployNode}.
*
* @internal
*/
export interface DeployNodeOptions {
  /** Number of scheduler threads to boot. Defaults to the {@link SchedulerNode} default. */
  shardCount?: number;
  /** Per-thread workload capacity. Defaults to the {@link SchedulerNode} default. */
  capacity?: number;
  /** Dispatch budget per deployed workload for the run. Defaults to 1 (run-once workloads). */
  maxDispatchesPerWorkload?: number;
  /** How many poll rounds the scheduler threads run. Defaults to 1. */
  maxPolls?: number;
}

/**
* Where the orchestrator placed a deployed tenant workload.
*
* @internal
*/
export interface PlacedTenant {
  tenantId: string;
  workloadId: string;
  thread: ShardId | null;
}

/**
* Result of a {@link deployNode} run.
*
* @internal
*/
export interface DeployNodeResult {
  placements: PlacedTenant[];
  summaries: SchedulerShardSummary[];
}

/**
* Deploy a set of tenant workloads onto a multi-tenant node and run them.
*
* This is the multi-tenant counterpart to {@link runApp}: instead of running one
* entry as an embedded child realm on the main thread, it boots a
* {@link SchedulerNode} of scheduler threads and routes every placement decision
* through the orchestrator — app deployment never chooses its own thread. Each
* workload is registered as a supervised orchestrator workload so the node's
* footprint shows up in {@link workloads}, and is released when the run
* completes. Runaway containment (the budget watchdog) and facade-owned I/O come
* from the node machinery; the single-tenant `runApp` fast path is untouched.
*
* ```ts no_run
* import { deployNode } from 'internal:orchestrator';
*
* const { placements, summaries } = await deployNode([
*   { tenantId: 'acme', entry: 'file:///srv/acme/worker.ts', data: { region: 'us' } },
*   { tenantId: 'globex', entry: 'file:///srv/globex/worker.ts' },
* ], { shardCount: 2 });
* ```
*
* @internal
*/
export async function deployNode(deployments: TenantDeployment[], options: DeployNodeOptions = {}): Promise<DeployNodeResult> {
  const node = new SchedulerNode({
    ...options.shardCount !== undefined ? { shardCount: options.shardCount } : {},
    ...options.capacity !== undefined ? { capacity: options.capacity } : {}
  });
  const collection = node.collection();
  const placements: PlacedTenant[] = [];
  const supervised: string[] = [];
  for (const deployment of deployments) {
    const workloadId = node.deploy({
      tenantId: deployment.tenantId,
      entryPath: deployment.entry,
      ...deployment.data !== undefined ? { data: deployment.data } : {},
      ...deployment.priority !== undefined ? { priority: deployment.priority } : {},
      ...deployment.affinity !== undefined ? { affinity: deployment.affinity } : {}
    });
    const workload = registerWorkload('tenant', { tenantId: deployment.tenantId, workloadId });
    supervised.push(workload.id);
    // Bring the workload in on the first poll of its scheduler thread.
    collection.enqueueWake(workloadId, { workloadId, reason: 'control', sourceId: `deploy:${deployment.tenantId}` });
    placements.push({ tenantId: deployment.tenantId, workloadId, thread: collection.placementOf(workloadId) });
  }
  try {
    const perWorkload = Math.max(1, options.maxDispatchesPerWorkload ?? 1);
    const summaries = await node.run({
      maxDispatches: Math.max(1, deployments.length * perWorkload),
      maxPolls: options.maxPolls ?? 1,
      releaseOnShutdown: true
    });
    return { placements, summaries };
  } finally {
    for (const id of supervised) releaseWorkload(id, 'done');
  }
}
