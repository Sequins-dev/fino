---
weight: 32
---
# REPL

Bare `fino` and `fino repl` start an interactive session:

```sh
fino repl
```

The parent realm owns terminal input and output. Evaluation runs in a child
realm through the inspector bridge, so user code executes in a normal runtime
context instead of mutating the root CLI module.

The REPL supports multi-line input through a lightweight bracket and quote
balance check. It prints expression results when evaluation produces a value.

Import the default task from `fino:commands/repl` to mount the REPL command.
