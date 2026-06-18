# JS Subsystem Release Audit

This is a release-readiness work tracker for the `js/` subsystem, not generated API documentation. `DONE` means the API shape, docs, focused tests, benchmark coverage, and obvious feature scope look ready for release based on the current source audit.

## Runtime Core, Bootstrap, Loader
Status: DONE

## CLI Commands And Tooling
Status: DONE

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
Status: DONE

## Archive
Status: DONE

## Database/SQLite
Status: Needs work
- Add real SQLite benchmarks for open, prepare, run, get, all, iteration, transaction, and VFS-backed file I/O.
- Ensure release CI installs `libsqlite3` so focused SQLite tests do not silently exit early.
- Decide, document, or implement the VFS `xFileControl` `SQLITE_NOTIMPL` behavior.

## Compression
Status: DONE

## `net/socket`
Status: DONE

## `net/tls`
Status: DONE

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
Status: DONE

## `net/quic`
Status: DONE

## Web Globals
Status: DONE

## WHATWG Web Streams
Status: DONE

## Internal Stream
Status: DONE

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
Status: DONE

## OpenTelemetry
Status: DONE
