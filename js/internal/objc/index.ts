/**
 * Synchronous Apple arm64 Objective-C runtime primitives over `fino:ffi`.
 *
 * Importing is portable; native operations require {@link available}. Frameworks
 * load their own libraries and own their object references. Handles and bound
 * functions belong to the importing Realm and must not cross Realm boundaries.
 * No finalizer releases objects: owners explicitly balance retain/release.
 *
 * Message signatures must match the native method exactly. This is an unsafe
 * FFI boundary, not an Objective-C exception bridge. Bind only short synchronous
 * methods here; asynchronous work requires a separate ownership contract.
 *
 * References:
 * - [Apple messaging ABI](https://github.com/apple-oss-distributions/objc4/blob/main/runtime/message.h)
 * - [Autorelease pool scopes](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/MemoryMgmt/Articles/mmAutoreleasePools.html)
 *
 * @internal
 */
import { dlopen, ffiFunction } from 'fino:ffi';
import type { NativeSymbolSpec } from 'fino:ffi';
import { os, arch } from 'fino:process';

/** Borrowed native object or class address; the buffer does not own the object. */
export type ObjectHandle = ArrayBuffer;
/** Runtime-interned selector address. */
export type Selector = ArrayBuffer;

function openRuntime() {
  return dlopen('/usr/lib/libobjc.A.dylib', {
    objc_getClass: { parameters: ['buffer'], result: 'pointer' },
    sel_registerName: { parameters: ['buffer'], result: 'pointer' },
    objc_retain: { parameters: ['pointer'], result: 'pointer' },
    objc_release: { parameters: ['pointer'], result: 'void' },
    objc_autoreleasePoolPush: { parameters: [], result: 'pointer' },
    objc_autoreleasePoolPop: { parameters: ['pointer'], result: 'void' },
    // Only the address is used. Each caller binds its concrete method signature.
    objc_msgSend: { parameters: [], result: 'void' },
  });
}

// Keep the library alive for every ffiFunction binding in this Realm.
let library: ReturnType<typeof openRuntime> | undefined;
let failure: string | undefined;

/** Probe lazily; unsupported architectures never attempt to bind native code. */
export function available(): boolean {
  if (os !== 'darwin' || arch !== 'aarch64') return false;
  if (!library && failure === undefined) {
    try {
      library = openRuntime();
    } catch (error) {
      failure = String(error);
    }
  }
  return library !== undefined;
}

function runtime() {
  if (!available())
    throw new Error(`Objective-C runtime unavailable: ${failure ?? `${os}/${arch}`}`);
  return library!;
}

function nameBytes(name: string): Uint8Array {
  if (name.includes('\0')) throw new TypeError('Objective-C names must not contain NUL');
  return new TextEncoder().encode(name + '\0');
}

/** Look up an already-loaded class; missing classes return null and are not cached. */
export function getClass(name: string): ObjectHandle | null {
  const bytes = nameBytes(name);
  return runtime().symbols.objc_getClass(bytes);
}

const selectors = new Map<string, Selector>();
/** Register a method name and reuse its selector within this Realm. */
export function selector(name: string): Selector {
  const bytes = nameBytes(name);
  let value = selectors.get(name);
  if (!value) {
    value = runtime().symbols.sel_registerName(bytes) as Selector;
    selectors.set(name, value);
  }
  return value;
}

/**
 * Bind one concrete method ABI. Parameters exclude the receiver and selector;
 * the returned FFI function accepts `(receiver, selector, ...arguments)`.
 *
 * Bind once outside hot loops. Existing FFI Fast API dispatch remains enabled
 * by default; set `fast: false` for methods that can call back into JavaScript.
 * Apple arm64 uses objc_msgSend for scalar and aggregate results alike.
 */
export function bindMessage(spec: Pick<NativeSymbolSpec, 'parameters' | 'result' | 'fast'>) {
  if ('async' in spec || 'nonblocking' in spec || 'variadic' in spec) {
    throw new TypeError('Objective-C messages require a synchronous concrete signature');
  }
  return ffiFunction(runtime().pointers.objc_msgSend, {
    parameters: ['pointer', 'pointer', ...(spec.parameters ?? [])],
    result: spec.result ?? 'void',
    fast: spec.fast,
  });
}

/** Acquire an object reference that must later be balanced with {@link release}. */
export function retain(object: ObjectHandle): ObjectHandle {
  return runtime().symbols.objc_retain(object);
}

/** Release one owned reference. Releasing twice is invalid, just as in native code. */
export function release(object: ObjectHandle): void {
  runtime().symbols.objc_release(object);
}

/**
 * Drain autoreleased objects on return or throw, on the same thread as entry.
 * The callback must finish synchronously and must not schedule work using borrowed
 * objects. Retain any object that escapes the scope. Returning a thenable is an
 * error; this check cannot cancel work a callback has already scheduled.
 */
export function withAutoreleasePool<T>(callback: () => T): T {
  const api = runtime().symbols;
  const pool = api.objc_autoreleasePoolPush();
  try {
    const result = callback();
    if (
      result != null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      throw new TypeError('Objective-C autorelease pool callbacks must be synchronous');
    }
    return result;
  } finally {
    api.objc_autoreleasePoolPop(pool);
  }
}
