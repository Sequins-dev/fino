/**
 * Fail-closed application readiness for simulations without descriptor devices.
 *
 * Virtual timers are managed by the deterministic clock. Trusted Realm control
 * transport is scheduled independently, so refusing a guest watch cannot prevent
 * the simulator from communicating with or disposing its Realm.
 * Replace this module together with internal:io to admit virtual devices.
 *
 * @internal
 */
export function usesProcessReadiness(): boolean {
  return true;
}
export function registerProcessReadiness(
  _ident: number,
  _filter: number,
  flags: number,
  _fflags: number,
  _data: number,
  _token: number,
): number {
  if (flags & 2) return 0;
  throw new Error('fino:sim — native readiness is unavailable in a simulation');
}
const empty = new Float64Array();
export function takeSharedLoopEvents(_owner: number): Float64Array {
  return empty;
}
export function signalReactorOwner(_owner: number): void {
  throw new Error('fino:sim — native signaling is unavailable in a simulation');
}
