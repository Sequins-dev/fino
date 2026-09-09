---
weight: 60
---
# Native FFI

`fino:ffi` loads native libraries and binds C ABI functions. It is a sharp
runtime extension surface for advanced applications and built-in modules that
need system calls, native codecs, crypto libraries, database clients, or
platform APIs before a higher-level `fino:*` wrapper exists.

Prefer public Fino modules when they cover the job. A wrong FFI signature,
pointer lifetime, callback lifetime, struct layout, or ownership assumption can
crash the process.

## Load Symbols

```ts no_run
import { dlopen } from 'fino:ffi';

const libc = dlopen(null, {
  getpid: { parameters: [], result: 'i32' },
});

console.log(libc.symbols.getpid());
```

`path` may be `null` to resolve symbols from the current process. The symbol map
declares parameter and result descriptors used by the native binding layer.

## Bind Function Pointers

Use `ffiFunction(pointer, definition)` for addresses returned by native APIs or
stored in C structures. It accepts a pointer buffer, a view over that buffer,
or a BigInt address, using the same signature options as `dlopen()`.

```ts no_run
import { dlopen, ffiFunction } from 'fino:ffi';

const libc = dlopen(null, { getpid: { parameters: [], result: 'i32' } });
const getpid = ffiFunction(libc.pointers.getpid, { parameters: [], result: 'i32' });
console.log(getpid());
libc.close();
```

A bound pointer does not retain its library or callback owner. Keep that owner
alive and open until every call, including asynchronous calls, has completed.
Use `fast: false` when the native function synchronously calls back into JS.
Null pointers and malformed signatures are rejected when binding; a non-null
address still needs to identify a live function with the declared ABI.

## Work With Pointers

`Pointer` helpers read, write, copy, offset, and view native memory:

```ts no_run
import { Pointer } from 'fino:ffi';

const bytes = new Uint8Array(8);
const ptr = Pointer.of(bytes);
Pointer.writeU32(ptr, 0, 42);
console.log(Pointer.readU32(ptr, 0));
```

Buffers passed to native code must remain alive for as long as native code may
read them. Native memory viewed through `Pointer.view()` must outlive the
returned buffer unless `onRelease` owns cleanup.

## Callbacks And Blocking Work

`FfiCallback` creates native-callable JS callbacks. Closing a callback revokes
JavaScript invocation. Acquire `callback.lease()` when native work needs to keep
its executable pointer alive independently: subsequent calls return zero after
revocation. Release the lease only after the native API acknowledges completion
and its last callback invocation has returned. Resolving a Promise inside the
handler does not establish that condition. Ordinary leases must finish before
the owning Realm shuts down.

On macOS, `callback.block()` creates an Objective-C block and supplies its
implicit block argument automatically. Apple APIs that copy the block own the
callback code until their final native release, even after Realm shutdown.
Closing the returned block releases your reference; closing the callback
revokes JavaScript invocation through every copy. The optional resource list
transfers owned native references to the block, each paired with a synchronous
C `void(void*)` destructor. These destructors must never call JavaScript.

Use `FfiResource` for an owned allocation or native object:

```ts no_run
using memory = new FfiResource(libc.symbols.malloc(64), libc.pointers.free);
Pointer.writeU8(memory.pointer, 0, 42);
```

Its destructor runs once on explicit disposal or Realm teardown. Keep the
library containing the destructor loaded until release. Ownership roots are
released explicitly or at teardown; garbage collection is not a cleanup signal.

Mark long-running symbols `async: true` so they run on the native
blocking pool instead of stalling the JS event loop.

The full `fino:ffi` surface — types, struct layout, callbacks, and pointer
helpers — is documented in the generated API reference.
