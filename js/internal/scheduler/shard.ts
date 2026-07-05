/**
* Real TypeScript thread-local scheduler loop.
*
* The scheduler owns one OS thread's readiness and powers the event loops of the
* tenant isolates assigned to it. It is deliberately tiny: it selects runnable
* workloads, pumps them, performs their facade-owned I/O on its own loop, and
* reports coarse load to the orchestrator. It never blocks the thread on any one
* workload — runnable workloads settle concurrently, so a workload awaiting I/O
* cannot starve an I/O-ready sibling, and a workload parked on an outstanding
* operation waits on its wake fd rather than spinning.
*
* @internal
*/
import { claimWorkloads, dispatchWorkload, pollWakes, recordShardLoad, releaseLease, renewLease } from 'internal:scheduler/host';
import { readable } from 'internal:runtime/loop';
import { DiskFileSystem, DT_DIR, DT_REG, DT_UNKNOWN, type File, type Entry, type Stat } from 'fino:file';
import { encodeBinary, decodeBinary } from './facade-ops.ts';
import { Isolate } from './isolate.ts';
import { coalesceWake, firstWake, selectNextWorkload } from './selection.ts';
import type { DispatchResult, LeaseRecord, RunnableWorkload, SchedulerShardConfig, SchedulerShardSummary, ShardLoadSummary, TenantWake } from './types.ts';

interface HeldWorkload {
  lease: LeaseRecord;
  wakes: TenantWake[];
  debtMicros: number;
  sequence: number;
  isolate?: Isolate;
}

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

async function releaseHeld(held: Map<string, HeldWorkload>, workloadId: string, reason: string): Promise<boolean> {
  const workload = held.get(workloadId);
  if (workload === undefined) return false;
  held.delete(workloadId);
  workload.isolate?.terminate();
  await releaseLease(workload.lease.leaseId, reason);
  return true;
}

function applyWakes(held: Map<string, HeldWorkload>, wakes: TenantWake[]): void {
  for (const rawWake of wakes) {
    const workload = held.get(rawWake.workloadId);
    if (workload === undefined) continue;
    const wake = {
      ...rawWake,
      sequence: rawWake.sequence ?? ++globalSequence
    };
    workload.wakes = coalesceWake(workload.wakes, wake);
  }
}

function applyDispatchResult(workload: HeldWorkload, result: DispatchResult): void {
  const costMicros = Math.max(0, result.costMicros ?? 0);
  if (result.result === 'budget_yield') {
    workload.debtMicros += costMicros;
    return;
  }
  workload.debtMicros = Math.max(0, workload.debtMicros - costMicros);
  if (result.result === 'idle') {
    workload.wakes.shift();
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

/**
* Settle one native (scheduled-isolate) workload. Pumps the isolate, performing
* any facade-owned host operations on the scheduler's own loop and parking on
* the isolate's wake fd if it yields with an outstanding operation. Runs to a
* terminal `DispatchResult`.
*/
async function settleNative(isolate: Isolate, request: unknown, hardBudgetMicros: number): Promise<DispatchResult> {
  let requestJson = JSON.stringify(request);
  for (;;) {
    const outcome = isolate.pump(requestJson, hardBudgetMicros);
    requestJson = '{}';
    if (outcome.kind === 'hostOperation') {
      try {
        const result = await runHostOperation(outcome.operation);
        isolate.complete(outcome.operation.id, true, JSON.stringify(result));
      } catch (error) {
        isolate.complete(outcome.operation.id, false, JSON.stringify({
          message: error instanceof Error ? error.message : String(error)
        }));
      }
      continue;
    }
    if (outcome.kind === 'pending') {
      // Parked on a background completion; wait on the isolate's wake fd rather
      // than spinning. Re-pump when a completion is written.
      await readable(isolate.wakeFd);
      continue;
    }
    if (outcome.kind === 'budgetTerminated') {
      // The workload overran its hard sync budget and was forcibly unwound.
      return { result: 'terminated' };
    }
    return outcome.value as DispatchResult;
  }
}

async function settleWorkload(workload: HeldWorkload, request: unknown, hardBudgetMicros: number): Promise<DispatchResult> {
  if (workload.isolate !== undefined) return settleNative(workload.isolate, request, hardBudgetMicros);
  return dispatchWorkload(workload.lease.leaseId, request as never);
}

/**
* Select up to `limit` distinct runnable workloads in scheduler priority order.
*/
function selectBatch(held: Map<string, HeldWorkload>, limit: number): HeldWorkload[] {
  const batch: HeldWorkload[] = [];
  const chosen = new Set<string>();
  while (batch.length < limit) {
    const candidates: RunnableWorkload[] = [];
    for (const workload of held.values()) {
      if (chosen.has(workload.lease.workloadId)) continue;
      candidates.push(runnableFromHeld(workload));
    }
    const runnable = selectNextWorkload(candidates);
    if (runnable === null) break;
    const workload = held.get(runnable.workloadId);
    if (workload === undefined) break;
    batch.push(workload);
    chosen.add(workload.lease.workloadId);
  }
  return batch;
}

export async function runSchedulerShard(config: SchedulerShardConfig): Promise<SchedulerShardSummary> {
  const capacity = normalizeCapacity(config.capacity);
  const maxDispatches = config.maxDispatches ?? Number.POSITIVE_INFINITY;
  const maxPolls = config.maxPolls ?? Number.POSITIVE_INFINITY;
  const pollTimeoutMs = config.pollTimeoutMs ?? 0;
  const budgetMicros = config.budgetMicros ?? DEFAULT_BUDGET_MICROS;
  const hardBudgetMicros = config.hardBudgetMicros ?? DEFAULT_HARD_BUDGET_MICROS;
  const renewEvery = config.renewEvery ?? 16;
  const held = new Map<string, HeldWorkload>();
  let dispatches = 0;
  let released = 0;
  let polls = 0;

  const leases = await claimWorkloads(config.shardId, capacity);
  for (const lease of leases.slice(0, capacity)) {
    if (held.has(lease.workloadId)) continue;
    held.set(lease.workloadId, {
      lease,
      wakes: [],
      debtMicros: 0,
      sequence: ++globalSequence,
      ...lease.entryPath !== undefined ? { isolate: new Isolate(lease.entryPath) } : {}
    });
  }

  while (dispatches < maxDispatches && polls < maxPolls) {
    const wakes = await pollWakes(config.shardId, pollTimeoutMs);
    polls++;
    applyWakes(held, wakes);

    const remaining = maxDispatches - dispatches;
    const batch = selectBatch(held, remaining);
    if (batch.length === 0) {
      await recordShardLoad(config.shardId, summarize(config.shardId, held, dispatches));
      continue;
    }

    // Renew leases for the batch; drop any that fail renewal before dispatch.
    const dispatchable: HeldWorkload[] = [];
    for (const workload of batch) {
      if (renewEvery > 0 && (dispatches + dispatchable.length + 1) % renewEvery === 0) {
        const renewed = await renewLease(workload.lease.leaseId, workload.lease.epoch);
        if (!renewed) {
          if (await releaseHeld(held, workload.lease.workloadId, 'renew_failed')) released++;
          continue;
        }
      }
      dispatchable.push(workload);
    }

    if (dispatchable.length === 0) {
      await recordShardLoad(config.shardId, summarize(config.shardId, held, dispatches));
      continue;
    }

    // Settle the batch concurrently so no workload's I/O starves another.
    const settlements = dispatchable.map((workload) => {
      const wake = firstWake(runnableFromHeld(workload));
      const request = {
        workloadId: workload.lease.workloadId,
        wake,
        budgetMicros,
        debtMicros: workload.debtMicros,
        data: workload.lease.data,
        ...workload.lease.handoff !== undefined ? { handoff: workload.lease.handoff } : {}
      };
      return settleWorkload(workload, request, hardBudgetMicros).then(
        (result) => ({ workload, result }),
        () => ({ workload, result: { result: 'failed' } as DispatchResult })
      );
    });
    const results = await Promise.all(settlements);
    dispatches += dispatchable.length;

    for (const { workload, result } of results) {
      if (result.result === 'failed' || result.result === 'terminated') {
        if (await releaseHeld(held, workload.lease.workloadId, result.result)) released++;
      } else {
        applyDispatchResult(workload, result);
      }
    }

    await recordShardLoad(config.shardId, summarize(config.shardId, held, dispatches));
  }

  if (config.releaseOnShutdown) {
    for (const workload of [...held.values()]) {
      if (await releaseHeld(held, workload.lease.workloadId, 'shutdown')) released++;
    }
  }

  await recordShardLoad(config.shardId, summarize(config.shardId, held, dispatches));

  return {
    shardId: config.shardId,
    claimed: leases.length,
    dispatches,
    released,
    heldLeases: held.size
  };
}
