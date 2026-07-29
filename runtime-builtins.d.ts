/**
 * fino:ffi - Rust-backed native library binding.
 *
 * This synthetic module exposes Fino's low-level C ABI surface. It is intended
 * for built-in runtime modules and advanced applications that need to load
 * system libraries, call native functions, pass raw pointers, describe by-value
 * structs, or expose JavaScript callbacks to native code.
 *
 * Prefer a higher-level `fino:*` module when one exists. FFI signatures are not
 * checked against native headers, and mistakes in parameter types, return
 * types, pointer lifetimes, struct layout, callback lifetimes, or ownership
 * rules can corrupt memory or crash the process.
 *
 * Native functions use the platform C calling convention. Buffers passed to
 * native code must stay alive until native code has finished reading or writing
 * them, and memory returned by native libraries must be released with the
 * matching native API.
 *
 * ```ts no_run
 * import { dlopen } from 'fino:ffi';
 *
 * const libc = dlopen(null, {
 *   getpid: { parameters: [], result: 'i32' },
 * });
 *
 * console.log(libc.symbols.getpid());
 * ```
 */
declare module 'fino:ffi' {
  /**
   * String descriptor for a scalar or pointer-shaped C ABI type.
   *
   * Integer descriptors use the matching C width. `usize` and `isize` marshal
   * results as JavaScript `number`; use `usizeBig` or `isizeBig` when the full
   * pointer-sized range must round-trip as `bigint`.
   *
   * `pointer` represents an opaque `void*` and crosses JS as `NativePointer`.
   * `buffer` passes an `ArrayBuffer` or typed-array backing-store address as a
   * `void*` parameter. `ignoredPointer` is for callbacks that receive a pointer
   * parameter but intentionally do not materialize it in JavaScript.
   */
  export type NativeTypeName =
    | 'void'
    | 'bool'
    | 'u8'
    | 'i8'
    | 'u16'
    | 'i16'
    | 'u32'
    | 'i32'
    | 'u64'
    | 'i64'
    | 'usize'
    | 'isize'
    | 'usizeBig'
    | 'isizeBig'
    | 'f32'
    | 'f64'
    | 'pointer'
    | 'ignoredPointer'
    | 'buffer';
  /**
   * Native type descriptor accepted in parameter and result positions.
   *
   * `structType()` values may be used by `dlopen()` for by-value struct
   * parameters and return values. `FfiCallback` does not currently support
   * struct parameters or struct returns.
   */
  export type NativeTypeDescriptor = NativeTypeName | StructType;
  /**
   * Native function signature metadata passed to `dlopen()`.
   *
   * A symbol descriptor maps the JavaScript call boundary to the native ABI.
   * `parameters` defaults to an empty list only when an empty array is supplied;
   * each entry must be a native type descriptor. `result` describes the return
   * type and should be `'void'` for functions that do not return a value.
   */
  export interface NativeSymbolSpec {
    /**
     * Positional native parameter descriptors in C call order.
     */
    parameters?: readonly NativeTypeDescriptor[];
    /**
     * Native return descriptor.
     */
    result?: NativeTypeDescriptor;
    /**
     * Legacy compatibility flag. Use `async` for new bindings.
     */
    nonblocking?: boolean;
    /**
     * Run the call on Fino's native blocking pool and return a `Promise`.
     *
     * Use this for long-running calls or functions that may block on I/O. Do
     * not pass pointers to short-lived stack-like JS buffers unless those
     * buffers are retained until the promise settles.
     */
    async?: boolean;
    /**
     * Enable V8 Fast API dispatch when the signature supports it.
     *
     * Defaults to `true`. Set this to `false` for native functions that may
     * synchronously call back into JavaScript through an `FfiCallback`, because
     * those calls need the normal V8 handle-scope path.
     */
    fast?: boolean;
    /**
     * Number of fixed parameters before variadic arguments.
     *
     * Variadic C functions require a variadic libffi call interface on some
     * platforms. For example, `fcntl(fd, cmd, ...)` has two fixed parameters.
     */
    variadic?: number;
  }
  /**
   * Map of C symbol names to native call signatures.
   */
  export type NativeSymbolMap = Record<string, NativeSymbolSpec>;
  /**
   * Callable JavaScript wrappers for symbols loaded from a dynamic library.
   *
   * The runtime validates and marshals arguments according to the symbol's
   * descriptor on each call. Synchronous symbols return their native result
   * directly; symbols marked `async: true` return a `Promise`.
   */
  export type NativeBindings<TSymbols extends NativeSymbolMap> = {
    [K in keyof TSymbols]: (...args: any[]) => any;
  };
  /**
   * Raw native code pointers for symbols loaded from a dynamic library.
   *
   * These pointers are useful when a C API needs another function pointer, but
   * they should not be called or dereferenced manually.
   */
  export type NativeSymbolPointers<TSymbols extends NativeSymbolMap> = {
    [K in keyof TSymbols]: ArrayBuffer;
  };
  /**
   * Handle returned by `dlopen()`.
   *
   * The handle keeps the native library open for as long as any bound function
   * may be called. `symbols` contains callable wrappers, while `pointers`
   * contains raw pointer-sized buffers for the resolved symbol addresses.
   */
  export interface DynamicLibrary<TSymbols extends NativeSymbolMap = NativeSymbolMap> {
    /**
     * Bound native symbols keyed by their C symbol name.
     */
    symbols: NativeBindings<TSymbols>;
    /**
     * Raw symbol addresses keyed by their C symbol name.
     */
    pointers: NativeSymbolPointers<TSymbols>;
    /**
     * Unload the library. Calling any bound symbol afterwards is undefined
     * behaviour, so only close a library once nothing can call into it.
     */
    close(): void;
  }
  /**
   * A native pointer value: an 8-byte `ArrayBuffer` holding the address as a
   * little-endian `u64`, or `null` for the C null pointer.
   *
   * `ArrayBufferView` values may be passed where a pointer to the view's first
   * byte is required. The view's `byteOffset` is included in the address.
   */
  export type NativePointer = ArrayBuffer | ArrayBufferView | null;
  /**
   * Metadata for one field in a `StructType`.
   */
  export interface StructFieldInfo {
    /**
     * Field name used by `get()`, `set()`, and `offsetOf()`.
     */
    name: string;
    /**
     * Byte offset from the start of the struct.
     */
    offset: number;
    /**
     * Field width in bytes.
     */
    size: number;
  }
  /**
   * By-value C struct descriptor returned by `structType()`.
   *
   * Struct values are represented as `ArrayBuffer`s containing the native byte
   * layout. The descriptor can allocate a correctly sized buffer, read and
   * write fields, report offsets, and be used as a `dlopen()` parameter or
   * result descriptor.
   */
  export interface StructType {
    /**
     * Total struct size in bytes, including trailing padding.
     */
    readonly size: number;
    /**
     * Struct alignment in bytes.
     */
    readonly align: number;
    /**
     * Field metadata in declaration order.
     */
    readonly fields: readonly StructFieldInfo[];
    /**
     * Allocate a zero-filled `ArrayBuffer` with this struct's size.
     */
    alloc(): ArrayBuffer;
    /**
     * Read a field value from a struct buffer.
     *
     * Nested struct fields are returned as copied `ArrayBuffer`s. Pointer
     * fields are returned as `NativePointer` values.
     */
    get(buffer: ArrayBuffer | ArrayBufferView, field: string): unknown;
    /**
     * Write a field value into a struct buffer.
     *
     * The buffer must be large enough to contain the target field at its native
     * offset. Nested struct fields accept a buffer with the nested layout.
     */
    set(buffer: ArrayBuffer | ArrayBufferView, field: string, value: unknown): void;
    /**
     * Return the byte offset of a named field.
     */
    offsetOf(field: string): number;
  }
  /**
   * Object-form field descriptor accepted by `structType()`.
   */
  export interface StructFieldDescriptor {
    /**
     * Field name.
     */
    name: string;
    /**
     * Field type, another `StructType`, or `'bytes'` for explicit padding.
     */
    type: NativeTypeDescriptor | 'bytes';
    /**
     * Explicit byte offset. When omitted, the field is naturally aligned after
     * the previous field.
     */
    offset?: number;
    /**
     * Padding byte count when `type` is `'bytes'`.
     */
    size?: number;
  }
  /**
   * Tuple-form field descriptor accepted by `structType()`.
   */
  export type StructFieldTuple = readonly [name: string, type: NativeTypeDescriptor];
  /**
   * Field descriptor accepted by `structType()`.
   */
  export type StructField = StructFieldTuple | StructFieldDescriptor;
  /**
   * Callback object returned by `new FfiCallback()`.
   */
  export interface FfiCallbackHandle {
    /**
     * Native function pointer to pass to C APIs.
     */
    readonly pointer: ArrayBuffer;
    /**
     * Release the native callback trampoline.
     *
     * The method is idempotent. Do not close the callback while native code may
     * still call `pointer`.
     */
    close(): void;
    /**
     * Dispose hook used by `using` declarations.
     */
    [Symbol.dispose](): void;
  }
  /**
   * Pointer and raw-memory helper API exposed as `Pointer`.
   *
   * Pointer helpers dereference raw addresses. They do not validate that the
   * address is allocated, correctly aligned, or large enough for the requested
   * access.
   */
  export interface PointerApi {
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
    /**
     * Read an unsigned 8-bit integer at `ptr + offset`.
     */
    readU8(ptr: NativePointer, offset?: number): number;
    /**
     * Read a signed 8-bit integer at `ptr + offset`.
     */
    readI8(ptr: NativePointer, offset?: number): number;
    /**
     * Read an unsigned 16-bit little-endian integer at `ptr + offset`.
     */
    readU16(ptr: NativePointer, offset?: number): number;
    /**
     * Read a signed 16-bit little-endian integer at `ptr + offset`.
     */
    readI16(ptr: NativePointer, offset?: number): number;
    /**
     * Read an unsigned 32-bit little-endian integer at `ptr + offset`.
     */
    readU32(ptr: NativePointer, offset?: number): number;
    /**
     * Read a signed 32-bit little-endian integer at `ptr + offset`.
     */
    readI32(ptr: NativePointer, offset?: number): number;
    /**
     * Read an unsigned 64-bit little-endian integer at `ptr + offset`.
     */
    readU64(ptr: NativePointer, offset?: number): bigint;
    /**
     * Read a signed 64-bit little-endian integer at `ptr + offset`.
     */
    readI64(ptr: NativePointer, offset?: number): bigint;
    /**
     * Read a 32-bit little-endian float at `ptr + offset`.
     */
    readF32(ptr: NativePointer, offset?: number): number;
    /**
     * Read a 64-bit little-endian float at `ptr + offset`.
     */
    readF64(ptr: NativePointer, offset?: number): number;
    /**
     * Dereference a pointer-sized field at `ptr + offset`.
     */
    readPointer(ptr: NativePointer, offset?: number): NativePointer;
    /**
     * Write an unsigned 8-bit integer at `ptr + offset`.
     */
    writeU8(ptr: NativePointer, offset: number, value: number | bigint): void;
    /**
     * Write a signed 8-bit integer at `ptr + offset`.
     */
    writeI8(ptr: NativePointer, offset: number, value: number | bigint): void;
    /**
     * Write an unsigned 16-bit little-endian integer at `ptr + offset`.
     */
    writeU16(ptr: NativePointer, offset: number, value: number | bigint): void;
    /**
     * Write a signed 16-bit little-endian integer at `ptr + offset`.
     */
    writeI16(ptr: NativePointer, offset: number, value: number | bigint): void;
    /**
     * Write an unsigned 32-bit little-endian integer at `ptr + offset`.
     */
    writeU32(ptr: NativePointer, offset: number, value: number | bigint): void;
    /**
     * Write a signed 32-bit little-endian integer at `ptr + offset`.
     */
    writeI32(ptr: NativePointer, offset: number, value: number | bigint): void;
    /**
     * Write an unsigned 64-bit little-endian integer at `ptr + offset`.
     */
    writeU64(ptr: NativePointer, offset: number, value: number | bigint): void;
    /**
     * Write a signed 64-bit little-endian integer at `ptr + offset`.
     */
    writeI64(ptr: NativePointer, offset: number, value: number | bigint): void;
    /**
     * Write a 32-bit little-endian float at `ptr + offset`.
     */
    writeF32(ptr: NativePointer, offset: number, value: number): void;
    /**
     * Write a 64-bit little-endian float at `ptr + offset`.
     */
    writeF64(ptr: NativePointer, offset: number, value: number): void;
    /**
     * Write a pointer-sized address at `ptr + offset`.
     */
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
  }
  /**
   * Namespace of pointer and raw-memory helpers.
   */
  export const Pointer: PointerApi;
  /**
   * Native callback constructor.
   *
   * Constructed callbacks expose a native function pointer and must be retained
   * for as long as native code may call them. The callback may be closed
   * explicitly or with a `using` declaration.
   *
   * ```ts no_run
   * import { FfiCallback } from 'fino:ffi';
   *
   * using cmp = new FfiCallback(
   *   { parameters: ['pointer', 'pointer'], result: 'i32' },
   *   (left, right) => 0,
   * );
   *
   * nativeApi.symbols.registerComparator(cmp.pointer);
   * ```
   */
  export const FfiCallback: {
    new (
      spec: Pick<NativeSymbolSpec, 'parameters' | 'result'>,
      callback: (...args: any[]) => unknown,
    ): FfiCallbackHandle;
  };
  /**
   * Build a by-value struct descriptor from field layout metadata.
   *
   * Fields may be declared as `[name, type]` tuples or as objects with
   * explicit `offset` and `size` metadata. Normal fields are naturally aligned
   * by default. Object fields with `type: 'bytes'` add explicit padding and
   * require `size`.
   *
   * ```ts no_run
   * import { structType } from 'fino:ffi';
   *
   * const Point = structType([
   *   ['x', 'i32'],
   *   ['y', 'i32'],
   * ]);
   *
   * const point = Point.alloc();
   * Point.set(point, 'x', 12);
   * Point.set(point, 'y', -3);
   * ```
   */
  export function structType(
    fields: readonly StructField[],
    options?: { size?: number; align?: number },
  ): StructType;
  /**
   * Open a dynamic library and bind the requested symbols.
   *
   * `path` may be `null` to resolve symbols from the current process. The
   * returned handle exposes callable wrappers in `symbols` and raw symbol
   * addresses in `pointers`.
   *
   * ```ts no_run
   * import { dlopen } from 'fino:ffi';
   *
   * const libc = dlopen('/usr/lib/libSystem.B.dylib', {
   *   strlen: { parameters: ['buffer'], result: 'usize' },
   * });
   *
   * const input = new TextEncoder().encode('hello\0');
   * console.log(libc.symbols.strlen(input));
   * ```
   */
  export function dlopen<TSymbols extends NativeSymbolMap = NativeSymbolMap>(
    path: string | null,
    symbols: TSymbols,
  ): DynamicLibrary<TSymbols>;

  /**
   * Bind a function pointer obtained at runtime.
   *
   * `dlopen()` can only reach symbols by name. Function pointers handed back by
   * native code have no name to look up: `vkGetInstanceProcAddr` results,
   * callback fields read out of a C struct, and `FfiCallback.pointer` all need
   * this instead.
   *
   * `pointer` accepts a pointer buffer, an `ArrayBufferView` over one, or a
   * `BigInt` address. The definition is the same shape `dlopen()` takes for a
   * single symbol, including `async`, `fast`, and `variadic`.
   *
   * The returned function keeps nothing alive. Whatever provides the code — a
   * `DynamicLibrary` handle, an `FfiCallback` — must be retained for as long as
   * the function may be called, or the call will jump into freed memory.
   *
   * ```ts no_run
   * import { dlopen, ffiFunction } from 'fino:ffi';
   *
   * const libc = dlopen('/usr/lib/libSystem.B.dylib', {
   *   strlen: { parameters: ['buffer'], result: 'usize' },
   * });
   *
   * const strlen = ffiFunction(libc.pointers.strlen, {
   *   parameters: ['buffer'],
   *   result: 'usizeBig',
   * });
   *
   * console.log(strlen(new TextEncoder().encode('hello\0')));
   * ```
   */
  export function ffiFunction(
    pointer: NativePointer | bigint,
    definition: NativeSymbolSpec,
  ): (...args: any[]) => any;
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
 * internal:process-profiler — process-wide Realm CPU profile coordination.
 *
 * @internal
 */
declare module 'internal:process-profiler' {
  /** Begin a process profile and register the calling Realm. */
  export function beginProcessProfiling(): void;
  /** Register the calling Realm when a process profile is active. */
  export function registerRealmProfiling(): void;
  /** Finalize the calling Realm and encode the completed process profile. */
  export function finishProcessProfiling(): Uint8Array;
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
  export function lookupOriginalPosition(
    source: string,
    line: number,
    column: number,
  ): OriginalPosition | null;
  /**
   * Register the JavaScript resolver used by the Rust loader.
   */
  export function registerResolve(
    fn: (specifier: string, referrerDir: string | null, root: string) => string,
  ): void;
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
  export function registerTranspile(
    fn: (path: string, source: string) => { code: string; map?: string },
  ): void;
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
  export function wait(
    raw: object,
    timeout: number,
  ): Array<{ ident: number; filter: number; flags: number; fflags?: number; res?: number }>;
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
    ):
      | { async: false; value: 'ok' | 'not-equal' | 'timed-out' }
      | { async: true; value: Promise<'ok' | 'timed-out'> };
  }
}
