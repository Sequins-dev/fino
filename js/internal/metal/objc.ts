/**
 * Objective-C runtime binding.
 *
 * Metal has no C API, but the Objective-C *runtime* does: `libobjc.A.dylib`
 * exports `objc_getClass`, `sel_registerName`, and `objc_msgSend`, all plain C.
 * Binding those is how metal-rs and Julia reach Metal without writing
 * Objective-C, and it is how this module reaches it without a compiled shim.
 *
 * `objc_msgSend` is variadic in its declaration but not in its ABI: each call
 * site must use the concrete signature of the selector being sent. So rather than
 * declaring it variadic — which would misplace arguments on arm64 — the same
 * symbol is bound once per signature shape, which is an established pattern in
 * this codebase (`tests/ffi.test.ts` does it for `strlen`).
 *
 * arm64 only. On x86-64, struct-returning messages need the `objc_msgSend_stret`
 * variant, which this module does not bind; Apple Silicon is the target.
 *
 * @internal
 *
 * This module is re-exported through `internal:metal`; import from there.
 */
import { Pointer, dlopen, structType } from 'fino:ffi';

/** An Objective-C object pointer. */
export type Id = ArrayBuffer;

/** A selector. */
export type Sel = ArrayBuffer;

/** Path to the Objective-C runtime. */
const LIBOBJC = '/usr/lib/libobjc.A.dylib';

/** `MTLSize`, three unsigned 64-bit lengths, passed by value. */
export const MTLSize = structType([
  ['width', 'u64'],
  ['height', 'u64'],
  ['depth', 'u64'],
]);

/** Runtime entry points, loaded on first use. */
type Runtime = ReturnType<typeof openRuntime>;

/**
 * @internal
 */
function openRuntime() {
  return dlopen(LIBOBJC, {
    objc_getClass: { parameters: ['buffer'], result: 'pointer' },
    sel_registerName: { parameters: ['buffer'], result: 'pointer' },
    objc_autoreleasePoolPush: { parameters: [], result: 'pointer' },
    objc_autoreleasePoolPop: { parameters: ['pointer'], result: 'void' },
    objc_retain: { parameters: ['pointer'], result: 'pointer' },
    objc_release: { parameters: ['pointer'], result: 'void' },
  });
}

/**
 * Memoized runtime handle, or an error if loading failed.
 *
 * Importing this module must not throw on a platform without an Objective-C
 * runtime; callers check {@link objcAvailable} instead.
 *
 * @internal
 */
let runtimeState: { lib: Runtime } | { error: string } | null = null;

/**
 * @internal
 */
function runtimeOrNull(): Runtime | null {
  if (runtimeState === null) {
    try {
      runtimeState = { lib: openRuntime() };
    } catch (cause) {
      runtimeState = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return 'lib' in runtimeState ? runtimeState.lib : null;
}

/** Whether the Objective-C runtime is available on this platform. */
export function objcAvailable(): boolean {
  return runtimeOrNull() !== null;
}

/**
 * The runtime, or a thrown error naming why it is unavailable.
 *
 * @internal
 */
function runtime(): Runtime {
  const lib = runtimeOrNull();
  if (!lib) {
    const reason = runtimeState && 'error' in runtimeState ? runtimeState.error : 'unknown';
    throw new Error(`the Objective-C runtime is unavailable: ${reason}`);
  }
  return lib;
}

/**
 * Bind `objc_msgSend` with one concrete signature.
 *
 * Every variant takes `self` and a selector first; `parameters` describes only
 * what follows.
 *
 * @internal
 */
function msgSend(
  parameters: readonly unknown[],
  result: string,
  options: { async?: boolean } = {},
): (...args: never[]) => unknown {
  // Bound lazily and memoized, so a platform without the runtime can still
  // import this module.
  let bound: ((...args: never[]) => unknown) | null = null;
  return (...args: never[]) => {
    if (!bound) {
      runtime();
      const lib = dlopen(LIBOBJC, {
        objc_msgSend: {
          parameters: ['pointer', 'pointer', ...parameters] as never,
          result: result as never,
          ...(options.async ? { async: true } : {}),
        },
      });
      bound = lib.symbols.objc_msgSend as (...a: never[]) => unknown;
    }
    return bound(...args);
  };
}

/**
 * Message-send variants, one per signature the Metal binding needs.
 *
 * Grouped by shape rather than by selector, since one shape serves many
 * selectors. Names read `<result><params>`.
 */
export const send = {
  /** `- (id)selector` */
  ptr: msgSend([], 'pointer'),
  /** `- (void)selector` */
  void: msgSend([], 'void'),
  /** `- (uint64_t)selector` */
  u64: msgSend([], 'u64'),
  /** `- (BOOL)selector` */
  bool: msgSend([], 'bool'),
  /** `- (BOOL)selector:(int64_t)` */
  boolI64: msgSend(['i64'], 'bool'),
  /** `- (id)selector:(id)` */
  ptrPtr: msgSend(['pointer'], 'pointer'),
  /** `- (id)selector:(const char *)` */
  ptrBuf: msgSend(['buffer'], 'pointer'),
  /** `- (id)selector:(uint64_t) options:(uint64_t)` */
  ptrU64U64: msgSend(['u64', 'u64'], 'pointer'),
  /** `- (id)selector:(const void *) length:(uint64_t) options:(uint64_t)` */
  ptrBufU64U64: msgSend(['buffer', 'u64', 'u64'], 'pointer'),
  /** `- (id)selector:(id) options:(id) error:(NSError **)` */
  ptrPtrPtrBuf: msgSend(['pointer', 'pointer', 'buffer'], 'pointer'),
  /** The same, compiled on the blocking pool. */
  ptrPtrPtrBufAsync: msgSend(['pointer', 'pointer', 'buffer'], 'pointer', { async: true }),
  /** `- (id)selector:(id) error:(NSError **)` */
  ptrPtrBuf: msgSend(['pointer', 'buffer'], 'pointer'),
  /** `- (void)selector:(id)` */
  voidPtr: msgSend(['pointer'], 'void'),
  /** `- (void)selector:(id) offset:(uint64_t) atIndex:(uint64_t)` */
  voidPtrU64U64: msgSend(['pointer', 'u64', 'u64'], 'void'),
  /** `- (void)selector:(const void *) length:(uint64_t) atIndex:(uint64_t)` */
  voidBufU64U64: msgSend(['buffer', 'u64', 'u64'], 'void'),
  /** `- (void)selector:(MTLSize) threadsPerThreadgroup:(MTLSize)` */
  voidSizeSize: msgSend([MTLSize, MTLSize], 'void'),
  /** `- (void)selector:(id) value:(uint64_t)` */
  voidPtrU64: msgSend(['pointer', 'u64'], 'void'),
  /** `- (void)selector:(uint64_t)` */
  voidU64: msgSend(['u64'], 'void'),
  /** `- (uint64_t)selector:(uint64_t)` */
  u64U64: msgSend(['u64'], 'u64'),
  /**
   * `- (MTLSize)selector`
   *
   * A 24-byte aggregate, so arm64 returns it indirectly. Declaring such a
   * selector as returning `u64` is an ABI mismatch that crashes rather than
   * returning a wrong number, which is why every selector's real return type has
   * to be checked against the headers.
   */
  sizeRet: msgSend([], MTLSize),
  /** `- (BOOL)waitUntilSignaledValue:(uint64_t) timeoutMS:(uint64_t)`, on the pool. */
  boolU64U64Async: msgSend(['u64', 'u64'], 'bool', { async: true }),
  /** `+ (id)numberWithLongLong:(long long)` */
  ptrI64: msgSend(['i64'], 'pointer'),
  /** `- (void)selector:(long long)` */
  voidI64: msgSend(['i64'], 'void'),
  /** `+ (id)arrayWithObjects:(const id *) count:(NSUInteger)` */
  ptrBufU64: msgSend(['buffer', 'u64'], 'pointer'),
  /** `+ (id)dictionaryWithObjects:(const id *) forKeys:(const id *) count:(NSUInteger)` */
  ptrBufBufU64: msgSend(['buffer', 'buffer', 'u64'], 'pointer'),
  /** `- (id)initWithShape:(NSArray *) dataType:(NSInteger) error:(NSError **)` */
  ptrPtrI64Buf: msgSend(['pointer', 'i64', 'buffer'], 'pointer'),
} as const;

/**
 * Selector cache.
 *
 * @internal
 */
const selectors = new Map<string, Sel>();

/** Register a selector, caching it. */
export function sel(name: string): Sel {
  const existing = selectors.get(name);
  if (existing) return existing;
  const registered = runtime().symbols.sel_registerName(cstring(name)) as Sel | null;
  if (!registered) throw new Error(`could not register Objective-C selector '${name}'`);
  selectors.set(name, registered);
  return registered;
}

/**
 * Class cache.
 *
 * @internal
 */
const classes = new Map<string, Id>();

/** Look up an Objective-C class, caching it. Returns null when absent. */
export function objcClass(name: string): Id | null {
  const existing = classes.get(name);
  if (existing) return existing;
  const found = runtime().symbols.objc_getClass(cstring(name)) as Id | null;
  if (!found) return null;
  classes.set(name, found);
  return found;
}

/** NUL-terminated UTF-8 bytes, for the C string parameters above. */
export function cstring(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  return out;
}

/** Retain an object so it survives past the enclosing autorelease pool. */
export function retain(object: Id): Id {
  return runtime().symbols.objc_retain(object) as Id;
}

/** Release a retained object. */
export function release(object: Id): void {
  runtime().symbols.objc_release(object);
}

/**
 * Run `fn` inside an autorelease pool.
 *
 * Metal returns autoreleased objects from `commandBuffer` and
 * `computeCommandEncoder`. Without a pool they accumulate on the thread's
 * implicit page and are never freed, which looks exactly like a leak because it
 * is one. Anything that must outlive the pool has to be explicitly retained.
 */
export function withPool<T>(fn: () => T): T {
  const pool = runtime().symbols.objc_autoreleasePoolPush() as ArrayBuffer;
  try {
    return fn();
  } finally {
    runtime().symbols.objc_autoreleasePoolPop(pool);
  }
}

/** Open an autorelease pool, to be closed by {@link popPool}. */
export function pushPool(): ArrayBuffer {
  return runtime().symbols.objc_autoreleasePoolPush() as ArrayBuffer;
}

/** Close a pool opened by {@link pushPool}. */
export function popPool(pool: ArrayBuffer): void {
  runtime().symbols.objc_autoreleasePoolPop(pool);
}

/** An `NSString` from a JS string. */
export function nsString(text: string): Id {
  const cls = objcClass('NSString');
  if (!cls) throw new Error('NSString is unavailable; is this an Apple platform?');
  const result = send.ptrBuf(cls, sel('stringWithUTF8String:'), cstring(text)) as Id | null;
  if (!result) throw new Error('could not create an NSString');
  return result;
}

/** NSUTF8StringEncoding. */
const NS_UTF8 = 4n;

/** Read an `NSString` back as a JS string. */
export function readNSString(value: Id): string {
  const length = send.u64U64(value, sel('lengthOfBytesUsingEncoding:'), NS_UTF8) as bigint;
  const utf8 = send.ptr(value, sel('UTF8String')) as ArrayBuffer | null;
  if (!utf8 || length === 0n) return '';
  const bytes = Pointer.copyFrom(utf8, Number(length));
  return new TextDecoder().decode(bytes);
}

/**
 * An out-parameter slot for an `NSError **`.
 *
 * Metal reports compilation and pipeline failures this way rather than by
 * returning null with a status code.
 */
export function errorSlot(): Uint8Array {
  return new Uint8Array(8);
}

/** Read an `NSError` out of a slot, or null when the call succeeded. */
export function takeError(slot: Uint8Array): string | null {
  const view = new DataView(slot.buffer, slot.byteOffset, 8);
  const address = view.getBigUint64(0, true);
  if (address === 0n) return null;
  const error = slot.slice() as unknown as Id;
  const description = send.ptr(error, sel('localizedDescription')) as Id | null;
  return description ? readNSString(description) : 'unknown Objective-C error';
}

// -- Foundation collections ---------------------------------------------------
//
// CoreML takes its shapes as `NSArray<NSNumber *>` and its inputs as an
// `NSDictionary`, so reaching it needs the collection classes that Metal never
// did. They are built here rather than in a CoreML module because they are
// Foundation, not CoreML, and the next framework this engine reaches for will
// want them too.

/**
 * An `NSNumber` holding an integer.
 *
 * Autoreleased, so it lives until the enclosing pool is popped — which is what
 * {@link withPool} is for.
 */
export function nsNumber(value: number): Id {
  const cls = objcClass('NSNumber');
  if (!cls) throw new Error('NSNumber is unavailable');
  return send.ptrI64(cls, sel('numberWithLongLong:'), BigInt(value));
}

/** The pointer value an object handle wraps, for packing into a C array. */
function addressOf(object: Id): bigint {
  return new DataView(object as ArrayBuffer).getBigUint64(0, true);
}

/** An `NSArray` over the given objects. */
export function nsArray(items: readonly Id[]): Id {
  const cls = objcClass('NSArray');
  if (!cls) throw new Error('NSArray is unavailable');
  const packed = new BigUint64Array(items.map(addressOf));
  return send.ptrBufU64(
    cls,
    sel('arrayWithObjects:count:'),
    new Uint8Array(packed.buffer),
    BigInt(items.length),
  );
}

/** An `NSDictionary` pairing keys with values, positionally. */
export function nsDictionary(keys: readonly Id[], values: readonly Id[]): Id {
  if (keys.length !== values.length) {
    throw new Error(`nsDictionary needs matching keys and values, got ${keys.length} and ${values.length}`);
  }
  const cls = objcClass('NSDictionary');
  if (!cls) throw new Error('NSDictionary is unavailable');
  const keyWords = new BigUint64Array(keys.map(addressOf));
  const valueWords = new BigUint64Array(values.map(addressOf));
  return send.ptrBufBufU64(
    cls,
    sel('dictionaryWithObjects:forKeys:count:'),
    new Uint8Array(valueWords.buffer),
    new Uint8Array(keyWords.buffer),
    BigInt(keys.length),
  );
}
