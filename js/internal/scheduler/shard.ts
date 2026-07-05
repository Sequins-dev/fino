/**
* Real TypeScript thread-local scheduler loop.
*
* The scheduler owns one OS thread and powers the event loops of the tenant
* isolates assigned to it. It is long-lived and event-driven: it runs on the
* thread realm's own host loop, pumps an isolate for one budget-bounded slice
* only when that isolate is runnable (a wake queued, a background completion, or
* a host op it performed), and otherwise suspends — a workload parked on I/O
* costs no CPU and blocks nothing. There is no bounded round and no per-tick
* poll: the orchestrator pushes placement/wake/revoke/drain/shutdown control
* messages over the realm port, which wake the loop; the scheduler reports
* releases and load back over the same channel. Long-lived connection workloads
* stay parked on their wake fd indefinitely without holding the thread.
*
* @internal
*/
import { readable, timeout } from 'internal:runtime/loop';
import { getRealmData } from 'internal:realm-bridge';
import { DiskFileSystem, DT_DIR, DT_REG, DT_UNKNOWN, type File, type Entry, type Stat } from 'fino:file';
import { encodeBinary, decodeBinary } from './facade-ops.ts';
import { Isolate } from './isolate.ts';
import { coalesceWake, firstWake, removeWake } from './selection.ts';
import type { DispatchResult, LeaseRecord, PriorityClass, RunnableWorkload, SchedulerControlMessage, SchedulerShardConfig, SchedulerShardSummary, ShardLoadSummary, TenantWake } from './types.ts';

interface HeldWorkload {
  lease: LeaseRecord;
  wakes: TenantWake[];
  debtMicros: number;
  sequence: number;
  isolate?: Isolate;
  /** True while an activation is in flight (parked on I/O or awaiting a host op). */
  mid: boolean;
  /** The wake this activation is servicing, consumed when the activation settles. */
  currentWake: TenantWake | null;
  /** True while parked on the wake fd or a host op, so a new wake won't double-pump. */
  blocked: boolean;
  /** True while an fd watch is armed, so it is never double-armed. */
  watching: boolean;
  /** A drain was requested mid-activation; capture + hand off once it settles. */
  drainRequested: boolean;
}

const PRIORITY_WEIGHT: Record<PriorityClass, number> = {
  interactive: 0,
  service: 1,
  background: 2
};

const DEFAULT_LOAD_REPORT_MS = 50;
const DEFAULT_BUDGET_MICROS = 1_000;
// Generous per-pump-slice hard limit for runaway containment. Legitimate
// synchronous work — including a workload's first module-loading pump — stays
// well under this; only an unbounded synchronous loop trips it. Distinct from
// the cooperative `budgetMicros` used for debt accounting.
const DEFAULT_HARD_BUDGET_MICROS = 5_000_000;
let globalSequence = 0;
const hostFileSystem = new DiskFileSystem();

function normalizeCapacity(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('scheduler capacity must be a non-negative finite number');
  return Math.floor(value);
}

function runnableFromHeld(held: HeldWorkload): RunnableWorkload {
  return {
    workloadId: held.lease.workloadId,
    priority: held.lease.priority,
    wakes: held.wakes,
    debtMicros: held.debtMicros,
    sequence: held.sequence
  };
}

function summarize(shardId: string, held: Map<string, HeldWorkload>, dispatches: number): ShardLoadSummary {
  let runnableWorkloads = 0;
  let debtMicros = 0;
  for (const workload of held.values()) {
    if (workload.wakes.length > 0) runnableWorkloads++;
    debtMicros += workload.debtMicros;
  }
  return {
    shardId,
    heldLeases: held.size,
    runnableWorkloads,
    dispatches,
    debtMicros
  };
}

function applyDispatchResult(workload: HeldWorkload, result: DispatchResult, dispatched: TenantWake | null): void {
  const costMicros = Math.max(0, result.costMicros ?? 0);
  if (result.result === 'budget_yield') {
    workload.debtMicros += costMicros;
    return;
  }
  workload.debtMicros = Math.max(0, workload.debtMicros - costMicros);
  if (result.result === 'idle') {
    // Consume the wake that was actually serviced (the earliest-deadline one
    // `firstWake` selected), not `wakes[0]` — otherwise an out-of-order wake is
    // silently lost and the serviced one is re-dispatched.
    workload.wakes = removeWake(workload.wakes, dispatched);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be a number`);
  return n;
}

// Real file handles opened on behalf of tenant isolates, addressed by id.
const openHandles = new Map<number, File>();
let nextHandleId = 1;

function statFields(stat: Stat): number[] {
  return [
    stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.rdev,
    stat.size, stat.blksize, stat.blocks, stat.atimeMs, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs
  ].map(Number);
}

function entryInfo(entry: Entry): { name: string; path: string; dtype: number; isDir: boolean } {
  const isDir = entry.isDirectory();
  return {
    name: entry.name,
    path: String(entry.path),
    dtype: isDir ? DT_DIR : entry.isFile() ? DT_REG : DT_UNKNOWN,
    isDir
  };
}

function requireHandle(args: Record<string, unknown>): File {
  const handle = openHandles.get(requireNumber(args.id, 'id'));
  if (handle === undefined) throw new Error('invalid file handle');
  return handle;
}

async function runFileOp(method: string, args: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'readFile':
      return encodeBinary(await hostFileSystem.readFile(requireString(args.path, 'path')));
    case 'writeFile':
      await hostFileSystem.writeFile(requireString(args.path, 'path'), decodeBinary(args.data));
      return null;
    case 'stat':
      return statFields(await hostFileSystem.stat(requireString(args.path, 'path')));
    case 'lstat':
      return statFields(await hostFileSystem.lstat(requireString(args.path, 'path')));
    case 'mkdir':
      await hostFileSystem.mkdir(requireString(args.path, 'path'), Number(args.mode ?? 0o755));
      return null;
    case 'rmdir':
      await hostFileSystem.rmdir(requireString(args.path, 'path'));
      return null;
    case 'unlink':
      await hostFileSystem.unlink(requireString(args.path, 'path'));
      return null;
    case 'rename':
      await hostFileSystem.rename(requireString(args.oldPath, 'oldPath'), requireString(args.newPath, 'newPath'));
      return null;
    case 'readlink':
      return await hostFileSystem.readlink(requireString(args.path, 'path'));
    case 'symlink':
      await hostFileSystem.symlink(requireString(args.target, 'target'), requireString(args.linkpath, 'linkpath'));
      return null;
    case 'realpath':
      return await hostFileSystem.realpath(requireString(args.path, 'path'));
    case 'open': {
      const handle = await hostFileSystem.open(requireString(args.path, 'path'), requireString(args.mode, 'mode'));
      const id = nextHandleId++;
      openHandles.set(id, handle);
      return id;
    }
    case 'dir':
      return entryInfo(await hostFileSystem.dir(requireString(args.path, 'path')));
    case 'entry':
      return entryInfo(await hostFileSystem.entry(requireString(args.path, 'path')));
    case 'readdir': {
      const dir = await hostFileSystem.dir(requireString(args.path, 'path'));
      const entries = await dir.entries();
      return entries.map(entryInfo);
    }
    default:
      throw new Error(`unknown scheduler file operation: ${method}`);
  }
}

async function runFileHandleOp(method: string, args: Record<string, unknown>): Promise<unknown> {
  const handle = requireHandle(args);
  switch (method) {
    case 'stat':
      return statFields(await handle.stat());
    case 'pread':
      return encodeBinary(await handle.pread(requireNumber(args.pos, 'pos'), requireNumber(args.len, 'len')));
    case 'pwrite':
      return await handle.pwrite(requireNumber(args.pos, 'pos'), decodeBinary(args.data));
    case 'bytes':
      return encodeBinary(await handle.bytes());
    case 'size':
      return Number(await handle.size());
    case 'truncate':
      await handle.truncate(requireNumber(args.len, 'len'));
      return null;
    case 'sync':
      await handle.sync();
      return null;
    case 'write': {
      const writer = handle.writer();
      writer.write(decodeBinary(args.data));
      await writer.flush();
      return null;
    }
    case 'close':
      await handle.close();
      openHandles.delete(requireNumber(args.id, 'id'));
      return null;
    default:
      throw new Error(`unknown scheduler file-handle operation: ${method}`);
  }
}

async function runHostOperation(operation: { operation: string; args?: Record<string, unknown> }): Promise<unknown> {
  const args = operation.args ?? {};
  const sep = operation.operation.indexOf(':');
  if (sep !== -1) {
    const provider = operation.operation.slice(0, sep);
    const method = operation.operation.slice(sep + 1);
    if (provider === 'file') return runFileOp(method, args);
    if (provider === 'file-handle') return runFileHandleOp(method, args);
    throw new Error(`unknown scheduler facade provider: ${provider}`);
  }
  switch (operation.operation) {
    case 'readTextFile':
      return new TextDecoder().decode(await hostFileSystem.readFile(requireString(args.path, 'path')));
    case 'writeTextFile':
      await hostFileSystem.writeFile(requireString(args.path, 'path'), new TextEncoder().encode(requireString(args.text, 'text')));
      return null;
    case 'delay':
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(args.ms ?? 0))));
      return null;
    default:
      throw new Error(`unknown scheduler host operation: ${operation.operation}`);
  }
}

/** A resettable one-shot notifier: `wait()` resolves the next time `notify()` fires. */
class Signal {
  #promise!: Promise<void>;
  #resolve!: () => void;
  constructor() {
    this.#reset();
  }
  #reset(): void {
    this.#promise = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }
  wait(): Promise<void> {
    return this.#promise;
  }
  notify(): void {
    const resolve = this.#resolve;
    this.#reset();
    resolve();
  }
}

/** The port the orchestrator pushes control over and the scheduler reports back on. */
interface RealmPort {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  start?(): void;
}

/**
* The long-lived, event-driven scheduler for one thread. Holds a set of tenant
* isolates, pumps a runnable one for a single budget-bounded slice at a time in
* priority order, parks isolates on their wake fd (or an in-flight host op) with
* zero CPU cost, and suspends entirely when nothing is runnable. Driven by
* control messages pushed over the realm port; it never polls.
*/
class ShardScheduler {
  #shardId: string;
  #budgetMicros: number;
  #hardBudgetMicros: number;
  #loadReportMs: number;
  #port: RealmPort;
  #held = new Map<string, HeldWorkload>();
  #runnable = new Set<string>();
  #ready = new Signal();
  #running = true;
  #claimed = 0;
  #dispatches = 0;
  #released = 0;

  constructor(config: SchedulerShardConfig, port: RealmPort) {
    this.#shardId = config.shardId;
    this.#budgetMicros = config.budgetMicros ?? DEFAULT_BUDGET_MICROS;
    this.#hardBudgetMicros = config.hardBudgetMicros ?? DEFAULT_HARD_BUDGET_MICROS;
    this.#loadReportMs = config.loadReportMs ?? DEFAULT_LOAD_REPORT_MS;
    this.#port = port;
  }

  async run(): Promise<SchedulerShardSummary> {
    this.#port.addEventListener('message', (event) => this.#onControl(event.data as SchedulerControlMessage));
    this.#port.start?.();
    const load = this.#reportLoadLoop();
    await this.#dispatchLoop();
    await load;
    for (const workload of this.#held.values()) workload.isolate?.terminate();
    const heldLeases = this.#held.size;
    this.#held.clear();
    const summary: SchedulerShardSummary = { shardId: this.#shardId, claimed: this.#claimed, dispatches: this.#dispatches, released: this.#released, heldLeases };
    this.#port.postMessage({ report: 'summary', summary });
    return summary;
  }

  #onControl(message: SchedulerControlMessage): void {
    switch (message.control) {
      case 'place':
        this.#place(message.lease);
        break;
      case 'wake':
        this.#applyWake(message.wake);
        break;
      case 'revoke':
        this.#release(message.workloadId, message.reason);
        break;
      case 'drain':
        this.#drain(message.workloadId);
        break;
      case 'shutdown':
        this.#running = false;
        this.#ready.notify();
        break;
    }
  }

  #place(lease: LeaseRecord): void {
    if (this.#held.has(lease.workloadId)) return;
    this.#claimed++;
    this.#held.set(lease.workloadId, {
      lease,
      wakes: [],
      debtMicros: 0,
      sequence: ++globalSequence,
      mid: false,
      currentWake: null,
      blocked: false,
      watching: false,
      drainRequested: false,
      ...lease.entryPath !== undefined ? { isolate: new Isolate(lease.entryPath) } : {}
    });
  }

  #applyWake(rawWake: TenantWake): void {
    const workload = this.#held.get(rawWake.workloadId);
    if (workload === undefined) return;
    const wake = { ...rawWake, sequence: rawWake.sequence ?? ++globalSequence };
    workload.wakes = coalesceWake(workload.wakes, wake);
    // A wake only starts a new activation when the isolate is idle; if it is
    // mid-activation the wake stays queued and is serviced when it settles.
    if (!workload.mid && !workload.blocked) this.#markRunnable(rawWake.workloadId);
  }

  #release(workloadId: string, reason: string): void {
    const workload = this.#held.get(workloadId);
    if (workload === undefined) return;
    this.#held.delete(workloadId);
    this.#runnable.delete(workloadId);
    workload.isolate?.terminate();
    this.#released++;
    this.#port.postMessage({ report: 'released', shardId: this.#shardId, workloadId, reason });
  }

  #markRunnable(workloadId: string): void {
    if (!this.#held.has(workloadId)) return;
    this.#runnable.add(workloadId);
    this.#ready.notify();
  }

  /**
  * Drain a workload for handoff: quiesce it, capture its pending state, report a
  * `drained` snapshot to the orchestrator, and dispose the isolate. If the
  * workload is mid-activation, defer until it settles so we capture a consistent
  * point.
  */
  #drain(workloadId: string): void {
    const workload = this.#held.get(workloadId);
    if (workload === undefined) return;
    if (workload.mid) {
      workload.drainRequested = true;
      return;
    }
    this.#captureAndHandoff(workload);
  }

  #captureAndHandoff(workload: HeldWorkload): void {
    // Ask the workload to serialize its pending state by pumping a drain request;
    // a cooperating worker returns `{ result: 'drained', mailbox: [...] }`. Drain
    // handlers are expected to be synchronous.
    let mailbox: { sequence: number; data: unknown }[] = [];
    const isolate = workload.isolate;
    if (isolate !== undefined) {
      const outcome = isolate.pump(JSON.stringify({ drain: true }), this.#hardBudgetMicros);
      if (outcome.kind === 'settled') {
        const value = outcome.value as { mailbox?: { sequence: number; data: unknown }[] };
        if (Array.isArray(value.mailbox)) mailbox = value.mailbox;
      }
    }
    const workloadId = workload.lease.workloadId;
    this.#held.delete(workloadId);
    this.#runnable.delete(workloadId);
    isolate?.terminate();
    this.#port.postMessage({ report: 'drained', shardId: this.#shardId, workloadId, pending: { mailbox } });
  }

  /** Highest-priority runnable workload: lowest priority weight, then debt, then age. */
  #pickRunnable(): HeldWorkload | null {
    let best: HeldWorkload | null = null;
    for (const workloadId of this.#runnable) {
      const workload = this.#held.get(workloadId);
      if (workload === undefined) continue;
      if (best === null) {
        best = workload;
        continue;
      }
      const dw = PRIORITY_WEIGHT[workload.lease.priority] - PRIORITY_WEIGHT[best.lease.priority];
      if (dw < 0 || (dw === 0 && (workload.debtMicros < best.debtMicros || (workload.debtMicros === best.debtMicros && workload.sequence < best.sequence)))) {
        best = workload;
      }
    }
    return best;
  }

  async #dispatchLoop(): Promise<void> {
    while (this.#running) {
      if (this.#runnable.size === 0) {
        await this.#ready.wait();
        continue;
      }
      // Pump every currently-runnable workload once, highest priority first,
      // then yield to the host loop (a macrotask) so background completions and
      // fd fires land and the microtask queue drains before the next batch —
      // this guarantees I/O progress even under a workload that stays runnable.
      const batch: HeldWorkload[] = [];
      for (;;) {
        const next = this.#pickRunnable();
        if (next === null) break;
        this.#runnable.delete(next.lease.workloadId);
        batch.push(next);
      }
      for (const workload of batch) {
        if (!this.#running) break;
        this.#pumpOnce(workload);
      }
      await timeout(0);
    }
  }

  /** Pump one budget-bounded slice; schedule the follow-up rather than blocking. */
  #pumpOnce(workload: HeldWorkload): void {
    const isolate = workload.isolate;
    if (isolate === undefined || !this.#held.has(workload.lease.workloadId)) return;

    let requestJson: string;
    if (workload.mid) {
      requestJson = '{}';
    } else {
      const wake = firstWake(runnableFromHeld(workload));
      workload.currentWake = wake;
      workload.mid = true;
      requestJson = JSON.stringify({
        workloadId: workload.lease.workloadId,
        wake,
        budgetMicros: this.#budgetMicros,
        debtMicros: workload.debtMicros,
        data: workload.lease.data,
        ...workload.lease.handoff !== undefined ? { handoff: workload.lease.handoff } : {}
      });
    }

    const outcome = isolate.pump(requestJson, this.#hardBudgetMicros);
    if (outcome.kind === 'hostOperation') {
      workload.blocked = true;
      void this.#performHostOp(workload, outcome.operation);
      return;
    }
    if (outcome.kind === 'pending') {
      workload.blocked = true;
      this.#armWatch(workload);
      return;
    }
    if (outcome.kind === 'budgetTerminated') {
      this.#dispatches++;
      this.#release(workload.lease.workloadId, 'terminated');
      return;
    }

    // Activation settled.
    this.#dispatches++;
    workload.mid = false;
    workload.blocked = false;
    const result = outcome.value as DispatchResult;
    if (result.result === 'terminated' || result.result === 'failed') {
      this.#release(workload.lease.workloadId, result.result);
      return;
    }
    applyDispatchResult(workload, result, workload.currentWake);
    workload.currentWake = null;
    // A drain requested while this activation was in flight runs now that it has
    // settled to a consistent point.
    if (workload.drainRequested) {
      workload.drainRequested = false;
      this.#captureAndHandoff(workload);
      return;
    }
    if (workload.wakes.length > 0) this.#markRunnable(workload.lease.workloadId);
  }

  async #performHostOp(workload: HeldWorkload, operation: { id: number; operation: string; args?: Record<string, unknown> }): Promise<void> {
    try {
      const result = await runHostOperation(operation);
      workload.isolate?.complete(operation.id, true, JSON.stringify(result));
    } catch (error) {
      workload.isolate?.complete(operation.id, false, JSON.stringify({
        message: error instanceof Error ? error.message : String(error)
      }));
    }
    workload.blocked = false;
    this.#markRunnable(workload.lease.workloadId);
  }

  #armWatch(workload: HeldWorkload): void {
    const isolate = workload.isolate;
    if (isolate === undefined || workload.watching) return;
    workload.watching = true;
    const fd = isolate.wakeFd;
    readable(fd).then(
      () => {
        workload.watching = false;
        workload.blocked = false;
        this.#markRunnable(workload.lease.workloadId);
      },
      () => {
        workload.watching = false;
      }
    );
  }

  async #reportLoadLoop(): Promise<void> {
    while (this.#running) {
      await timeout(this.#loadReportMs);
      if (!this.#running) break;
      this.#port.postMessage({ report: 'load', summary: summarize(this.#shardId, this.#held, this.#dispatches) });
    }
  }
}

/**
* Run a scheduler shard until it receives a `shutdown` control message. The
* thread realm's own host loop drives it; this promise stays pending (keeping
* the thread alive) for the shard's lifetime and resolves with a final summary
* on shutdown.
*/
export async function runSchedulerShard(config?: SchedulerShardConfig): Promise<SchedulerShardSummary> {
  // Config is passed as realm data when booted as a thread entry; callers may
  // also pass it directly (tests).
  const resolved = config ?? (JSON.parse((getRealmData as () => string)()) as SchedulerShardConfig);
  normalizeCapacity(resolved.capacity);
  const port = (globalThis as { realmPort?: RealmPort }).realmPort;
  if (port === undefined) throw new Error('scheduler shard must run in a thread realm with a realm port');
  return new ShardScheduler(resolved, port).run();
}
