# tty

fino:tty — small terminal helpers for TTY detection and line-oriented I/O.

This module is intentionally low-level. It exposes the process standard
streams as text helpers while leaving richer prompt behavior to
`fino:tty/prompt`.

```ts
import { stdinIsTTY, readLine, writeStdout } from 'fino:tty';

if (stdinIsTTY) {
  const name = await readLine('Name: ');
  await writeStdout(`Hello ${name ?? 'anonymous'}\n`);
}
```

## isatty

```ts
function isatty(fd: number): boolean
```

Return whether a numeric file descriptor is attached to a terminal.

The descriptor is passed directly to the platform `isatty(3)` call. Use this
before enabling interactive behavior or ANSI-only output.

```ts
import { isatty } from 'fino:tty';

if (isatty(1)) {
  // stdout is an interactive terminal.
}
```

## stdinIsTTY

```ts
const stdinIsTTY
```

Whether standard input is attached to a terminal.

This value is computed once at module load. Prefer it for prompt policy; use
`isatty(0)` when code needs to re-check a replaced descriptor.

```ts
import { stdinIsTTY } from 'fino:tty';

if (!stdinIsTTY) {
  // Read from redirected input or use defaults.
}
```

## stdoutIsTTY

```ts
const stdoutIsTTY
```

Whether standard output is attached to a terminal.

This value is useful when deciding whether to render progress indicators or
plain machine-readable output.

```ts
import { stdoutIsTTY } from 'fino:tty';

const spinnerEnabled = stdoutIsTTY;
```

## stderrIsTTY

```ts
const stderrIsTTY
```

Whether standard error is attached to a terminal.

Diagnostics and progress output often go to stderr, so this can differ from
`stdoutIsTTY` when stdout is redirected.

```ts
import { stderrIsTTY } from 'fino:tty';

if (stderrIsTTY) {
  // Colored diagnostics are reasonable.
}
```

## readLine

```ts
async function readLine(prompt: string = ''): Promise<string | null>
```

Read one line from standard input, optionally writing a prompt first.

Returns `null` when input closes before any bytes are read.
A trailing newline is not included, and carriage returns are ignored so CRLF
input returns the same value as LF input. This low-level helper can block on
interactive stdin; higher-level code should prefer `PromptSession` for
non-interactive defaults.

```ts
import { readLine } from 'fino:tty';

const name = await readLine('Name: ');
if (name !== null) {
  // Use the entered line without the newline.
}
```

## writeStdout

```ts
async function writeStdout(text: string): Promise<void>
```

Write UTF-8 text to standard output.

The text is encoded as UTF-8 and written to fd 1 without adding a newline.
Await the promise to preserve ordering with other async stream writes.

```ts
import { writeStdout } from 'fino:tty';

await writeStdout('ready\n');
```

## writeStderr

```ts
async function writeStderr(text: string): Promise<void>
```

Write UTF-8 text to standard error.

The text is encoded as UTF-8 and written to fd 2 without adding a newline.
Use this for diagnostics that should not mix with stdout data.

```ts
import { writeStderr } from 'fino:tty';

await writeStderr('warning: config file missing\n');
```
