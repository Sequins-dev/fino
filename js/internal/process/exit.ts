/**
 * Realm-local interception for process exit requests.
 *
 * Hosts that execute untrusted or independently reported work inside an
 * in-process Realm can replace the process-wide exit effect with a local
 * failure. The handler is isolate-local because each Realm has its own module
 * graph. Ordinary scripts and process Realms install no handler and retain the
 * direct `_exit(2)` behavior from `fino:process`.
 *
 * @internal
 */

let exitHandler: ((code: number) => never) | undefined;

/** Install one Realm-local process-exit handler until the returned registration is disposed. */
export function installProcessExitHandler(handler: (code: number) => never): { dispose(): void } {
  if (exitHandler !== undefined) throw new Error('a process exit handler is already installed');
  exitHandler = handler;
  return {
    dispose(): void {
      if (exitHandler === handler) exitHandler = undefined;
    },
  };
}

/** Invoke the Realm-local handler when one is installed. */
export function interceptProcessExit(code: number): void {
  exitHandler?.(code);
}
