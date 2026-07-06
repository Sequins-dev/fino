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
import { registerShutdownHook } from 'internal:shutdown';
import { DiskFileSystem, DT_DIR, DT_REG, DT_UNKNOWN, type File, type Entry, type Stat } from 'fino:file';
import { serialize } from 'internal:serializer';
import { Isolate, type HostOperation } from './isolate.ts';
import { coalesceWake, firstWake, pickRunnable, removeWake } from './selection.ts';
import type { DispatchResult, LeaseRecord, RunnableWorkload, SchedulerControlMessage, SchedulerShardConfig, SchedulerShardSummary, ShardLoadSummary, TenantWake } from './types.ts';

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
  /** Accumulated on-CPU time (µs) measured across this workload's sync pump slices. */
  cpuMicros: number;
  /** True once this workload has been reported sync-heavy, so it reports at most once. */
  syncHeavyReported: boolean;
}

// Liveness heartbeat cadence: a slow tick that proves the thread is alive to the
// orchestrator's hang backstop. Resource `load` is reported on change (see
// `#reportLoadIfChanged`), not on this timer — an idle shard is near-silent.
const DEFAULT_HEARTBEAT_MS = 1_500;
// Debt granularity for the load-report change signature: debt swings smaller
// than this band don't trigger a fresh report.
const DEBT_BAND_MICROS = 1_000;
// Soft on-CPU limit for one synchronous pump slice. A workload whose slice
// exceeds this is flagged sync-heavy so the orchestrator can migrate it to a
// batch thread, keeping latency-sensitive threads responsive. Well below the
// hard runaway budget — this is a scheduling hint, not a kill.
const DEFAULT_SYNC_SLICE_MICROS = 50_000;
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
  // Both `budget_yield` (yielded its slice) and `runnable` (has more to do)
  // consumed CPU without finishing, so both accrue fairness debt — otherwise a
  // workload that keeps returning `runnable` would monopolize at near-zero debt.
  if (result.result === 'budget_yield' || result.result === 'runnable') {
    workload.debtMicros += costMicros;
    return;
  }
  // `idle` finished servicing its wake: pay down debt and consume the wake that
  // was actually serviced (the earliest-deadline one `firstWake` selected), not
  // `wakes[0]` — otherwise an out-of-order wake is silently lost.
  workload.debtMicros = Math.max(0, workload.debtMicros - costMicros);
  workload.wakes = removeWake(workload.wakes, dispatched);
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

// Binary args (writeFile/pwrite/write payloads) arrive as Uint8Arrays — the
// pump outcome is an internal:serializer structured clone, so bytes cross
// intact rather than base64'd into JSON.
function requireBytes(value: unknown, name: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`${name} must be binary data`);
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
      return await hostFileSystem.readFile(requireString(args.path, 'path'));
    case 'writeFile':
      await hostFileSystem.writeFile(requireString(args.path, 'path'), requireBytes(args.data, 'data'));
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
      return await handle.pread(requireNumber(args.pos, 'pos'), requireNumber(args.len, 'len'));
    case 'pwrite':
      return await handle.pwrite(requireNumber(args.pos, 'pos'), requireBytes(args.data, 'data'));
    case 'bytes':
      return await handle.bytes();
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
      writer.write(requireBytes(args.data, 'data'));
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
  #heartbeatMs: number;
  #syncSliceMicros: number;
  #heapLimitBytes: number;
  #port: RealmPort;
  #held = new Map<string, HeldWorkload>();
  #runnable = new Set<string>();
  #ready = new Signal();
  /** Notified when the shard is asked to stop, so the heartbeat wait unblocks at once. */
  #stopped = new Signal();
  #running = true;
  #claimed = 0;
  #dispatches = 0;
  #released = 0;
  /** Signature of the last `load` report, so it re-reports only on real change. */
  #lastLoadSignature: string | null = null;

  constructor(config: SchedulerShardConfig, port: RealmPort) {
    this.#shardId = config.shardId;
    this.#budgetMicros = config.budgetMicros ?? DEFAULT_BUDGET_MICROS;
    this.#hardBudgetMicros = config.hardBudgetMicros ?? DEFAULT_HARD_BUDGET_MICROS;
    this.#heartbeatMs = config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#syncSliceMicros = config.syncSliceThresholdMicros ?? DEFAULT_SYNC_SLICE_MICROS;
    this.#heapLimitBytes = config.heapLimitBytes ?? 0;
    this.#port = port;
  }

  async run(): Promise<SchedulerShardSummary> {
    this.#port.addEventListener('message', (event) => this.#onControl(event.data as SchedulerControlMessage));
    this.#port.start?.();
    // Also stop on realm teardown: a hard `terminate()` (e.g. recovery killing a
    // shard) does not deliver a `shutdown` control message, so without this the
    // heartbeat loop would keep re-arming its timer and hold the thread alive.
    registerShutdownHook(() => this.#stop());
    const heartbeat = this.#heartbeatLoop();
    await this.#dispatchLoop();
    await heartbeat;
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
        this.#stop();
        break;
    }
  }

  /** Stop the scheduler: wake the dispatch loop and unblock the heartbeat so both exit. Idempotent. */
  #stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#ready.notify();
    this.#stopped.notify();
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
      cpuMicros: 0,
      syncHeavyReported: false,
      ...lease.entryPath !== undefined ? { isolate: new Isolate(lease.entryPath, this.#heapLimitBytes) } : {}
    });
    this.#reportLoadIfChanged();
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
    this.#reportLoadIfChanged();
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
    this.#reportLoadIfChanged();
  }

  /** Highest-priority runnable workload (shared ranking: priority, then debt, then age). */
  #pickRunnable(): HeldWorkload | null {
    const candidates: RunnableWorkload[] = [];
    for (const workloadId of this.#runnable) {
      const workload = this.#held.get(workloadId);
      if (workload !== undefined) candidates.push(runnableFromHeld(workload));
    }
    const best = pickRunnable(candidates);
    return best === null ? null : this.#held.get(best.workloadId) ?? null;
  }

  async #dispatchLoop(): Promise<void> {
    while (this.#running) {
      if (this.#runnable.size === 0) {
        // Nothing runnable: report the settled resource state (if it changed)
        // and park until a control message or completion wakes us. No polling.
        this.#reportLoadIfChanged();
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
      this.#reportLoadIfChanged();
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

    // Measure the on-CPU cost of this synchronous slice (a pump does no awaiting,
    // so its wall-clock is its on-CPU time). Report the workload sync-heavy the
    // first time a slice overruns the soft threshold, so the orchestrator can
    // migrate it to a batch thread.
    const startMs = Date.now();
    const outcome = isolate.pump(requestJson, this.#hardBudgetMicros);
    const sliceMicros = (Date.now() - startMs) * 1_000;
    workload.cpuMicros += sliceMicros;
    if (!workload.syncHeavyReported && sliceMicros > this.#syncSliceMicros) {
      workload.syncHeavyReported = true;
      this.#port.postMessage({ report: 'syncHeavy', shardId: this.#shardId, workloadId: workload.lease.workloadId, cpuMicros: workload.cpuMicros });
    }
    if (outcome.kind === 'hostOperations') {
      // Perform every operation the workload queued this pump concurrently; the
      // isolate is re-pumped as each completion lands and resumes once all have.
      workload.blocked = true;
      // `.catch` is a final backstop: #performHostOp already guards its own
      // completion, but an unexpected throw must never surface as an unhandled
      // rejection on this fire-and-forget path.
      for (const operation of outcome.operations) this.#performHostOp(workload, operation).catch(() => undefined);
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

  async #performHostOp(workload: HeldWorkload, operation: HostOperation): Promise<void> {
    // Results cross back as internal:serializer bytes, so binary payloads (file
    // reads) never touch base64. Compute the outcome first (so a serialize
    // failure is reported as an error rather than thrown), then complete once.
    let ok = true;
    let payload!: Uint8Array;
    try {
      payload = serialize(await runHostOperation(operation))[0] as Uint8Array;
    } catch (error) {
      ok = false;
      payload = serialize({ message: error instanceof Error ? error.message : String(error) })[0] as Uint8Array;
    }
    // The workload may have been released (its isolate terminated) while the op
    // was in flight — injecting into a dead isolate would throw. Guard the whole
    // resume so a mid-op revoke can't leak an unhandled rejection or leave the
    // workload `blocked` forever (never re-pumped).
    if (!this.#held.has(workload.lease.workloadId) || workload.isolate === undefined) return;
    workload.isolate.complete(operation.id, ok, payload);
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

  /** A coarse signature of the shard's resource state; a `load` report fires only when it changes. */
  #loadSignature(): string {
    let runnable = 0;
    let debt = 0;
    for (const workload of this.#held.values()) {
      if (workload.wakes.length > 0) runnable++;
      debt += workload.debtMicros;
    }
    return `${this.#held.size}:${runnable > 0 ? 1 : 0}:${Math.floor(debt / DEBT_BAND_MICROS)}`;
  }

  /** Report resource load, but only when the coarse signature actually changed. */
  #reportLoadIfChanged(): void {
    const signature = this.#loadSignature();
    if (signature === this.#lastLoadSignature) return;
    this.#lastLoadSignature = signature;
    this.#port.postMessage({ report: 'load', summary: summarize(this.#shardId, this.#held, this.#dispatches) });
  }

  /** Slow liveness tick — proves the thread is alive without polling for work. */
  async #heartbeatLoop(): Promise<void> {
    while (this.#running) {
      // Race the interval against the stop signal and cancel the timer once the
      // wait ends, so a stop never leaves a pending timer holding the loop alive.
      const tick = timeout(this.#heartbeatMs);
      await Promise.race([tick, this.#stopped.wait()]);
      tick.cancel();
      if (!this.#running) break;
      this.#port.postMessage({ report: 'heartbeat', shardId: this.#shardId, summary: summarize(this.#shardId, this.#held, this.#dispatches) });
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
