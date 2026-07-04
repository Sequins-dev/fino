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
```

Direct file inputs are imported as given. Directory inputs expand to descendant
`.test.ts` files. Glob inputs are resolved from the current working directory.
If expansion includes `.test.ts` files, non-test helper modules are ignored, so
`fino test tests/net` imports test files without also importing helpers that sit
beside them. Results are emitted as TAP-13, which is readable in a terminal and
can be consumed by TAP tooling.

## Command Reference

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `files...` | argument | strings | yes | Test files, directories, or glob patterns to import and run. |
| `--filter` | flag | string | no | Run only registered tests whose full path contains the filter text. |
| `--show-output` | flag | `failures`, `always`, or `never` | no | Control captured console output. Defaults to `failures`. |
| `--durations` | flag | boolean | no | Add TAP duration metadata to result lines. |

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
