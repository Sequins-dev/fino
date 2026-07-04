---
weight: 32
---
# repl

Bare `fino` and `fino repl` start an interactive runtime session:

```sh
fino repl
```

The parent realm owns terminal input and output. Evaluation runs in a child
realm through the inspector bridge, so user code executes in a normal runtime
context instead of mutating the root CLI module.

## Command Reference

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| none | - | - | no | `repl` does not accept positional arguments or command-specific flags. |

## Behavior

The REPL supports top-level `await`, simple multiline input through bracket and
quote balancing, expression result printing, and exits on `.exit`, Ctrl-C,
Ctrl-D, or stdin EOF. Thrown errors are printed without ending the session.

This is not Node's `repl` module. There is no persistent history file,
completion API, raw terminal editing contract, pluggable writer, or
PTY-specific behavior guarantee yet. Embedded realm REPL mode is limited to
same-process realms; `repl: true` is rejected with `thread`, `process`,
`remote`, or `watch`.

