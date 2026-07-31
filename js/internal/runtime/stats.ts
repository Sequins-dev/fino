/**
 * internal:runtime/stats — self-reported runtime load samples.
 *
 * Every realm samples itself; parents never observe children externally.
 * Process CPU and peak RSS come from `getrusage(RUSAGE_SELF)` over FFI,
 * isolate heap statistics from the scheduler-native hook, and the loop idle
 * ratio from the loop's cumulative backend-wait time. CPU and idle ratios are
 * smoothed with an EWMA (alpha 0.5) across successive `sampleNodeLoad()`
 * calls, so heartbeat consumers see stable values; the raw counters are also
 * exposed for callers that keep their own windows.
 *
 * Realms driven by the process reactor never block in their own loop — their
 * idle time lives in the reactor pool and is attributed by its per-workload
 * load counters — so `loopIdle` is omitted for them rather than reported as a
 * misleading zero.
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
