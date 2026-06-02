# tty

fino:tty — small terminal helpers for TTY detection and line-oriented I/O.

This module is intentionally low-level. It exposes the process standard
streams as text helpers while leaving richer prompt behavior to
`fino:tty/prompt`.

## isatty

```ts
function isatty(fd: number): boolean
```

Return whether a numeric file descriptor is attached to a terminal.

## stdinIsTTY

```ts
const stdinIsTTY
```

Whether standard input is attached to a terminal.

## stdoutIsTTY

```ts
const stdoutIsTTY
```

Whether standard output is attached to a terminal.

## stderrIsTTY

```ts
const stderrIsTTY
```

Whether standard error is attached to a terminal.

## readLine

```ts
async function readLine(prompt: string = ''): Promise<string | null>
```

Read one line from standard input, optionally writing a prompt first.

Returns `null` when input closes before any bytes are read.

## writeStdout

```ts
async function writeStdout(text: string): Promise<void>
```

Write UTF-8 text to standard output.

## writeStderr

```ts
async function writeStderr(text: string): Promise<void>
```

Write UTF-8 text to standard error.
