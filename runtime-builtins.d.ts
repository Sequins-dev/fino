/**
 * fino:ffi — Rust-backed native library binding.
 *
 * This synthetic module exposes Fino's low-level FFI surface. It is intended
 * for runtime modules and advanced applications that need to load system
 * libraries, call C ABI functions, pass pointers, or expose JS callbacks to
 * native code.
 *
 * FFI calls are process-local and can crash the runtime when signatures,
 * pointer lifetimes, or struct layouts are wrong. Prefer higher-level `fino:*`
 * modules when one exists.
 */
declare module 'fino:ffi' {
  /**
   * Native function signature metadata passed to `dlopen`.
   */
  export interface NativeSymbolSpec {
    /**
     * Positional native parameter descriptors.
     */
    parameters?: readonly unknown[];
    /**
     * Native return descriptor.
     */
    result?: unknown;
    /**
     * Run the call on the native blocking pool when true.
     */
    nonblocking?: boolean;
    /**
     * Run the call on the native blocking pool when true.
     */
    async?: boolean;
  }
  /**
   * Map of C symbol names to native call signatures.
   */
  export type NativeSymbolMap = Record<string, NativeSymbolSpec>;
  /**
   * Callable JS wrappers for symbols loaded from a dynamic library.
   */
  export type NativeBindings<TSymbols extends NativeSymbolMap> = {
    [K in keyof TSymbols]: (...args: any[]) => any;
  };
  /**
   * Handle returned by `dlopen`.
   */
  export interface DynamicLibrary<TSymbols extends NativeSymbolMap = NativeSymbolMap> {
    /**
     * Bound native symbols keyed by their C symbol name.
     */
    symbols: NativeBindings<TSymbols>;
  }
  /**
   * A native pointer value: an 8-byte `ArrayBuffer` holding the address as a
   * little-endian `u64`, or `null` for the C null pointer.
   */
  export type NativePointer = ArrayBuffer | ArrayBufferView | null;
  /**
   * Namespace of pointer and raw-memory helpers.
   */
  export const Pointer: {
    /**
     * The C null pointer.
     */
    null(): null;
    /**
     * Backing-store address of a buffer as a `bigint`. For views, `byteOffset`
     * is applied so the address points at element 0.
     */
    addr(source: ArrayBuffer | ArrayBufferView): bigint;
    /**
     * Pointer arithmetic: a new pointer advanced by `bytes`.
     */
    offset(ptr: NativePointer, bytes: number): NativePointer;
    /**
     * Take the address of a buffer's backing store as a pointer value. With an
     * `arena`, the address is written into `arena` at `byteOffset` with zero
     * allocation and `undefined` is returned.
     */
    of(
      source: ArrayBuffer | ArrayBufferView,
      arena?: ArrayBuffer | ArrayBufferView,
      byteOffset?: number,
    ): ArrayBuffer | undefined;
    readU8(ptr: NativePointer, offset?: number): number;
    readI8(ptr: NativePointer, offset?: number): number;
    readU16(ptr: NativePointer, offset?: number): number;
    readI16(ptr: NativePointer, offset?: number): number;
    readU32(ptr: NativePointer, offset?: number): number;
    readI32(ptr: NativePointer, offset?: number): number;
    readU64(ptr: NativePointer, offset?: number): bigint;
    readI64(ptr: NativePointer, offset?: number): bigint;
    readF32(ptr: NativePointer, offset?: number): number;
    readF64(ptr: NativePointer, offset?: number): number;
    /**
     * Dereference a pointer-sized field at `ptr + offset`.
     */
    readPointer(ptr: NativePointer, offset?: number): NativePointer;
    writeU8(ptr: NativePointer, offset: number, value: number | bigint): void;
    writeI8(ptr: NativePointer, offset: number, value: number | bigint): void;
    writeU16(ptr: NativePointer, offset: number, value: number | bigint): void;
    writeI16(ptr: NativePointer, offset: number, value: number | bigint): void;
    writeU32(ptr: NativePointer, offset: number, value: number | bigint): void;
    writeI32(ptr: NativePointer, offset: number, value: number | bigint): void;
    writeU64(ptr: NativePointer, offset: number, value: number | bigint): void;
    writeI64(ptr: NativePointer, offset: number, value: number | bigint): void;
    writeF32(ptr: NativePointer, offset: number, value: number): void;
    writeF64(ptr: NativePointer, offset: number, value: number): void;
    writePointer(ptr: NativePointer, offset: number, value: NativePointer): void;
    /**
     * Copy `len` bytes from `ptr` into a new `Uint8Array`.
     */
    copyFrom(ptr: NativePointer, len: number): Uint8Array;
    /**
     * Copy bytes from `ptr` into an existing buffer. `len` defaults to the
     * destination's byte length.
     */
    copyFromInto(dest: ArrayBuffer | ArrayBufferView, ptr: NativePointer, len?: number): void;
    /**
     * Copy the bytes of `src` to the native buffer at `ptr`.
     */
    copyTo(ptr: NativePointer, src: Uint8Array | ArrayBuffer): void;
    /**
     * Create an `ArrayBuffer` that aliases the native memory at
     * `[ptr, ptr + len)` without copying.
     *
     * The native allocation must outlive the buffer unless `onRelease` owns
     * freeing it: it fires exactly once, on the JS thread, after V8 frees the
     * backing store (GC of the buffer, or transfer/detach). Structured clone
     * copies the bytes; transferring detaches the buffer and triggers release.
     */
    view(ptr: NativePointer, len: number, opts?: { onRelease?: () => void }): ArrayBuffer;
  };
  /**
   * Native callback constructor.
   *
   * Constructed callbacks expose a native function pointer and must be retained
   * for as long as native code may call them.
   */
  export const FfiCallback: any;
  /**
   * Build a by-value struct descriptor from field layout metadata.
   */
  export function structType(fields: readonly unknown[], options?: { size?: number; align?: number }): unknown;
  /**
   * Open a dynamic library and bind the requested symbols.
   *
   * `path` may be `null` to resolve symbols from the current process.
   */
  export function dlopen<TSymbols extends NativeSymbolMap = NativeSymbolMap>(path: string | null, symbols: TSymbols): DynamicLibrary<TSymbols>;
}

/**
 * fino:profiler — Rust-backed CPU profiler controls.
 *
 * The profiler module starts and stops V8 CPU profile capture from JS code.
 * `stopProfiling()` returns the serialized profile bytes; callers choose where
 * to store or upload them.
 */
declare module 'fino:profiler' {
  /**
   * Start collecting a named CPU profile.
   */
  export function startProfiling(name?: string): void;
  /**
   * Stop collecting a named CPU profile and return its serialized bytes.
   */
  export function stopProfiling(name?: string): Uint8Array;
}

/**
 * internal:process — Rust-backed process snapshot.
 *
 * @internal
 */
declare module 'internal:process' {
  /**
   * Operating-system identifier selected by the Rust host.
   */
  export const os: string;
  /**
   * CPU architecture identifier selected by the Rust host.
   */
  export const arch: string;
  /**
   * Runtime argv values.
   */
  export const args: string[];
  /**
   * Environment variables captured for the current process.
   */
  export const env: Record<string, string | undefined>;
  /**
   * Absolute path to the current Fino executable.
   */
  export const execPath: string;
}

/**
 * internal:async-context — Rust-backed async context hooks.
 *
 * @internal
 */
declare module 'internal:async-context' {
  /**
   * Drain V8 microtasks synchronously.
   */
  export function drainMicrotasks(): void;
  /**
   * Return true when V8 has pending tasks.
   */
  export function hasPendingV8Tasks(): boolean;
  /**
   * Drive the runtime loop until the callback reports completion.
   */
  export function runLoop(step: () => boolean, onDone: () => void): void;
  /**
   * Schedule a synchronous callback on the runtime loop.
   */
  export function scheduleSync(fn: () => void): void;
  /**
   * Read the current continuation-preserved embedder data value.
   */
  export function getCPED(): unknown;
  /**
   * Set the current continuation-preserved embedder data value.
   */
  export function setCPED(value: unknown): void;
}

/**
 * internal:loader-hooks — Rust-backed module loader callbacks.
 *
 * @internal
 */
declare module 'internal:loader-hooks' {
  /**
   * Original source-map position.
   */
  export interface OriginalPosition {
    source: string;
    line: number;
    column: number;
  }
  /**
   * Look up an original source position for generated code.
   */
  export function lookupOriginalPosition(source: string, line: number, column: number): OriginalPosition | null;
  /**
   * Register the JavaScript resolver used by the Rust loader.
   */
  export function registerResolve(fn: (specifier: string, referrerDir: string | null, root: string) => string): void;
  /**
   * Register the import.meta initializer used by the Rust loader.
   */
  export function registerInitMeta(
    fn: (
      meta: ImportMeta & { resolve?: (specifier: string) => string },
      filename: string,
      root: string,
    ) => void,
  ): void;
  /**
   * Register the TypeScript transpiler used for local source modules.
   */
  export function registerTranspile(fn: (path: string, source: string) => { code: string; map?: string }): void;
  /**
   * Return the current package-map JSON, if one was supplied by the host.
   */
  export function getPackageMap(): string | null;
  /**
   * Allow internal module imports for test execution.
   */
  export function allowInternalForTests(): void;
}

/**
 * internal:docgen — Rust-backed documentation parser bridge.
 *
 * @internal
 */
declare module 'internal:docgen' {
  /**
   * Extract documentation JSON for a source module.
   */
  export function extractModule(path: string): string;
}

/**
 * internal:runtime/loop-backend — platform event-loop backend.
 *
 * @internal
 */
declare module 'internal:runtime/loop-backend' {
  /**
   * Read readiness filter constant.
   */
  export const EVFILT_READ: number;
  /**
   * Write readiness filter constant.
   */
  export const EVFILT_WRITE: number;
  /**
   * Timer readiness filter constant.
   */
  export const EVFILT_TIMER: number;
  /**
   * Process readiness filter constant, or `null` when unsupported.
   */
  export const EVFILT_PROC: number | null;
  /**
   * Completion readiness filter constant, or `null` when unsupported.
   */
  export const EVFILT_COMPLETION: number | null;
  /**
   * Vnode readiness filter constant, or `null` when unsupported.
   */
  export const EVFILT_VNODE: number | null;
  /**
   * Signal readiness filter constant, or `null` when unsupported.
   */
  export const EVFILT_SIGNAL: number | null;
  /**
   * Create a native loop backend handle.
   */
  export function create(): object;
  /**
   * Destroy a native loop backend handle.
   */
  export function destroy(raw: object): void;
  /**
   * Watch an fd for read readiness.
   */
  export function addRead(raw: object, fd: number): void;
  /**
   * Watch an fd for write readiness.
   */
  export function addWrite(raw: object, fd: number): void;
  /**
   * Stop watching an fd for read readiness.
   */
  export function removeRead(raw: object, fd: number): void;
  /**
   * Stop watching an fd for write readiness.
   */
  export function removeWrite(raw: object, fd: number): void;
  /**
   * Add a one-shot timer.
   */
  export function addTimer(raw: object, id: number, ms: number): void;
  /**
   * Remove a pending timer.
   */
  export function removeTimer(raw: object, id: number): void;
  /**
   * Watch a child process when supported by the backend.
   */
  export const addProc: ((raw: object, pid: number) => void) | undefined;
  /**
   * Stop watching a child process when supported by the backend.
   */
  export const removeProc: ((raw: object, pid: number) => void) | undefined;
  /**
   * Watch a signal when supported by the backend.
   */
  export const addSignal: ((raw: object, signal: number) => void) | undefined;
  /**
   * Stop watching a signal when supported by the backend.
   */
  export const removeSignal: ((raw: object, signal: number) => void) | undefined;
  /**
   * Watch vnode changes when supported by the backend.
   */
  export const addVnode: ((raw: object, fd: number, flags: number) => void) | undefined;
  /**
   * Stop watching vnode changes when supported by the backend.
   */
  export const removeVnode: ((raw: object, fd: number) => void) | undefined;
  /**
   * Wait for native loop events.
   */
  export function wait(raw: object, timeout: number): Array<{ ident: number; filter: number; flags: number; fflags?: number; res?: number }>;
}

/**
 * internal:format/typescript — Rust-backed OXC parser bridge.
 *
 * @internal
 */
declare module 'internal:format/typescript' {
  /**
   * Parse JavaScript or TypeScript source with OXC.
   */
  export function parse(source: string, options?: Record<string, unknown>): unknown;
  /**
   * Transpile JavaScript or TypeScript source with OXC.
   */
  export function transpile(source: string, options?: Record<string, unknown>): unknown;
  /**
   * Format JavaScript or TypeScript source with OXC.
   */
  export function format(source: string, options?: Record<string, unknown>): unknown;
  /**
   * Lint JavaScript or TypeScript source with OXC.
   */
  export function lint(source: string, options?: Record<string, unknown>): unknown;
}

/**
 * internal:async-runtime — Rust-backed wake fd helpers.
 *
 * @internal
 */
declare module 'internal:async-runtime' {
  /**
   * File descriptor used to wake the runtime loop.
   */
  export const wakeFd: number;
  /**
   * Drain pending wake notifications.
   */
  export function drainWakes(): number;
}

/**
 * internal:inspector — Rust-backed V8 inspector bridge.
 *
 * @internal
 */
declare module 'internal:inspector' {
  /**
   * Dispatch a Chrome DevTools Protocol message to V8.
   */
  export function dispatch(message: string): void;
  /**
   * Register the inspector outbound message callback.
   */
  export function onMessage(callback: (message: string) => void): void;
  /**
   * Allocate the next inspector request id.
   */
  export function nextId(): number;
  /**
   * Evaluate JavaScript through the inspector session.
   */
  export function evaluate(expression: string): unknown;
}

/**
 * internal:serializer — Rust-backed V8 value serialization.
 *
 * @internal
 */
declare module 'internal:serializer' {
  /**
   * Serialize a value and optional transferred `ArrayBuffer`s.
   */
  export function serialize(value: unknown, transferList?: ArrayBuffer[]): Uint8Array[];
  /**
   * Deserialize bytes produced by `serialize`.
   */
  export function deserialize(data: Uint8Array, transferStore?: Uint8Array[]): unknown;
  /**
   * Detach an `ArrayBuffer`.
   */
  export function detachArrayBuffer(buffer: ArrayBuffer): void;
}

/**
 * internal:broadcast — Rust-backed cross-realm byte broadcast.
 *
 * @internal
 */
declare module 'internal:broadcast' {
  /**
   * Subscribe to a named broadcast channel.
   */
  export function subscribe(name: string): number;
  /**
   * Publish bytes to a named broadcast channel.
   */
  export function publish(name: string, data: Uint8Array): void;
  /**
   * Receive the next queued broadcast payload for a subscriber.
   */
  export function receive(subscriber: number): Uint8Array | null;
  /**
   * Remove a broadcast subscriber.
   */
  export function unsubscribe(subscriber: number): void;
  /**
   * Wake a broadcast subscriber.
   */
  export function wakeSubscriber(subscriber: number): void;
}

/**
 * internal:thread-port — Rust-backed parent/child thread port.
 *
 * @internal
 */
declare module 'internal:thread-port' {
  /**
   * Send bytes to the paired thread port.
   */
  export function nativeSend(data: Uint8Array): void;
  /**
   * Receive bytes from the paired thread port.
   */
  export function nativeRecv(): Uint8Array | null;
  /**
   * Return the wake fd for the paired thread port.
   */
  export function getWakeReadFd(): number;
}

/**
 * internal:transit-port — Rust-backed transferable port channel.
 *
 * @internal
 */
declare module 'internal:transit-port' {
  /**
   * Create a paired transit channel.
   */
  export function createTransitChannel(): unknown;
  /**
   * Send bytes through a transit port.
   */
  export function transitSend(port: unknown, data: Uint8Array): void;
  /**
   * Receive bytes from a transit port.
   */
  export function transitRecv(port: unknown): Uint8Array | null;
}

/**
 * internal:realm-bridge — Rust-backed current realm state.
 *
 * @internal
 */
declare module 'internal:realm-bridge' {
  /**
   * Return the entry path for the current realm.
   */
  export function getEntryPath(): string | null;
  /**
   * Return true when the current realm is terminating.
   */
  export function isTerminated(): boolean;
  /**
   * Return the current realm port object.
   */
  export function getPort(): unknown;
  /**
   * Record an entrypoint failure for the host.
   */
  export function setEntryError(error: unknown): void;
  /**
   * Return filesystem paths loaded by the current realm.
   */
  export function getLoadedFsPaths(): string[];
  /**
   * Request a watch-mode reload.
   */
  export function requestReload(): void;
  /**
   * Return true when the current realm is running in watch mode.
   */
  export function getWatchMode(): boolean;
  /**
   * Return true when the current realm is running the REPL.
   */
  export function getReplMode(): boolean;
}

/**
 * internal:realm-native — Rust-backed realm lifecycle operations.
 *
 * @internal
 */
declare module 'internal:realm-native' {
  /**
   * Create an embedded child realm context.
   */
  export function createContext(config: unknown): unknown;
  /**
   * Step an embedded child realm context.
   */
  export function stepContext(context: unknown): unknown;
  /**
   * Terminate a child realm.
   */
  export function terminateChild(context: unknown): void;
  /**
   * Create a thread child realm context.
   */
  export function createThreadContext(config: unknown): unknown;
  /**
   * Step a thread child realm context.
   */
  export function stepThreadContext(context: unknown): unknown;
  /**
   * Send bytes to a thread child port.
   */
  export function threadPortSend(context: unknown, data: Uint8Array): void;
  /**
   * Receive bytes from a thread child port.
   */
  export function threadPortRecv(context: unknown): Uint8Array | null;
  /**
   * Return a thread child wake fd.
   */
  export function getThreadPortWakeReadFd(context: unknown): number;
  /**
   * Create a process child realm context.
   */
  export function createProcessContext(config: unknown): unknown;
  /**
   * Step a process child realm context.
   */
  export function stepProcessContext(context: unknown): unknown;
  /**
   * Send bytes to a process child port.
   */
  export function processPortSend(context: unknown, data: Uint8Array): void;
  /**
   * Receive bytes from a process child port.
   */
  export function processPortRecv(context: unknown): Uint8Array | null;
  /**
   * Return the process child socket fd.
   */
  export function getProcessSocketFd(context: unknown): number;
}

/**
 * internal:synthetic-install — Rust-backed synthetic module installer.
 *
 * @internal
 */
declare module 'internal:synthetic-install' {
  /**
   * Install a synthetic module into the current realm.
   */
  export function _installSyntheticModule(spec: unknown): void;
  /**
   * Uninstall a synthetic module from the current realm.
   */
  export function _uninstallSyntheticModule(specifier: string): void;
}

// Shorthand ambient declarations for fino: built-in modules that don't have
// explicit tsconfig path mappings (e.g. fino:bench, fino:abort, fino:crypto…).
// Shorthand form makes all exports `any`; modules with explicit paths override.
declare module 'fino:abort';
declare module 'fino:blob';
declare module 'fino:console';
declare module 'fino:context';
declare module 'fino:crypto';
declare module 'fino:dns';
declare module 'fino:encoding';
declare module 'fino:eventtarget';
declare module 'fino:formdata';
declare module 'fino:loop';
declare module 'fino:path';
declare module 'fino:process';
declare module 'fino:socket';
declare module 'fino:time';
declare module 'fino:url';
declare module 'fino:urlpattern';
declare module 'fino:webstreams';

declare global {
  interface ImportMeta {
    filename?: string;
    dirname?: string;
  }

  interface ErrorConstructor {
    prepareStackTrace?: (err: Error, callSites: unknown[]) => string;
  }

  var cryptoAvailable: boolean | undefined;
  var tlsAvailable: boolean | undefined;

  // Atomics.waitAsync — not yet in TypeScript's lib.esnext.atomics but supported in V8.
  interface Atomics {
    waitAsync(
      typedArray: Int32Array | BigInt64Array,
      index: number,
      value: number | bigint,
      timeout?: number,
    ): { async: false; value: 'ok' | 'not-equal' | 'timed-out' }
      | { async: true; value: Promise<'ok' | 'timed-out'> };
  }
}
