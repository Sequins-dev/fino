/**
* internal/jobs/control — orchestrator-side jobs control facade.
*
* The orchestrator attaches this facade to every app workload realm under
* the specifier `fino:jobs/control`. The app-side `fino:jobs` module detects
* it to enter client mode: control operations RPC here, durable checkpoints
* proxy through the `wf*` exports onto the service's single database
* connection, and inline processors consume the `inlineCalls` stream and
* answer with `completeInline`.
*
* The jobs service itself is created lazily on the first `open()` call, so
* scripts that never use jobs pay nothing.
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
      throw new Error(`jobs service is already open at "${_servicePath}"; one database per process (got "${opts.path}")`);
    }
    return _service;
  }
  if (_opening === undefined) {
    _servicePath = opts.path;
    _opening = import('internal:jobs/service').then(async (mod) => {
      const service = await (mod as {
        JobsService: {
          open(o: typeof opts): Promise<JobsService>;
        };
      }).JobsService.open(opts);
      service.start();
      _service = service;
      // The service's poller and worker pools keep the orchestrator loop
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
* An inline processor whose execution lives in a client realm: calls queue
* here, the client consumes them via the `inlineCalls` facade stream, and
* results come back through `completeInline`.
*
* @internal
*/
class InlineRelay implements JobProcessor {
  readonly kind = 'inline' as const;
  readonly taskNames: string[];
  readonly capacity: number;
  #buffer: JobsWireCall[] = [];
  #takers: ((call: JobsWireCall) => void)[] = [];
  #pending = new Map<string, (result: JobsWireResult) => void>();
  constructor(taskNames: string[], capacity: number) {
    this.taskNames = taskNames;
    this.capacity = capacity;
  }
  run(call: JobsWireCall): Promise<JobsWireResult> {
    return new Promise<JobsWireResult>((resolve) => {
      this.#pending.set(call.jobId, resolve);
      const taker = this.#takers.shift();
      if (taker !== undefined) taker(call);
      else this.#buffer.push(call);
    });
  }
  next(): Promise<JobsWireCall> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<JobsWireCall>((resolve) => this.#takers.push(resolve));
  }
  complete(jobId: string, result: JobsWireResult): void {
    const resolve = this.#pending.get(jobId);
    if (resolve !== undefined) {
      this.#pending.delete(jobId);
      resolve(result);
    }
  }
  async close(): Promise<void> {
    for (const resolve of this.#pending.values()) {
      resolve({
        ok: false,
        error: {
          message: 'inline processor closed',
          retryable: true
        }
      });
    }
    this.#pending.clear();
  }
}

const _relays: InlineRelay[] = [];

/**
* Build the jobs control facade attached to app workload realms.
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
    'wfRemove'
  ])
    .handle('open', async (opts) => {
      await ensureService(opts as {
        path: string;
      });
      return true;
    })
    .handle('push', (task, input, opts) => requireService().push(task as string, input, opts as never))
    .handle('schedule', (name, task, input, opts) => requireService().schedule(name as string, task as string, input, opts as never))
    .handle('unschedule', (name) => requireService().unschedule(name as string))
    .handle('get', (id) => requireService().get(id as string))
    .handle('list', (filter) => requireService().list(filter as never))
    .handle('schedules', () => requireService().schedules())
    .handle('cancel', (id) => requireService().cancel(id as string))
    .handle('retry', (id) => requireService().retry(id as string))
    .handle('signal', (id, name, payload) => requireService().signal(id as string, name as string, payload))
    .handle('waitFor', (id, opts) => requireService().waitFor(id as string, opts as never))
    .handle('registerWorkers', async (opts) => {
      await requireService().workers(opts as {
        entry: string;
        size?: number;
      });
      return true;
    })
    .handle('registerInline', (taskNames, concurrency) => {
      const relay = new InlineRelay(taskNames as string[], concurrency as number ?? 1);
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
