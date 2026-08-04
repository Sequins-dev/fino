/**
 * internal:sim/install — turn the current realm into a simulation container.
 *
 * Runs inside the child, before its entry module is imported, from the same
 * pre-entry hook that installs a sandbox policy. Everything it replaces is an
 * ambient global: nothing the guest imports grants `Date`, `Math.random`, or a
 * timer, so these have to be substituted directly.
 *
 * What it installs:
 *
 * - a virtual clock driving `Date`, `performance`, and every timer
 * - one seeded generator behind `Math.random` and exposed crypto randomness;
 *   OpenSSL operations whose internal entropy cannot be replaced are rejected
 * - a hidden parent port, so a realm under observation is not handed a live
 *   channel it never asked for
 *
 * ```ts no_run
 * import { installSimRealm } from 'internal:sim/install';
 *
 * installSimRealm({ seed: 42, startTime: 0, virtualTime: true });
 * ```
 *
 * @internal
 */
import { setVirtualClock, wallMillis } from 'internal:sim/clock';
import { createSeededRandom, randomSource, setRandomSource } from 'internal:sim/random';
import { _installVirtualTimers } from 'internal:runtime/loop';
import { _installResponseDelay, outstandingCalls } from 'internal:parent-rpc';
import { VirtualTimerQueue } from 'internal:sim/timers';
import type { ResolvedSimConfig } from 'internal:sim/config';
let _queue: VirtualTimerQueue | null = null;
/**
 * Replace `globalThis.Date` with one that reads the virtual clock.
 *
 * A Proxy rather than a subclass because `new Date()` reads V8's internal clock
 * directly instead of going through `Date.now`, and because `Date()` called
 * without `new` has to keep working. Instances stay real `Date` objects, so
 * `instanceof`, `structuredClone`, and serialization are unaffected.
 */
function installVirtualDate(): void {
  const RealDate = Date;
  const proxy = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) return Reflect.construct(target, [wallMillis()], newTarget);
      return Reflect.construct(target, args, newTarget);
    },
    apply() {
      return new RealDate(wallMillis()).toString();
    },
    get(target, property, receiver) {
      if (property === 'now') return _simDateNow;
      return Reflect.get(target, property, receiver);
    },
  });
  Object.defineProperty(globalThis, 'Date', {
    value: proxy,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
function _simDateNow(): number {
  return wallMillis();
}
/**
 * Make this realm deterministic.
 *
 * Safe to call once; a second call is ignored so a reloaded entry module cannot
 * reseed a run midway through.
 *
 * @internal
 */
export function installSimRealm(config: ResolvedSimConfig): void {
  if (_queue !== null) return;
  const queue = new VirtualTimerQueue(config.startTime);
  _queue = queue;
  setRandomSource(createSeededRandom(config.seed));
  Object.defineProperty(Math, 'random', {
    value: function random(): number {
      return _seededFloat();
    },
    writable: true,
    configurable: true,
  });
  if (config.virtualTime) {
    setVirtualClock({
      monotonicNanos: () => queue.now() * 1e6,
      wallMillis: () => queue.now(),
    });
    installVirtualDate();
    _installVirtualTimers(queue, () => outstandingCalls() > 0);
    if (config.latency !== null) {
      const [min, max] = config.latency;
      // Seeded separately from the guest's own generator, so adding latency to a
      // simulation does not shift the values the guest draws.
      const latencyRandom = createSeededRandom(`${String(config.seed)}:latency`);
      const span = Math.max(0, max - min);
      _installResponseDelay(() => {
        const delay = Math.max(0, min) + latencyRandom.nextFloat() * span;
        return queue.schedule(delay);
      });
    }
  }
  installSharedMemoryBan();
  installAmbientIoBoundary();
  delete (globalThis as Record<string, unknown>).realmPort;
}
/**
 * Keep ambient I/O on the same import-map boundary as explicit dependencies.
 * `fetch` reaches only the facade installed at `fino:net/fetch`; the other
 * network globals have no simulated transport and fail at construction.
 */
function installAmbientIoBoundary(): void {
  Object.defineProperty(globalThis, 'fetch', {
    value: simulatedFetch,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  for (const name of ['WebSocket', 'WebTransport', 'EventSource', 'BroadcastChannel']) {
    Object.defineProperty(globalThis, name, {
      value: class {
        constructor() {
          throw new Error(`fino:sim — ${name} requires a simulated facade`);
        }
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}
/**
 * Serve one ambient request through the facade selected by the import map.
 */
async function simulatedFetch(input: string | Request, init?: RequestInit): Promise<Response> {
  let provider: {
    handleRequest(request: {
      method: string;
      url: string;
      headers: Array<[string, string]>;
      body: Uint8Array | null;
    }): Promise<{
      status?: number;
      statusText?: string;
      headers?: Array<[string, string]>;
      body?: Uint8Array | null;
    }>;
  };
  try {
    provider = await import('fino:net/fetch');
  } catch (cause) {
    throw new Error('fino:sim — fetch requires a facade at fino:net/fetch', { cause });
  }
  const request = new Request(input, init);
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? null
      : new Uint8Array(await request.arrayBuffer());
  const answer = await provider.handleRequest({
    method: request.method,
    url: request.url,
    headers: [...request.headers],
    body,
  });
  return new Response(answer.body ?? null, {
    status: answer.status ?? 200,
    statusText: answer.statusText ?? '',
    headers: answer.headers ?? [],
  });
}
/**
 * Make shared memory unavailable to a simulated realm.
 *
 * A `SharedArrayBuffer` maps the same physical pages into more than one
 * isolate, so writes to it are neither ordered by the simulation nor visible in
 * its journal.
 */
function installSharedMemoryBan(): void {
  const reject = function SharedArrayBuffer(): never {
    throw new Error(
      'fino:sim — SharedArrayBuffer is unavailable in a simulated realm: shared memory is written outside the simulation and cannot be replayed',
    );
  };
  Object.defineProperty(globalThis, 'SharedArrayBuffer', {
    value: reject,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
/**
 * Draw a float from the realm's seeded generator.
 *
 * Read through `randomSource()` on every call rather than captured once, so
 * `Math.random` advances the same stream `crypto` draws from — one seeded
 * sequence per realm, not two that happen to share a seed.
 */
function _seededFloat(): number {
  const source = randomSource();
  if (source === null) throw new Error('sim: random source missing from a simulated realm');
  return source.nextFloat();
}
