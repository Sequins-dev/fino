/**
 * internal:runtime/deterministic-effects — install reproducible ambient effects.
 *
 * This module composes the generic Realm-local clock, random source, timer
 * queue, and optional Facade-response scheduler. Filesystem, network, process,
 * and other external effects remain governed by their normal APIs and
 * import-map policy.
 *
 * @internal
 */
import { setClockOverride, wallMillis } from 'internal:runtime/clock';
import { _setVirtualTimerQueue } from 'internal:runtime/loop';
import { createSeededRandom, setRandomOverride } from 'internal:runtime/random';
import { VirtualTimerQueue } from 'internal:runtime/virtual-timers';
import { _installResponseDelay, outstandingCalls } from 'internal:parent-rpc';

/** Serializable deterministic-effect settings carried in Realm bootstrap data. @internal */
export interface DeterministicEffectsConfig {
  /** Seed shared by `Math.random()`, Web Crypto random bytes, and runtime entropy. */
  seed: number | string;
  /** Initial virtual wall time in Unix milliseconds. */
  startTime: number;
  /** Inclusive virtual-millisecond range applied to each Facade response. */
  responseLatency?: [number, number];
}

let installed = false;

/** Install deterministic ambient time and randomness in the current Realm. @internal */
export function installDeterministicEffects(config: DeterministicEffectsConfig): void {
  if (installed) return;
  installed = true;

  const timers = new VirtualTimerQueue(config.startTime);
  const random = createSeededRandom(config.seed);
  setRandomOverride(random);
  Object.defineProperty(Math, 'random', {
    value: () => random.nextFloat(),
    writable: true,
    configurable: true,
  });

  setClockOverride({
    monotonicNanos: () => (timers.now() - config.startTime) * 1e6,
    wallMillis: () => timers.now(),
  });
  installVirtualDate();
  _setVirtualTimerQueue(timers, () => outstandingCalls() > 0);
  if (config.responseLatency !== undefined) {
    const [minimum, maximum] = config.responseLatency;
    const latencyRandom = createSeededRandom(`${String(config.seed)}:response-latency`);
    const span = maximum - minimum;
    _installResponseDelay(() => timers.schedule(minimum + latencyRandom.nextFloat() * span));
  }
}

function installVirtualDate(): void {
  const PlatformDate = Date;
  const VirtualDate = new Proxy(PlatformDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) return Reflect.construct(target, [wallMillis()], newTarget);
      return Reflect.construct(target, args, newTarget);
    },
    apply() {
      return new PlatformDate(wallMillis()).toString();
    },
    get(target, property, receiver) {
      if (property === 'now') return wallMillis;
      return Reflect.get(target, property, receiver);
    },
  });
  Object.defineProperty(globalThis, 'Date', {
    value: VirtualDate,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
