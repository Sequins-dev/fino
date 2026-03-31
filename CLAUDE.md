# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
cargo build
cargo build --release

# Run a script (JS or TypeScript)
cargo run -- script.mjs
cargo run -- script.ts
./target/debug/boats script.mjs

# Run all tests (zsh ** glob expands recursively)
cargo run -- --test tests/**/*.test.mts

# Run a single test file
cargo run -- --test tests/file/file.test.mts

# Run a subset of tests
cargo run -- --test tests/internal/globals/*.test.mts tests/net/*.test.mts

# Lint / format
cargo clippy
cargo fmt --check
cargo fmt
```

Tests emit TAP-13 output to stdout via libc `write()` (not captured by shell redirection). Use the exit code to determine pass/fail: `0` = all pass, `1` = failures.

## Architecture

Boats is a JS runtime built on the [Boa](https://github.com/boa-dev/boa) JS engine. The design philosophy is **thin Rust, everything else in JS**: the Rust layer provides only three things — a module loader, FFI bindings, and a couple of compile-time synthetic modules. All I/O, networking, and standard library are implemented in JS by calling libc directly via FFI.

### Rust layer (`src/`)

| File | Role |
|---|---|
| `main.rs` | Entry point — calls `runtime::run()` |
| `runtime.rs` | Loads `js/_main.mjs`, evaluates it, runs job queue |
| `loader.rs` | `BoatsModuleLoader` — resolves `boats:*` / `internal:*` builtins and filesystem imports |
| `ffi/` | `boats:ffi` synthetic module — `dlopen` + `Pointer` |
| `platform.rs` | `internal:process` synthetic module — `{ os, arch, args, env, execPath }` |
| `runtime_module.rs` | `boats:runtime` synthetic module — `drainMicrotasks()` |

**Only add Rust modules** when you need compile-time information (like `platform.rs`) or GC-safe object types that can't be expressed in JS. Standard library modules belong in JS.

### Module scopes

- `boats:*` — public built-in modules, importable by any code
- `internal:*` — restricted built-in modules, importable only by other built-in modules (those parsed from embedded bytes, not filesystem paths); enforced in `loader.rs`

### JS layer (`js/`)

All `.mts` files in `js/` are TypeScript source files that are stripped of type annotations at build time by `build.rs` (using OXC) and baked into the binary as plain JS via `include_str!()`. They are registered as `boats:*` module specifiers in `src/loader.rs`.

The build script writes stripped `.mjs` output to `OUT_DIR/js/`. All `include_str!()` macros in `loader.rs` and `runtime.rs` read from `OUT_DIR` — not directly from the source tree.

**To add a new built-in:**
1. Create `js/mymodule.mts`
2. Add `source_builtin!("boats:mymodule", "mymodule")` to the `BUILTINS` array in `src/loader.rs`
3. Import it as `import ... from 'boats:mymodule'`

### TypeScript support

User code: `.ts` and `.mts` files loaded from the filesystem are type-stripped at runtime by the loader (`src/loader.rs`, `strip_types()`) before Boa parses them.

Core builtins: `.mts` files in `js/` are type-stripped at build time by `build.rs`. Zero runtime cost.

Both paths use the same OXC pipeline: type-strip only, no downleveling, no JSX.

### Event loop model

The main loop lives in `js/_main.mts` and is a synchronous `while` loop:

```
while alive:
  drainMicrotasks()      ← flush Boa promise job queue
  tick(timeoutMs)        ← call __boatsTick__ (dispatches kqueue/io_uring events)
  check __boatsAlive__() ← exit when all loop handles are destroyed
```

`boats:loop` sets `globalThis.__boatsTick__` and `globalThis.__boatsAlive__`. When no `loop.create()` handle exists, those globals are absent and the main loop exits immediately after microtasks drain.

kqueue (macOS) and io_uring (Linux) backends are in `js/kqueue.mjs` and `js/io_uring.mjs`. `boats:loop` abstracts over both.

### FFI (`boats:ffi`)

```js
import { dlopen, Pointer } from 'boats:ffi';

const lib = dlopen('/usr/lib/libSystem.B.dylib', {
  read:  { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  write: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
});
lib.symbols.read(fd, buf, len);
```

**FFI types:** `u8 i8 u16 i16 u32 i32 u64 i64 usize isize f32 f64 bool void pointer buffer`

- `buffer` — pass an `ArrayBuffer` or typed array as a `void*`; FFI pins it against GC for the call duration
- `pointer` — opaque C pointer; returned as a JS object (or `null` for null pointers)
- `u64`/`i64` results come back as `BigInt`; wrap with `Number(...)` if the value fits

**Pointer namespace:**

```js
Pointer.readU8(ptr, offset)    // read byte at ptr+offset
Pointer.readU16(ptr, offset)
Pointer.readU32(ptr, offset)
Pointer.readU64(ptr, offset)   // returns BigInt
Pointer.readI32(ptr, offset)
Pointer.readI64(ptr, offset)   // returns BigInt
Pointer.readF64(ptr, offset)
Pointer.offset(ptr, bytes)     // pointer arithmetic
Pointer.of(arrayBuffer)        // get raw pointer to ArrayBuffer backing store
Pointer.toAddress(ptr)         // → BigInt
Pointer.fromAddress(bigint)    // → pointer
```

### Reader / Writer (`boats:stream`)

`Reader` and `Writer` wrap any fd with event-loop-backed non-blocking I/O using `read(2)` / `write(2)`. Works on sockets, pipes, and regular files.

```js
import { Reader, Writer } from 'boats:stream';
const reader = new Reader(fd, lp, onClose);
const writer = new Writer(fd, lp, onClose);
```

- `Reader` implements `[Symbol.asyncIterator]` and can be passed to `parseRequest()` / `parseResponse()`
- `Writer.pipe(asyncIterable)` consumes any async iterable (e.g. `serializeResponse(res)`)
- `onClose` callback is invoked when `.close()` is called on that half

### Filesystem (`boats:file`)

```js
import { DiskFileSystem } from 'boats:file';
const fs = new DiskFileSystem(lp);  // must construct — no default

const text = await fs.readFile('/etc/hosts');
const file = await fs.open('/tmp/out.txt', 'w');
await file.writer().write(bytes);
await file.close();

const dir = await fs.dir('/tmp');
for await (const entry of dir) { ... }
```

`File` is a metadata handle + Reader/Writer factories. It does not expose seek or raw I/O directly. `DirEntry` is async-iterable over children.

### HTTP (`boats:http`)

- `parseRequest(asyncIterable)` / `parseResponse(asyncIterable)` — consume any async iterable (e.g. a `Reader`)
- `serializeRequest(req)` / `serializeResponse(res)` — return async iterables suitable for `writer.pipe()`
- `Request`, `Response`, `Headers` implement a subset of the Fetch API

### JS coding conventions

- **Always use `#privateField` for internal class state** — never use underscore-prefixed properties (`_field`) as a privacy convention. Use ES2022 private fields (`#field`) and private methods (`#method()`) instead. For module-level functions that need access to class internals (e.g. functional APIs), use a `WeakMap` to store private state keyed on the instance.

### Test framework (`boats:test`)

```js
import { test } from 'boats:test';

test('name', async (t) => {
  t.ok(val, msg)
  t.equal(got, expected, msg)
  t.deepEqual(got, expected, msg)
  t.throws(fn, /pattern/, msg)
  await t.rejects(asyncFn, /pattern/, msg)
});
```

Tests run serially. `boats --test` mode auto-calls `run()` after all test files are imported. TAP-13 output goes directly to stdout via libc; use exit code for CI.
