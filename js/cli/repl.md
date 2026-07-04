---
weight: 32
---
# repl

Bare `fino` and `fino repl` start an interactive runtime session. Use the REPL
for quick checks against runtime APIs, small import experiments, and debugging
snippets that are not yet worth turning into a script or test:

```sh
fino repl
```

The parent realm owns terminal input and output. Evaluation runs in a child
realm through the inspector bridge, so user code executes in a normal runtime
context instead of mutating the root CLI module. That keeps the CLI shell
separate from the code being evaluated while still giving snippets access to
the same runtime modules they would have in a script.

## Command Reference

| Name | Value | Description |
| --- | --- | --- |
| none | - | `repl` does not accept positional arguments or command-specific flags. |

## Behavior

The REPL supports top-level `await`, simple multiline input through bracket and
quote balancing, expression result printing, and exits on `.exit`, Ctrl-C,
Ctrl-D, or stdin EOF. Thrown errors are printed without ending the session.

Typical REPL work should stay exploratory:

```ts no_run
> const { readFile } = await import('fino:file/fs')
> await readFile('package.json')
```

This is not Node's `repl` module. There is no persistent history file,
completion API, raw terminal editing contract, pluggable writer, or
PTY-specific behavior guarantee yet. Embedded realm REPL mode is limited to
same-process realms; `repl: true` is rejected with `thread`, `process`,
`remote`, or `watch`.
