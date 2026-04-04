# Fino Feature Roadmap

## Tier 2 — Ecosystem Compatibility

The single largest practical barrier to adoption is the inability to use npm packages. These items collectively bootstrap that access. The lesson from Deno vs. Bun: **ship npm compat early or stall**.

### 2.1 node: Protocol Aliases

- **Why**: Modern npm packages use `import x from 'node:fs'` bare specifiers. Without resolution these imports throw immediately and no workaround exists. A necessary prerequisite for npm compatibility.
- **Approach**: In `src/loader.rs`, add a `starts_with("node:")` branch to the specifier matching block (alongside the existing `fino:` and `internal:` checks in `resolve_module_callback`). Map known `node:` specifiers to their `fino:` equivalents (`node:path` → `fino:file/path`, `node:crypto` → crypto globals, etc.). Unrecognized `node:` specifiers produce a clear error.
- **Complexity**: Trivial (1–2 days). The mapping table will be incomplete but directionally correct and immediately useful.

### 2.3 Buffer Class

- **Why**: `Buffer` is the most-used Node.js API in the npm ecosystem. Packages that do any I/O, encoding, hashing, or serialization depend on it. Without `Buffer`, most non-trivial npm packages fail immediately.
- **Approach**: Implement `Buffer` as a `Uint8Array` subclass with the Node.js static and instance API: `Buffer.from(string, encoding)`, `Buffer.from(arrayBuffer)`, `Buffer.alloc(size)`, `Buffer.allocUnsafe(size)`, `Buffer.concat(list)`, `Buffer.isBuffer(v)`, `.toString(encoding)`, `.write(string, offset, encoding)`, `.readUInt32BE/LE()`, etc. Expose as `globalThis.Buffer`. Encodings: `utf8`, `hex`, `base64`, `base64url`, `binary`/`latin1`, `ascii`.
- **Complexity**: Medium (1 week). Tedious API surface but no novel logic; all encoding primitives already exist in `TextEncoder`/`TextDecoder` and `crypto`.

### 2.4 globalThis.process Compat Shim

- **Why**: Virtually every npm package that touches Node.js APIs checks `process.env`, `process.platform`, `process.version`, `process.exit()`, or `process.argv`. Without a `process` global they fail at startup.
- **Approach**: In `js/_main.mts`, construct a `globalThis.process` object mapping to existing `fino:runtime/process` exports: `env`, `argv`, `platform`, `version` (static string matching a recent Node.js version for compat), `exit()`, `cwd()`, `chdir()`, `pid`, `ppid`, `stdin`, `stdout`, `stderr`. The signal handlers also hang off this object.
- **Complexity**: Small (1 day). Pure wiring of already-implemented capabilities.

### 2.6 SQLite

- **Why**: The most common embedded database for application data, caches, session stores, and analytics. Built-in in Bun and Node.js v22.5+. High value for standalone apps with no external dependencies.
- **Approach**: FFI to system SQLite (`libsqlite3.dylib` / `libsqlite3.so`). Expose as `fino:sqlite`:
  - `Database` class: `open(path, options?)`, `close()`, `exec(sql)`, `prepare(sql)` → `Statement`
  - `Statement` class: `run(params)`, `get(params)`, `all(params)`, `iterate(params)` (async-iterable)
  - `db.transaction(fn)` for atomic multi-statement execution
  - Named (`:name`, `$name`) and positional (`?`) parameters
  - Type mapping: NULL → `null`, INTEGER → `number` / `BigInt`, REAL → `number`, TEXT → `string`, BLOB → `Uint8Array`
- **Complexity**: Medium (1 week). The sqlite3 C API is clean. Main work is value marshaling via `sqlite3_bind_*` / `sqlite3_column_*`.

### 2.7 Extended SubtleCrypto Algorithms

- **Why**: Real-world cryptography — JWT signing, TLS key exchange, OAuth PKCE, end-to-end encryption — requires asymmetric algorithms. The current implementation covers only symmetric (AES) and hashing (SHA, HMAC).
- **Approach**: Extend `js/internal/globals/crypto.mts` via the existing `internal:openssl` FFI bindings. Add:
  - **ECDSA** (P-256, P-384, P-521) — `sign` / `verify` / `generateKey` / `importKey` / `exportKey`
  - **ECDH** (P-256, P-384, P-521) — `generateKey` / `deriveBits` / `deriveKey`
  - **RSA-OAEP** — `encrypt` / `decrypt` / `generateKey` / `importKey` / `exportKey`
  - **RSA-PSS** — `sign` / `verify` / `generateKey` / `importKey` / `exportKey`
  - Key serialization: SPKI (public), PKCS8 (private), JWK
- **Complexity**: Medium-large (1–2 weeks). OpenSSL EVP APIs handle the heavy lifting; the work is key serialization/deserialization and JWK format handling.

---

## Tier 3 — Broader Compatibility

Larger investments that extend reach to the long tail of the npm ecosystem and improve developer experience.

### 3.2 VM / Module Evaluation

- **Why**: Enables sandboxed code execution, server-side rendering, plugin systems, REPLs, and test isolation. Equivalent to the Node.js `vm` module.
- **Approach**: Requires Rust-side support — create additional V8 `Context` objects within the existing `Isolate`, each with its own global template. V8 natively supports multiple contexts with isolated globals. The loader already manages context-scoped state via `FinoState` in context slots (`src/loader.rs`, `src/state.rs`). Expose as `fino:vm`:
  - `createContext(sandbox?)` — creates an isolated evaluation context with a fresh global
  - `runInContext(code, context)` — evaluate a JS string in the context via `v8::Script::compile()`
  - `Script` class for compiled-once, run-many patterns
- **Complexity**: Medium. V8 contexts are first-class and well-documented. The main challenge is defining what leaks between contexts and integrating the microtask queue.

### 3.3 Watch Mode

- **Why**: Automatic restart on file changes is a table-stakes developer experience feature. Currently users must reach for an external tool like `watchexec`.
- **Approach**: A `--watch` CLI flag. Hook the module loader to record all resolved paths as they are imported. Use `fino:file/watch` (already implemented via kqueue EVFILT_VNODE / inotify) to watch the import graph. On change, re-exec the process via `execve`. Watch newly imported files as the module graph grows at runtime.
- **Complexity**: Medium. The file watcher already exists; the work is tracking the import graph and wiring re-exec.

### 3.5 REPL

- **Why**: An interactive REPL is useful for exploration, debugging, and learning. Expected by anyone familiar with `node` or `deno`.
- **Depends on**: VM / Module Evaluation (3.2) for a persistent evaluation context with incremental input.
- **Approach**: A `--repl` CLI flag (or bare `fino` with no arguments). Use `readline` via libc FFI for line editing and history. Each input is compiled and evaluated via `v8::Script::compile()` in a persistent VM context. Stack traces automatically remap to source positions via the existing `Error.prepareStackTrace` override. Multi-line continuation detection (unclosed brackets/strings) via a simple heuristic.
- **Complexity**: Medium. Readline FFI is straightforward; the REPL loop is simple once VM (3.2) exists.

---

## Tier 4 — Advanced Capabilities

Long-term, strategic investments. High value but very large effort.

### 4.1 HTTP/2

- **Why**: Performance and compatibility with modern infrastructure. Required for gRPC.
- **Depends on**: TLS (done, ALPN negotiation for `h2`).
- **Complexity**: Very large. HTTP/2 framing, HPACK header compression, stream multiplexing, and flow control are each substantial projects.

### 4.2 Workers / Multi-threading

- **Why**: CPU-bound tasks block the single-threaded event loop. Workers allow parallelism for compute-intensive work.
- **Approach**: Spawn OS threads, each with their own V8 `Isolate`. V8 is single-threaded per isolate but supports multiple isolates in the same process (the standard pattern used by Node.js, Deno, and Bun). Communication via `postMessage` + structured clone. `SharedArrayBuffer` and `Atomics` are built into V8 and do not require custom implementation.
- **Complexity**: Very large. Thread-safe message passing, structured clone, and the overall Worker API surface require substantial work — though `SharedArrayBuffer`/`Atomics` come for free from V8.

### 4.4 Synthetic Module Building from JS

- **Why**: Enables dynamically creating modules at runtime. Useful for loaders, bundlers, hot module replacement, and test mocking.
- **Approach**: `v8::Module::create_synthetic_module()` is already used in `src/loader.rs` for all built-in synthetic modules (`fino:ffi`, `internal:process`, `internal:async-context`, etc.). The remaining work is exposing this to userland JS: a `fino:vm` (or `fino:module`) API where user code provides an export name list and an initializer callback, and Rust creates and registers the module through the existing loader cache.
- **Complexity**: Medium. The core infrastructure is in place and tested. The remaining work is the JS-facing API surface and module cache integration.
