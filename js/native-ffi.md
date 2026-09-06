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

`FfiCallback` creates native-callable JS callbacks. Retain the callback object
for as long as native code may call it; dropping it while native code still has
the function pointer is unsafe.

Mark long-running symbols `async` or `nonblocking` so they run on the native
blocking pool instead of stalling the JS event loop. Async symbols accept
pointer, buffer, and by-value struct parameters; buffer backing stores stay
pinned until the promise settles, while raw pointers are passed as plain
addresses that the caller must keep valid. A `buffer` result is rejected.

`ffiFunction()` binds a code pointer that has no symbol name to look up, such as
a pointer returned by another native call or read out of a struct field. It takes
the same definition as a single `dlopen` symbol and keeps nothing alive, so the
library or callback providing the code must be retained separately.

The full `fino:ffi` surface — types, struct layout, callbacks, and pointer
helpers — is documented in the generated API reference.
