/**
 * internal:jobs/control — orchestrator-side jobs control facade.
 *
 * The orchestrator runs the real jobs service (poller, Realm workers, and the
 * one SQLite connection) in its own realm and exposes a thin, capability-scoped
 * control surface to each app workload realm under the specifier
 * `fino:jobs/control`. The app-side `fino:jobs` module probes for this facade
 * on startup: when present it enters client mode and forwards every operation
 * here over RPC instead of opening a database of its own. This keeps a single
 * durable store per process while letting many app realms enqueue, schedule,
 * and process jobs against it.
 *
 * The facade groups three kinds of traffic. Ordinary control calls
 * (`push`, `schedule`, `get`, `cancel`, `waitFor`, ...) proxy straight onto the
 * live `JobsService`. Durable workflow checkpoints ride the `wf*` handlers,
 * which read and write the service's workflow store so run state survives a
 * crash. Inline processors — task handlers whose code lives inside a client
 * realm rather than a spawned worker — are bridged by an `InlineRelay`: the
 * service hands each due call to the relay, the client drains them through the
 * `inlineCalls` async stream, runs the handler locally, and reports the outcome
 * back with `completeInline`.
 *
 * The jobs service is created lazily on the first `open()` call and torn down by
 * a shutdown hook when the command settles, so scripts that never touch
 * `fino:jobs` pay nothing and never keep the orchestrator loop alive.
 *
 * ```ts no_run
 *   import { createJobsControlFacade } from 'internal:jobs/control';
 *
 *   // The orchestrator layers the facade over every app realm's import map.
 *   const realm = new Realm({
 *     entry: opts.entry,
 *     overrides: [
 *       { pattern: 'fino:jobs/control', directive: createJobsControlFacade() },
 *     ],
 *   });
 *   await realm.run();
 * ```
 *
 * @internal
 */
import { Facade } from '../../realm/index.ts';
import { registerShutdownHook } from '../shutdown.ts';
import type { JobsService, JobProcessor } from './service.ts';
import type { JobsWireCall, JobsWireResult } from './runner.ts';
import type { WorkflowState } from '../../workflow.ts';

let _service: JobsService | undefined;
let _servicePath: string | undefined;
let _opening: Promise<JobsService> | undefined;

async function ensureService(opts: {
  path: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  closeTimeout?: number;
}): Promise<JobsService> {
  if (_service !== undefined) {
    if (opts.path !== _servicePath) {
      throw new Error(
        `jobs service is already open at "${_servicePath}"; one database per process (got "${opts.path}")`,
      );
    }
    return _service;
  }
  if (_opening === undefined) {
    _servicePath = opts.path;
    _opening = import('internal:jobs/service').then(async (mod) => {
      const service = await (
        mod as {
          JobsService: {
            open(o: typeof opts): Promise<JobsService>;
          };
        }
      ).JobsService.open(opts);
      service.start();
      _service = service;
      // The service's poller and Realm workers keep the orchestrator loop
      // alive; stop them when the CLI command settles so the process exits.
      registerShutdownHook(async () => {
        await service.stop();
      });
      return service;
    });
  }
  return _opening;
}

function requireService(): JobsService {
  if (_service === undefined) {
    throw new Error('jobs control used before open()');
  }
  return _service;
}

/**
 * A `JobProcessor` bridge for handlers whose execution lives in a client realm.
 *
 * The service treats a relay like any other processor: it calls `run` when a
 * job for one of `taskNames` is due, up to `capacity` in flight. But the relay
 * has no handler of its own — it parks each call and its resolver, then hands
 * the call to whichever consumer is waiting on `next` (backing the facade's
 * `inlineCalls` stream). The client runs the real handler and reports the
 * outcome with `complete`, which resolves the parked `run` promise. Buffered
 * calls and blocked takers are matched in FIFO order so no due job is lost when
 * the consumer briefly falls behind.
 *
 * @internal
 */
class InlineRelay implements JobProcessor {
  /** Marks this processor as inline so the service routes calls through the relay rather than a Realm worker. */
  readonly kind = 'inline' as const;
  /** Task names this relay accepts; the service dispatches matching jobs to `run`. */
  readonly taskNames: string[];
  /** Maximum number of calls the service keeps in flight against this relay at once. */
  readonly capacity: number;
  #buffer: JobsWireCall[] = [];
  #takers: ((call: JobsWireCall) => void)[] = [];
  #pending = new Map<string, (result: JobsWireResult) => void>();
  constructor(taskNames: string[], capacity: number) {
    this.taskNames = taskNames;
    this.capacity = capacity;
  }
  /**
   * Accept a due call and return a promise that settles when the client reports
   * the outcome. The call is handed to a waiting `next` consumer if one is
   * parked, otherwise buffered until one arrives. The promise resolves only via
   * a later `complete` for the same `jobId` (or `close`).
   */
  run(call: JobsWireCall): Promise<JobsWireResult> {
    return new Promise<JobsWireResult>((resolve) => {
      this.#pending.set(call.jobId, resolve);
      const taker = this.#takers.shift();
      if (taker !== undefined) taker(call);
      else this.#buffer.push(call);
    });
  }
  /**
   * Pull the next due call for the client to run, resolving immediately from the
   * buffer or parking until `run` delivers one. Backs the `inlineCalls` stream,
   * which loops on this method forever.
   */
  next(): Promise<JobsWireCall> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<JobsWireCall>((resolve) => this.#takers.push(resolve));
  }
  /**
   * Report the result of an inline call, resolving the `run` promise parked
   * under `jobId`. A `jobId` with no pending call (already completed, or never
   * issued by this relay) is ignored.
   */
  complete(jobId: string, result: JobsWireResult): void {
    const resolve = this.#pending.get(jobId);
    if (resolve !== undefined) {
      this.#pending.delete(jobId);
      resolve(result);
    }
  }
  /**
   * Fail every in-flight call with a retryable "inline processor closed" error
   * so the service can requeue them, then clear pending state. Called when the
   * service drops the relay during shutdown.
   */
  async close(): Promise<void> {
    for (const resolve of this.#pending.values()) {
      resolve({
        ok: false,
        error: {
          message: 'inline processor closed',
          retryable: true,
        },
      });
    }
    this.#pending.clear();
  }
}

const _relays: InlineRelay[] = [];

/**
 * Build the jobs control facade the orchestrator attaches to app workload realms.
 *
 * The returned `Facade` is registered under `fino:jobs/control` and its handlers
 * close over this module's lazily-opened `JobsService`, so a fresh facade should
 * be created per orchestrator process and layered onto each realm's import map
 * as a directive. Control handlers (`push`, `schedule`, `get`, `cancel`,
 * `waitFor`, and the rest) proxy directly to the service; `wf*` handlers proxy
 * durable workflow checkpoints to its workflow store; and the inline trio
 * (`registerInline`, `inlineCalls`, `completeInline`) bridges client-realm task
 * handlers through an `InlineRelay`.
 *
 * Every handler except `open` calls `requireService`, so an app that invokes any
 * operation before a successful `open()` gets a "jobs control used before open()"
 * error. A second `open()` against a different database path throws, because the
 * process keeps exactly one jobs database.
 *
 * ```ts no_run
 *   import { createJobsControlFacade } from 'internal:jobs/control';
 *   import { Realm } from 'fino:realm';
 *
 *   const realm = new Realm({
 *     entry: '/srv/app/main.ts',
 *     overrides: [
 *       { pattern: 'fino:jobs/control', directive: createJobsControlFacade() },
 *     ],
 *   });
 *   // Inside the realm, `import ... from 'fino:jobs'` now runs in client mode
 *   // and routes push/schedule/process calls back through this facade.
 *   await realm.run();
 * ```
 *
 * @internal
 */
export function createJobsControlFacade(): Facade {
  return new Facade('fino:jobs/control', [
    'open',
    'push',
    'schedule',
    'unschedule',
    'get',
    'list',
    'stats',
    'schedules',
    'cancel',
    'retry',
    'signal',
    'waitFor',
    'registerWorkers',
    'registerInline',
    'completeInline',
    'wfSave',
    'wfLoad',
    'wfList',
    'wfRemove',
  ])
    .handle('open', async (opts) => {
      await ensureService(
        opts as {
          path: string;
        },
      );
      return true;
    })
    .handle('push', (task, input, opts) =>
      requireService().push(task as string, input, opts as never),
    )
    .handle('schedule', (name, task, input, opts) =>
      requireService().schedule(name as string, task as string, input, opts as never),
    )
    .handle('unschedule', (name) => requireService().unschedule(name as string))
    .handle('get', (id) => requireService().get(id as string))
    .handle('list', (filter) => requireService().list(filter as never))
    .handle('stats', (queue) => requireService().stats(queue as string | undefined))
    .handle('schedules', () => requireService().schedules())
    .handle('cancel', (id) => requireService().cancel(id as string))
    .handle('retry', (id) => requireService().retry(id as string))
    .handle('signal', (id, name, payload) =>
      requireService().signal(id as string, name as string, payload),
    )
    .handle('waitFor', (id, opts) => requireService().waitFor(id as string, opts as never))
    .handle('registerWorkers', async (opts) => {
      await requireService().workers(
        opts as {
          entry: string;
          size?: number;
        },
      );
      return true;
    })
    .handle('registerInline', (taskNames, concurrency) => {
      const relay = new InlineRelay(taskNames as string[], (concurrency as number) ?? 1);
      _relays.push(relay);
      requireService()._addExternalProcessor(relay);
      return _relays.length - 1;
    })
    .handle('completeInline', (relayIndex, jobId, result) => {
      _relays[relayIndex as number]?.complete(jobId as string, result as JobsWireResult);
    })
    .handle('wfSave', (state) => requireService().workflowStore.save(state as WorkflowState))
    .handle('wfLoad', (runId) => requireService().workflowStore.load(runId as string))
    .handle('wfList', (filter) => requireService().workflowStore.list(filter as never))
    .handle('wfRemove', (runId) => requireService().workflowStore.delete(runId as string))
    .stream('inlineCalls', async function* inlineCalls(relayIndex) {
      const relay = _relays[relayIndex as number];
      if (relay === undefined) throw new Error('unknown inline processor');
      while (true) {
        yield await relay.next();
      }
    });
}
