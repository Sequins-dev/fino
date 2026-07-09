/**
* internal:child-steppers — per-realm child-stepping registry.
*
* `fino:realm` registers its stepper hooks here at module evaluation, and the
* bootstrap harness reads them when wiring the host loop. This lives in its
* own module because bootstrap is evaluated directly by the host (outside the
* loader's builtin cache): importing `internal:bootstrap` from a builtin would
* evaluate a SECOND bootstrap instance — re-running realm setup side effects
* like arming a duplicate port watch on the wake fd.
*
* @internal
*/

let _childSteppers: { step: () => void; alive: () => boolean } | null = null;

/**
* Wire this realm's child-realm stepping into its host loop. Called by
* `fino:realm` at module evaluation — a realm that never creates children
* pays nothing, and every realm that does gets its own children advanced by
* its own host loop (nested realms are not a special case).
*
* @internal
*/
export function _registerChildSteppers(step: () => void, alive: () => boolean): void {
  _childSteppers = { step, alive };
}

/**
* Advance registered child realms by one step, if any.
*
* @internal
*/
export function _stepRegisteredChildren(): void {
  _childSteppers?.step();
}

/**
* Whether any registered child realm is still active.
*
* @internal
*/
export function _registeredChildrenAlive(): boolean {
  return _childSteppers?.alive() ?? false;
}
