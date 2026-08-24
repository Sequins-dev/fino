---
weight: 33
---
# test

`fino test` runs tests written for Fino's built-in test framework. Use it for
runtime integration tests, module-level regression tests, and API behavior that
needs to execute inside Fino instead of Node or another JavaScript host:

```sh
fino test tests/app.test.ts
fino test tests/net
fino test 'tests/**/*.test.ts'
fino test --coverage tests/app.test.ts
```

Direct file inputs are imported as given. Directory inputs expand to descendant
`.test.ts` files. Glob inputs are resolved from the current working directory.
If expansion includes `.test.ts` files, non-test helper modules are ignored, so
`fino test tests/net` imports test files without also importing helpers that sit
beside them. Results are emitted as TAP-13, which is readable in a terminal and
can be consumed by TAP tooling.

## Command Reference

| Name | Value | Description |
| --- | --- | --- |
| `files...` | strings | Required. Test files, directories, or glob patterns to import and run. |
| `--filter` | string | Run only registered tests whose full path contains the filter text. |
| `--show-output` | `failures`, `always`, or `never` | Control captured console output. Defaults to `failures`. |
| `--durations` | boolean | Add TAP duration metadata to result lines. |
| `--coverage[=<path>]` | path | Collect native V8 coverage. A bare flag writes `coverage/coverage.json`; a custom path must use `=`. |

Console output is captured by default and printed for failures. Use
`--show-output=always` for live debugging output or `--show-output=never` to
suppress captured output in failure details.

Use `--filter` when a suite is large but the registered test path has a stable
name:

```sh
fino test --filter websocket tests/net
```

The command throws when no files are supplied or expansion finds no test files.
It is not a Node `node:test` compatibility command.

## Coverage

Coverage is collected from V8 in every participating Realm and remapped to
original TypeScript locations with the source maps already produced by Fino's
loader. The TAP stream ends with one grouped `# coverage` comment block. The
canonical JSON artifact preserves aggregate totals and the Realm ids which
covered each line, function, and branch.

Use [`fino coverage`](./coverage.md) to inspect that artifact, apply thresholds,
or export LCOV.
