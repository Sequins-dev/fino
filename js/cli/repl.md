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

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| none | no | `repl` does not accept positional arguments. |

## Flags

| Flag | Value | Description |
| --- | --- | --- |
| none | no | `repl` has no command-specific flags. |

## Behavior

The REPL supports top-level `await`, simple multiline input through bracket and
quote balancing, expression result printing, and exits on `.exit`, Ctrl-C,
Ctrl-D, or stdin EOF. Thrown errors are printed without ending the session.

This is not Node's `repl` module. There is no persistent history file,
completion API, raw terminal editing contract, pluggable writer, or
PTY-specific behavior guarantee yet. Embedded realm REPL mode is limited to
same-process realms; `repl: true` is rejected with `thread`, `process`,
`remote`, or `watch`.

## Reuse

Import the default task from `fino:commands/repl` to mount the REPL command:

```ts no_run
import repl from 'fino:commands/repl';

await repl.parse([]);
```
