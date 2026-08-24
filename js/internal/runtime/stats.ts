/**
 * internal:runtime/stats — the realm and node telemetry contract (FIN-28).
 *
 * This module is the contract, not just an implementation of it. Every signal
 * a scheduling or observability decision consumes is defined here: what it
 * measures, its units and range, how it is smoothed, how accurately it can be
 * attributed for each realm kind, and — the part that keeps the system honest
 * — what it cannot measure and how that inability is represented.
 *
 * ## Principles
 *
 * **Self-reporting, never polling.** Every realm samples itself and reports
 * upward; parents never observe children externally. This matches the
 * child-initiated lifecycle used everywhere else, and it is why fidelity
 * varies by realm kind rather than by observer.
 *
 * **Unknown is omitted, never faked.** A signal a realm cannot measure is
 * absent from its sample — `loopIdle` for reactor-driven realms is the
 * canonical case. A consumer must treat a missing field as "not knowable
 * here", not zero: a fabricated zero reads as "fully busy" to the balancer
 * and would drive real placement decisions off fiction.
 *
 * **Proxies are fine for scheduling; label them.** Placement needs a stable
 * ordering more than it needs truth. Where a signal is a proxy (embedded
 * realm CPU as parent stepping time; process CPU normalised by whole-node
 * cores) the doc on that field says so, and precision work is deferred until
 * a decision would actually change because of it.
 *
 * ## The signals
 *
 * **CPU** (`cpu`, ratio in [0, 1]) — process user+system time from
 * `getrusage(RUSAGE_SELF)`, delta over the sample window, normalised by
 * `capacityCores()`. Attribution by realm kind: process realms are exact
 * (their own process); thread and reactor-pooled realms report the whole
 * process, with per-workload attribution instead carried by the reactor
 * pool's `busyMicros` counters in the system realm's `NodeReport`; embedded
 * realms are indistinguishable from their parent. Known limitation: work a
 * realm offloads to the async-FFI blocking pool is charged to the process
 * total, not to the realm that submitted it — the pool has no per-owner
 * accounting. Do not build per-realm billing on `cpu`; it is a node pressure
 * signal.
 *
 * **Memory** (`memory`, bytes) — **peak** resident set (`ru_maxrss`), not
 * current. Peak never decreases, so this signal cannot observe recovery; it
 * answers "how big can this process get" (the capacity-planning question),
 * not "how much is free right now". Consumers wanting headroom must compare
 * against `capacityMemory` knowing the comparison is conservative. Current
 * RSS needs `task_info` on darwin and `/proc/self/statm` on Linux; add it as
 * a separate field when a consumer exists — do not change the meaning of
 * this one. Embedded and reactor-pooled realms share their host isolate, so
 * per-realm memory is **shared**: `heapSample()` reports the whole isolate,
 * and V8's `MeasureMemory` (unbound in the v8 crate) is the eventual path to
 * per-context attribution. Until then, share-of-isolate is unknowable and is
 * therefore not reported.
 *
 * **Loop idle** (`loopIdle`, ratio in [0, 1]) — fraction of the sample
 * window the realm's own event loop spent blocked in its backend wait,
 * from the loop's cumulative wait clock. This is the signal external
 * orchestrators cannot see: a node can be CPU-quiet yet have no loop
 * headroom. Only realms that own a blocking loop report it (the root realm,
 * process realms, thread realms); reactor-pooled realms omit it — their
 * waiting happens in the shared pool, attributed per-workload as
 * `activationDelayMicros` in `NodeReport`. Loop **lag** (scheduling delay of
 * a due timer) is deliberately not part of this contract yet: idle ratio and
 * activation delay cover the balancer's needs, and lag needs a
 * timer-fire-time histogram nothing currently consumes.
 *
 * **Handle counts** — `loop._activeHandleCounts()` (reads, writes, timers,
 * procs, completions, vnodes, atomics waiters). A liveness and
 * leak-diagnosis signal, not a load signal: it decides "may this loop exit"
 * and explains "why is this realm still alive". It stays off the wire; a
 * count of registrations says nothing about pressure.
 *
 * **Capacity** (`capacityCores`, `capacityMemory`) — schedulable cores
 * (`availableParallelism()`, which honours cgroup/affinity limits the way a
 * raw core count does not) and total physical memory (`hw.memsize` /
 * `_SC_PHYS_PAGES`). Static per process; sampled once. Capacity is what
 * makes `cpu` and `memory` comparable across heterogeneous nodes — 0.5 CPU
 * on 2 cores and on 64 cores are different amounts of headroom, and without
 * capacity on the wire the seed cannot tell them apart.
 *
 * ## Smoothing
 *
 * `cpu` and `loopIdle` are EWMAs with alpha 0.5: half the previous estimate,
 * half the newest window. The window is the caller's sampling cadence — the
 * system realm's interval (250 ms under test, heartbeat-paced otherwise) —
 * so the estimate reflects roughly the last two windows and a step change
 * converges in two to three samples. Alpha 0.5 favours responsiveness over
 * stability on purpose: the placement consumers already carry their own
 * hysteresis (watermark + minDelta), and double-smoothing would make the
 * balancer chase a value that lags the queue it is draining. The first call
 * has no window and reports `cpu: 0`; heartbeat consumers converge within a
 * couple of intervals, and one-shot callers must not trust a first sample.
 * Raw cumulative counters (`resourceSample()`, `_loopWaitedMs()`) stay
 * exposed for callers that want their own windows.
 *
 * ## How consumers use this
 *
 * The heartbeat (2.5 s cadence) carries `NodeLoad` — this module's sample
 * plus the queue counts and capacity attached in `fino:cluster` — to the
 * seed, which keeps the per-node view that placement scores
 * (`cpu + pendingSpecs`, each queued spec weighted like a saturated core).
 * The system realm samples on its own interval and reports over its port;
 * per-workload attribution (busyMicros, slices, activationDelayMicros) rides
 * that report, not this module.
 *
 * @internal
 */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
import {
  availableParallelism,
  isolateHeapStatistics,
  usesProcessReadiness,
} from 'internal:scheduler-native';
import { _loopWaitedMs } from 'internal:runtime/loop';

const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const isLinux = os === 'linux';
const RUSAGE_SELF = 0;
const lib = dlopen(LIBC, {
  getrusage: { parameters: ['i32', 'buffer'], result: 'i32' },
  ...(isLinux
    ? { sysconf: { parameters: ['i32'], result: 'isize' } }
    : {
        sysctlbyname: {
          parameters: ['buffer', 'buffer', 'buffer', 'pointer', 'usize'],
          result: 'i32',
        },
      }),
});

/** Cumulative process resource usage. */
export interface ResourceSample {
  /** User plus system CPU time consumed by the process, in microseconds. */
  cpuMicros: number;
  /** Peak resident set size in bytes. */
  maxRssBytes: number;
}

/**
 * Read `getrusage(RUSAGE_SELF)`.
 *
 * Layout note: `ru_utime` and `ru_stime` are 16-byte-aligned timevals on both
 * 64-bit darwin and glibc, so the seconds fields sit at offsets 0 and 16 and
 * `ru_maxrss` at 32. `tv_usec` is below 1e6, so a 32-bit little-endian read
 * of its first word is exact on both platforms. Linux reports maxrss in
 * kilobytes, darwin in bytes.
 */
export function resourceSample(): ResourceSample {
  const buf = new ArrayBuffer(256);
  if (Number(lib.symbols.getrusage(RUSAGE_SELF, buf)) !== 0) {
    return { cpuMicros: 0, maxRssBytes: 0 };
  }
  const view = new DataView(buf);
  const seconds = Number(view.getBigInt64(0, true)) + Number(view.getBigInt64(16, true));
  const cpuMicros = seconds * 1e6 + view.getInt32(8, true) + view.getInt32(24, true);
  const maxrss = Number(view.getBigInt64(32, true));
  return { cpuMicros, maxRssBytes: isLinux ? maxrss * 1024 : maxrss };
}

/** One smoothed node-load observation, shaped for the cluster wire. */
export interface NodeLoadSample {
  /** Process CPU pressure normalised by core count, in `[0, 1]`. */
  cpu: number;
  /** Peak resident set size in bytes. */
  memory: number;
  /** Fraction of wall time the loop spent blocked waiting, in `[0, 1]`. */
  loopIdle?: number;
}

const EWMA_ALPHA = 0.5;
const cores = Math.max(1, availableParallelism());
const ownsBlockingLoop = !usesProcessReadiness();
let previous: { atMs: number; cpuMicros: number; waitedMs: number } | null = null;
let cpuEwma: number | null = null;
let idleEwma: number | null = null;

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Sample this realm's node-load view, smoothed against the previous call.
 *
 * The first call has no window and reports zero CPU; callers on a heartbeat
 * timer converge within a couple of intervals.
 */
export function sampleNodeLoad(): NodeLoadSample {
  const now = performance.now();
  const resources = resourceSample();
  const waitedMs = ownsBlockingLoop ? _loopWaitedMs() : 0;
  if (previous !== null && now > previous.atMs) {
    const wallMicros = (now - previous.atMs) * 1000;
    const cpu = clampRatio((resources.cpuMicros - previous.cpuMicros) / (wallMicros * cores));
    cpuEwma = cpuEwma === null ? cpu : cpuEwma + EWMA_ALPHA * (cpu - cpuEwma);
    if (ownsBlockingLoop) {
      const idle = clampRatio((waitedMs - previous.waitedMs) / (now - previous.atMs));
      idleEwma = idleEwma === null ? idle : idleEwma + EWMA_ALPHA * (idle - idleEwma);
    }
  }
  previous = { atMs: now, cpuMicros: resources.cpuMicros, waitedMs };
  return {
    cpu: cpuEwma ?? 0,
    memory: resources.maxRssBytes,
    ...(ownsBlockingLoop && idleEwma !== null ? { loopIdle: idleEwma } : {}),
  };
}

/** Heap statistics for this realm's isolate. */
export const heapSample = isolateHeapStatistics;

/** Core count used to normalise CPU pressure. */
export function capacityCores(): number {
  return cores;
}

/** glibc `_SC_PHYS_PAGES` / `_SC_PAGESIZE`. */
const SC_PAGESIZE = 30;
const SC_PHYS_PAGES = 85;
let memoryBytes: number | null = null;

/**
 * Total physical memory in bytes, or `0` when the platform refuses to say.
 *
 * Static per process, so the lookup runs once. Zero rather than a guess on
 * failure: capacity is the denominator that makes memory comparable across
 * nodes, and a made-up denominator is worse than an absent one.
 */
export function capacityMemoryBytes(): number {
  if (memoryBytes !== null) return memoryBytes;
  if (isLinux) {
    const pages = Number(lib.symbols.sysconf!(SC_PHYS_PAGES));
    const pageSize = Number(lib.symbols.sysconf!(SC_PAGESIZE));
    memoryBytes = pages > 0 && pageSize > 0 ? pages * pageSize : 0;
    return memoryBytes;
  }
  const name = new TextEncoder().encode('hw.memsize\0');
  const out = new ArrayBuffer(8);
  const outLen = new ArrayBuffer(8);
  new DataView(outLen).setBigUint64(0, 8n, true);
  const rc = Number(lib.symbols.sysctlbyname!(name, out, outLen, null, 0));
  memoryBytes = rc === 0 ? Number(new DataView(out).getBigUint64(0, true)) : 0;
  return memoryBytes;
}
