# Boats Feature Roadmap

## Tier 2 — Ecosystem Compatibility

The single largest practical barrier to adoption is the inability to use npm packages. These items collectively bootstrap that access. The lesson from Deno vs. Bun: **ship npm compat early or stall**.

### 2.1 node: Protocol Aliases

- **Why**: Modern npm packages use `import x from 'node:fs'` bare specifiers. Without resolution these imports throw immediately and no workaround exists. A necessary prerequisite for npm compatibility.
- **Approach**: In `src/loader.rs`, add a `starts_with("node:")` branch to the specifier matching block. Map known `node:` specifiers to their `boats:` equivalents (`node:path` → `boats:file/path`, `node:crypto` → crypto globals, etc.). Unrecognized `node:` specifiers produce a clear error.
- **Complexity**: Trivial (1–2 days). The mapping table will be incomplete but directionally correct and immediately useful.

### 2.2 npm / node_modules Resolution

- **Why**: Without bare specifier resolution, Boats cannot import any installed package. This is the most impactful capability for real-world adoption.
- **Approach**: **Phase 1 (ESM-only, Tier 2)**: Modify `resolve()` in `js/internal/loader.mts` to walk `node_modules/` directories from the importing file's location upward, read `package.json` `exports` / `main` / `module` fields, and resolve the final path. Handles conditional exports (`import` vs `require` vs `default`) and subpath patterns. **Phase 2 (CJS interop)** is a separate Tier 3 item.
- **Complexity**: Medium (1–2 weeks for Phase 1). The Node.js resolution algorithm is well-documented; subpath exports patterns are the tricky part.

### 2.3 Buffer Class

- **Why**: `Buffer` is the most-used Node.js API in the npm ecosystem. Packages that do any I/O, encoding, hashing, or serialization depend on it. Without `Buffer`, most non-trivial npm packages fail immediately.
- **Approach**: Implement `Buffer` as a `Uint8Array` subclass with the Node.js static and instance API: `Buffer.from(string, encoding)`, `Buffer.from(arrayBuffer)`, `Buffer.alloc(size)`, `Buffer.allocUnsafe(size)`, `Buffer.concat(list)`, `Buffer.isBuffer(v)`, `.toString(encoding)`, `.write(string, offset, encoding)`, `.readUInt32BE/LE()`, etc. Expose as `globalThis.Buffer`. Encodings: `utf8`, `hex`, `base64`, `base64url`, `binary`/`latin1`, `ascii`.
- **Complexity**: Medium (1 week). Tedious API surface but no novel logic; all encoding primitives already exist in `TextEncoder`/`TextDecoder` and `crypto`.

### 2.4 globalThis.process Compat Shim

- **Why**: Virtually every npm package that touches Node.js APIs checks `process.env`, `process.platform`, `process.version`, `process.exit()`, or `process.argv`. Without a `process` global they fail at startup.
- **Approach**: In `js/_main.mts`, construct a `globalThis.process` object mapping to existing `boats:runtime/process` exports: `env`, `argv`, `platform`, `version` (static string matching a recent Node.js version for compat), `exit()`, `cwd()`, `chdir()`, `pid`, `ppid`, `stdin`, `stdout`, `stderr`. The signal handlers from 1.1 also hang off this object.
- **Complexity**: Small (1 day). Pure wiring of already-implemented capabilities.

### 2.5 WebSocket (Client + Server)

- **Why**: Real-time bidirectional communication. Needed for dev servers, live reload, dashboards, chat, and inter-process communication. Many npm packages provide higher-level WebSocket abstractions.
- **Depends on**: TLS (done, for WSS), crypto (done, for SHA-1 `Sec-WebSocket-Accept` header computation).
- **Approach**: Pure JS implementation on top of `boats:net/socket` and `internal:stream`. HTTP Upgrade handshake for client and server. Frame parser/serializer handling opcodes (text, binary, ping, pong, close), masking, and fragmentation. Expose as `boats:net/websocket` plus a `WebSocket` global (W3C client API) and server-side `WebSocketServer` class.
- **Complexity**: Medium-large (1–2 weeks). Frame parsing, masking, fragmentation, ping/pong keepalive, and the close handshake each add surface area.

### 2.6 SQLite

- **Why**: The most common embedded database for application data, caches, session stores, and analytics. Built-in in Bun and Node.js v22.5+. High value for standalone apps with no external dependencies.
- **Approach**: FFI to system SQLite (`libsqlite3.dylib` / `libsqlite3.so`). Expose as `boats:sqlite`:
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

### 3.1 CJS Interop

- **Why**: Despite ESM being the modern standard, a large fraction of npm packages still ship CommonJS only. Phase 1 npm resolution (2.2) covers ESM packages; CJS interop covers the rest.
- **Approach**: Implement a `require()` shim that evaluates CJS modules in a function scope with `module`, `exports`, `require`, `__filename`, and `__dirname` injected. The evaluated `exports` object is re-exported as the default (and named) export of a synthetic ESM wrapper. Static analysis of `exports.foo = ...` assignments can provide named exports as a refinement.
- **Complexity**: Large. CJS semantics (synchronous `require`, circular dependencies, `module.exports` reassignment) are fundamentally different from ESM. Expect edge cases.

### 3.2 VM / Module Evaluation

- **Why**: Enables sandboxed code execution, server-side rendering, plugin systems, REPLs, and test isolation. Equivalent to the Node.js `vm` module.
- **Approach**: Requires Rust-side support — create additional Boa `Realm` instances with controlled globals. Expose as `boats:vm`:
  - `createContext(sandbox?)` — creates an isolated evaluation context with a fresh global
  - `runInContext(code, context)` — evaluate a JS string in the context
  - `Script` class for compiled-once, run-many patterns
- **Complexity**: Medium. Boa supports multiple Realms. The main challenge is defining what leaks between realms and what doesn't.

### 3.3 Watch Mode

- **Why**: Automatic restart on file changes is a table-stakes developer experience feature. Currently users must reach for an external tool like `watchexec`.
- **Approach**: A `--watch` CLI flag. Hook the module loader to record all resolved paths as they are imported. Use `boats:file/watch` (already implemented via kqueue EVFILT_VNODE / inotify) to watch the import graph. On change, re-exec the process via `execve`. Watch newly imported files as the module graph grows at runtime.
- **Complexity**: Medium. The file watcher already exists; the work is tracking the import graph and wiring re-exec.

### 3.4 Source Maps for TypeScript

- **Why**: When a TypeScript file throws an error, stack traces currently point to stripped-JS line numbers. This makes debugging painful and is the main ergonomic gap versus running TypeScript natively.
- **Approach**: Configure OXC (already used for type stripping) to emit source maps alongside the stripped output. At runtime, intercept `Error` stack trace generation (via `Error.prepareStackTrace` if Boa supports it, otherwise post-process the string) and remap line/column through the source map. Cache maps keyed by module specifier.
- **Complexity**: Medium. OXC source map output is straightforward; stack trace interception depends on Boa's Error API surface.

### 3.5 REPL

- **Why**: An interactive REPL is useful for exploration, debugging, and learning. Expected by anyone familiar with `node` or `deno`.
- **Depends on**: VM / Module Evaluation (3.2) for a persistent evaluation context with incremental input.
- **Approach**: A `--repl` CLI flag (or bare `boats` with no arguments). Use `readline` via libc FFI for line editing and history. Each input is evaluated in a persistent VM context. Multi-line continuation detection (unclosed brackets/strings) via a simple heuristic.
- **Complexity**: Medium. Readline FFI is straightforward; the REPL loop is simple once VM exists.

---

## Tier 4 — Advanced Capabilities

Long-term, strategic investments. High value but very large effort.

### 4.1 HTTP/2

- **Why**: Performance and compatibility with modern infrastructure. Required for gRPC.
- **Depends on**: TLS (done, ALPN negotiation for `h2`).
- **Complexity**: Very large. HTTP/2 framing, HPACK header compression, stream multiplexing, and flow control are each substantial projects.

### 4.2 Workers / Multi-threading

- **Why**: CPU-bound tasks block the single-threaded event loop. Workers allow parallelism for compute-intensive work.
- **Approach**: Spawn OS threads, each with their own Boa `Context`. Communication via `postMessage` + structured clone. Boa is single-threaded per context; no shared JS objects across threads.
- **Complexity**: Very large. Thread-safe message passing, structured clone, and `SharedArrayBuffer` / `Atomics` support require deep runtime changes.

### 4.3 WASM Support

- **Why**: A growing ecosystem of WASM modules enables using Rust, C, Go, and Zig compiled libraries directly from JS.
- **Approach**: Boa has experimental WASM support. Investigate enabling `WebAssembly.compile` / `instantiate` and expose any gaps.
- **Complexity**: Depends on Boa's current WASM state — could be a flag toggle or a substantial patch effort.

### 4.4 Synthetic Module Building from JS

- **Why**: Enables dynamically creating modules at runtime. Useful for loaders, bundlers, hot module replacement, and test mocking.
- **Approach**: Expose Boa's `Module::synthetic` to JS. User code provides an export name list and an initializer callback; Rust creates the module and invokes the callback to populate exports.
- **Complexity**: Medium. Needs careful handling of the Boa module lifecycle (parse → link → evaluate).
