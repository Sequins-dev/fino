/**
 * internal:runtime/readiness — replaceable readiness request/delivery boundary.
 *
 * The production adapter publishes scalar watches to the Rust host and drains
 * owner-addressed completions. It never transfers application data. A simulated
 * adapter can retain requests, cancel them, and admit completions in controlled
 * order; waking an owner only schedules it and never enters its isolate.
 *
 * @internal
 */
import { registerProcessReadiness as register } from 'internal:scheduler-native';
import * as backend from 'internal:runtime/loop-backend';

/** Register a host watch, including synchronous signal-disposition changes. @internal */
export function registerProcessReadiness(
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  token: number,
): number {
  // Suppression precedes asynchronous arming, but a simulated subscription must
  // never change host disposition. Keep that effect inside this provider.
  if (filter === -6 && !(flags & 2)) backend.suppressSignalDefault?.(ident);
  return register(ident, filter, flags, fflags, data, token);
}

export {
  takeSharedLoopEvents,
  usesProcessReadiness,
  signalReactorOwner,
} from 'internal:scheduler-native';
