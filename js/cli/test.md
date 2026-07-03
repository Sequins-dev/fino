---
weight: 33
---
# Test Command

`fino test` imports test modules and delegates execution to the Fino test
framework:

```sh
fino test tests/app.test.ts
fino test tests/net
fino test 'tests/**/*.test.ts'
```

Directory inputs expand to matching `.test.ts` files. Glob inputs are resolved
from the current working directory. Test modules register cases through
`fino:test` or `fino:test/test`, and results are emitted as TAP-13.

Use `--filter` to run registered tests whose full path contains text:

```sh
fino test --filter websocket tests/net
```

Console output is captured by default and printed for failures. Use
`--show-output=always` for live debugging output or `--show-output=never` to
suppress captured output in failure details.

Import the default task from `fino:commands/test` to reuse this command.
