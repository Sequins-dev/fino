/**
 * internal:io — Realm-local descriptor operation provider.
 *
 * File, stream, and socket adapters obtain all of their native descriptor
 * operations here, including creation, metadata, configuration, and close.
 * Production exports direct FFI bindings: calls borrow the caller's storage
 * and execute on its current reactor, without serializing or detaching bytes.
 * The internal ABI follows the existing descriptor APIs, including partial
 * progress and errno. A replacement must implement every family it admits;
 * it must never fall back to a host descriptor for an unknown virtual handle.
 * Readiness is independently selected through internal:runtime/readiness.
 *
 * @internal
 */
export { file } from 'internal:io/file';
export { watch } from 'internal:io/watch';
export { stream } from 'internal:io/stream';
export { socket } from 'internal:io/socket';
export { terminal } from 'internal:io/terminal';
export { terminalMode } from 'internal:io/terminalMode';
export { cwd } from 'internal:io/cwd';
export { process, pipe2Lib } from 'internal:io/process';
export * as processInfo from 'internal:process';
export { spawn, spawnChdirLib, spawnInheritLib, spawnCloseFromLib } from 'internal:io/spawn';
export { capture } from 'internal:io/capture';
export { output } from 'internal:io/output';
export { security, securityErrno } from 'internal:io/security';
export * as tls from 'internal:openssl';
export { networkInterfaces } from 'internal:net-native';
