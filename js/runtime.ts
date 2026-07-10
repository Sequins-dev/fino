/**
* fino:runtime — control whether asynchronous resources keep a realm alive.
*
* Runtime handles are referenced by default. `unref()` allows an otherwise idle
* realm to exit while the resource remains able to deliver events whenever
* other referenced work is active. `ref()` restores normal liveness and
* `hasRef()` reports the current state.
*
* Numeric web timer IDs are supported without changing the web-compatible timer
* return type. Fino resource objects may implement the same three methods and
* are delegated to directly.
*
* ```ts no_run
* import { unref } from 'fino:runtime';
*
* const maintenance = setInterval(() => refreshCache(), 30_000);
* unref(maintenance);
* ```
*/
import { _setTimerRef, _timerHasRef } from './globals/time.ts';

/** A Fino resource whose contribution to realm liveness can be controlled. */
export interface RuntimeRefable {
  /** Make this resource keep its realm alive and return the resource. */
  ref(): this;
  /** Stop this resource from keeping its realm alive and return the resource. */
  unref(): this;
  /** Whether this resource currently keeps its realm alive. */
  hasRef(): boolean;
}

/**
* Make `handle` keep the current realm alive.
*
* `handle` may be a live numeric ID returned by a web timer function or a Fino
* resource implementing {@link RuntimeRefable}. Unknown timer IDs and objects
* without the refable contract throw.
*/
export function ref<T extends number | RuntimeRefable>(handle: T): T {
  if (typeof handle === 'number') {
    _setTimerRef(handle, true);
    return handle;
  }
  if (!isRefable(handle)) throw new TypeError('expected a refable runtime handle');
  handle.ref();
  return handle;
}

/**
* Stop `handle` from keeping the current realm alive.
*
* The resource is not canceled. It may continue delivering events while other
* referenced work keeps the realm running. Realm disposal eventually cancels
* any remaining unreferenced resources.
*/
export function unref<T extends number | RuntimeRefable>(handle: T): T {
  if (typeof handle === 'number') {
    _setTimerRef(handle, false);
    return handle;
  }
  if (!isRefable(handle)) throw new TypeError('expected a refable runtime handle');
  handle.unref();
  return handle;
}

/** Return whether `handle` currently contributes to realm liveness. */
export function hasRef(handle: number | RuntimeRefable): boolean {
  if (typeof handle === 'number') return _timerHasRef(handle);
  if (!isRefable(handle)) throw new TypeError('expected a refable runtime handle');
  return handle.hasRef();
}

function isRefable(value: unknown): value is RuntimeRefable {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  const candidate = value as Partial<RuntimeRefable>;
  return typeof candidate.ref === 'function' && typeof candidate.unref === 'function' && typeof candidate.hasRef === 'function';
}
