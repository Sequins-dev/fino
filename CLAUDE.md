# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

**fino** — a JS/TypeScript runtime built on V8 (the `v8` Rust crate). The design philosophy is **thin Rust, everything else in JS**: Rust provides V8 bindings, an FFI layer, and a module loader. All I/O, networking, and standard library are implemented in JS by calling libc/system libraries directly via FFI.

The binary is `fino`. Module specifiers are `fino:*` for public built-ins and `internal:*` for built-ins importable only from other built-ins. There is no `boats:` prefix — that was an old name.

## Commands

```bash
# Build
cargo build
cargo build --release

# Run a script
cargo run -- script.mts
./target/debug/fino script.mts

# Run all tests
cargo run -- --test 'tests/**/*.test.mts'

# Run a single test file
cargo run -- --test tests/ffi.test.mts

# Lint / format
cargo clippy
cargo fmt --check
cargo fmt

# Rust-side unit tests
cargo test --quiet
```

Tests emit TAP output. Use exit code: `0` = all pass, `1` = failures.

## Architecture

### Rust layer (`src/`)

| File/dir | Role |
|---|---|
| `main.rs` | Entry point |
| `runtime.rs` | V8 isolate init, host event loop, `pump_and_checkpoint` |
| `loader.rs` | Module loader — resolves `fino:*` / `internal:*` builtins and filesystem imports |
| `state.rs` | `FinoState` — per-V8-context state stored in a context slot |
| `ffi/` | `fino:ffi` synthetic module — `dlopen` + `Pointer` |
| `platform.rs` | `internal:process` synthetic module |
| `async_context.rs` | `internal:async-context` — `scheduleSync`, `runLoop`, `drainMicrotasks`, CPED helpers |
| `realm/` | Child realm creation (embedded, thread, process), Facade/RPC machinery |

**Only add Rust modules when you need V8 API access or compile-time information.** Standard library logic belongs in JS.

### Module scopes

- `fino:*` — public built-in modules, importable by any code
- `internal:*` — restricted built-in modules, importable only by other built-ins (enforced in `loader.rs`)

### JS layer (`js/`)

All `.mts` files in `js/` are TypeScript sources stripped of types at build time by `build.rs` (OXC) and baked into the binary via `include_str!()`. They are registered as `fino:*` or `internal:*` specifiers in `src/loader.rs`.

**To add a new built-in:**
1. Create `js/mymodule.mts`
2. Add `source_builtin!("fino:mymodule", "mymodule")` to the `BUILTINS` array in `src/loader.rs`
3. Import as `import ... from 'fino:mymodule'`

### V8 / event loop model

The runtime is V8-based, not Boa. Key primitives:

- **`MicrotasksPolicy::Explicit`** — microtasks only run when `perform_checkpoint()` is called explicitly.
- **`pump_and_checkpoint(scope)`** (`src/runtime.rs:308`) — pumps V8 platform tasks then drains the microtask queue. Called between each host-loop step.
- **`internal:async-context`** exposes `drainMicrotasks`, `scheduleSync`, `runLoop`, and CPED helpers to JS.
- The host loop (`runtime.rs:184`) calls a JS step function (`loop_step_fn`) each iteration; the step function drives kqueue/io_uring I/O.

kqueue (macOS) and io_uring (Linux) backends are in `js/internal/runtime/kqueue.mts` and `js/internal/runtime/io_uring.mts`. `internal:runtime/loop` abstracts over both.

### FFI (`fino:ffi`)

```js
import { dlopen, Pointer } from 'fino:ffi';

const lib = dlopen('/usr/lib/libSystem.B.dylib', {
  read:  { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  write: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  // Async (thread-pool offload, non-pointer params only):
  usleep: { parameters: ['u32'], result: 'void', async: true },
});
lib.symbols.read(fd, buf, len);          // → number (sync)
await lib.symbols.usleep(1000);          // → Promise (async)
```

**FFI types:** `u8 i8 u16 i16 u32 i32 u64 i64 usize isize f32 f64 bool void pointer buffer`

**`async: true`** on a symbol definition offloads the call to a thread pool and returns a Promise. Only scalar params are supported (no `pointer`/`buffer` for async symbols — the GC may collect the ArrayBuffer before the call completes).

### Realm / Facade system

Child realms run JS in isolation. They can be embedded (same V8 isolate), thread (own isolate, own thread), or process (own process). The Facade mechanism lets a parent expose a scoped API to a child:

```ts
import { Realm, ImportMap } from 'fino:realm';

const facade = new Facade('fino:myapi', ['doThing'])
  .handle('doThing', async (x) => x * 2);

const realm = new Realm({
  thread: true,
  overrides: ImportMap.deny([
    { pattern: 'fino:myapi', directive: facade.toDirective() },
  ]),
  entry: '/path/to/child.mts',
});
```

`ImportMap.deny(overrides)` blocks all imports by default, with overrides layered on top. Capability narrowing is enforced in Rust (`src/realm/native.rs`): children cannot re-grant what parents blocked.

### Async executor

`internal:async-runtime` provides Rust-backed async primitives:

- **Per-isolate `LocalExecutor`** — single-threaded async executor for `future_to_promise` / `promise_to_future` in Rust code.
- **Global blocking pool** — thread pool for offloading sync FFI calls (backs `async: true` symbols).
- **Wake pipe** — one self-pipe per isolate; background threads write to it when work completes; JS registers the read end with `loop.readable()`.

The executor is shared across all same-thread realms (one per V8 isolate). `pump_and_checkpoint` runs a fixed-point loop: `executor.try_tick()` → drain pending resolutions → `perform_checkpoint()` → repeat until quiescent.

### JS coding conventions

- **Always use `#privateField`** for internal class state — never underscore-prefixed props.
- **No comments** unless the WHY is non-obvious.
- **No DOM types** — use plain `Error`, not `DOMException`.
- **Async I/O only** — never call blocking libc functions from the main thread; use `loop.readable/writable/submit` or `async: true` FFI.

### Test framework (`fino:test/test`)

```js
import { describe, it } from 'fino:test/test';

describe('my module', () => {
  it('does something', async (t) => {
    t.ok(val, msg);
    t.equal(got, expected, msg);
    t.deepEqual(got, expected, msg);
    t.throws(fn, /pattern/, msg);
    await t.rejects(asyncFn, /pattern/, msg);
  });
});
```

Tests are in `tests/` grouped by domain. Name files `*.test.mts`.
