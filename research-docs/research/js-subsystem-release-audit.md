# JS Subsystem Release Audit

This is a release-readiness work tracker for the `js/` subsystem, not generated API documentation. `DONE` means the API shape, docs, focused tests, benchmark coverage, and obvious feature scope look ready for release based on the current source audit.

## Runtime Core, Bootstrap, Loader
Status: DONE

## CLI Commands And Tooling
Status: Needs work
- Bring `fino bench` behavior in line with its CLI docs by supporting directory/glob inputs, then add CLI tests for those benchmark input modes.

## Process And `process/argv`
Status: DONE

## `fino:module`
Status: DONE

## `fino:config`
Status: DONE

## `fino:tty`
Status: DONE

## Builtin Registration
Status: DONE

## File APIs
Status: Needs work
- Fix or replace focused tests that import blocked internal modules directly.
- Add generated-doc entries for exported `F_OK`, `R_OK`, `W_OK`, and `X_OK`.
- Broaden `fino:file/watch` benchmarks beyond constructing and closing a `Watcher`.

## Archive
Status: Needs work
- Replace constructor/reference-only benchmark coverage with real create, list, read, and extract benchmarks.
- Rebuild and rerun focused archive tests before release to confirm security regressions pass with the current source.

## Database/SQLite
Status: Needs work
- Add real SQLite benchmarks for open, prepare, run, get, all, iteration, transaction, and VFS-backed file I/O.
- Ensure release CI installs `libsqlite3` so focused SQLite tests do not silently exit early.
- Decide, document, or implement the VFS `xFileControl` `SQLITE_NOTIMPL` behavior.

## Compression
Status: Needs work
- Fix streaming decompressor EOF validation so truncated zlib/Brotli streams are detected as documented.
- Replace the CompressionStream truncated-gzip spec-gap test with an enforcing regression test after the fix.
- Expand benchmarks beyond one-shot gzip to include deflate, deflate-raw, Brotli, and streaming APIs.

## `net/socket`
Status: DONE

## `net/tls`
Status: Needs work
- Add deterministic local TLS socket tests; current focused coverage relies on public network hosts.

## `net/dns`
Status: Needs work
- Decide or release-gate documented gaps: DNSSEC validation and TCP fallback for truncated UDP responses are not implemented.
- Reduce live public DNS reliance in focused tests.

## `net/http`
Status: DONE

## `net/http/app`
Status: DONE

## `net/http/h2`
Status: DONE

## `net/http/h3`
Status: Needs work
- Add module and symbol JSDoc for `fino:net/http/h3`.
- Add the missing `benchmarks/net/http/h3.bench.mts` listed in `benchmarks/COVERAGE.md`, or correct the coverage map.
- Expand release tests for HTTP/3 availability, fallback, and error paths.

## `net/quic`
Status: Needs work
- Add generated API documentation for `fino:net/quic`.

## Web Globals
Status: Needs work
- Align the public import surface: globals are registered as `internal:globals/*`, while ambient declarations and benchmarks refer to `fino:*` global modules such as `fino:console`, `fino:crypto`, `fino:url`, and `fino:webstreams`.
- Remove or correct stale docs that still describe implemented `console.count()` and `console.countReset()` behavior as stubs.

## WHATWG Web Streams
Status: Needs work
- Resolve the `fino:webstreams` benchmark/import mismatch before release.

## Internal Stream
Status: Needs work
- Decide whether the stream module is public `fino:stream` or internal-only; current docs and registration do not agree.
- Add focused coverage for `BufferedBytesReader`, `BufferedBytesWriter`, `FdReader`, `FdWriter`, `readUntil`, `peek`/`takeBuffered`, and `writev`.

## Security Encoding
Status: DONE

## UUID
Status: DONE

## Template
Status: DONE

## Semver
Status: DONE

## Parsing Scanner
Status: DONE

## Security
Status: DONE

## Formats
Status: DONE

## Validation
Status: DONE

## Logging
Status: DONE

## Realm
Status: DONE

## Cluster
Status: Needs work
- Add public integration coverage for `startCluster()`, `joinCluster()`, `leaveCluster()`, and `new Realm({ remote: true }).call()` over the real WebSocket cluster path.
- Resolve public export intent for `ClusterPort` and `getCluster`.
- Replace or expand `benchmarks/cluster.bench.mts` so it covers documented public cluster operations.

## Testing
Status: Needs work
- Export/document or inline private types that appear in generated public signatures, including runner registration types and mock HTTP matcher/factory types.

## OpenTelemetry
Status: Needs work
- Replace public split-module docs that still describe symbols as internal/private documentation.
- Add the missing split benchmarks listed in `benchmarks/COVERAGE.md`: `benchmarks/opentelemetry/logs.bench.mts`, `metrics.bench.mts`, `sdk.bench.mts`, and `traces.bench.mts`, or correct the coverage map.
- Extend benchmark coverage validation to assert listed benchmark files exist.
