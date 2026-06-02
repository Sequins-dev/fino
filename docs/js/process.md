# process

fino:process — process information and child process spawning.

This module combines two concerns: static process metadata (pid, cwd, argv,
env, etc.) and the `Process` class for spawning child processes with piped
stdio. The static metadata comes from `internal:process`, which is a Rust
synthetic module injected at compile time with values that would be awkward
to retrieve from JS (e.g. `execPath` needs the Rust binary's own path, and
`env` needs to snapshot the environ at startup).

**Why fork+execve instead of posix_spawn?**
`fork(2)` + `execve(2)` is the classic UNIX child-process primitive. We use
it here rather than `posix_spawn` because it gives us full control over the
child's environment between fork and exec: we can call `dup2` to wire up
pipes, `chdir` to set the working directory, and close file descriptors —
all without the `posix_spawn` attribute machinery. The child side of the
fork runs between the `childPid === 0` branch and the `execve` call; any
failure in that branch causes `_exit(127)` (the shell convention for
"command not found").

## Pipe lifecycle

Three `pipe(2)` calls create six file descriptors before the fork:

  stdin:  [stdinR  → child stdin,  stdinW  → parent Writer]
  stdout: [stdoutR → parent Reader, stdoutW → child stdout]
  stderr: [stderrR → parent Reader, stderrW → child stderr]

After the fork, each process immediately closes the ends it doesn't own.
The parent-side fds are set to O_NONBLOCK so they can be used with the
event loop. The child-side fds are left blocking — they run inside
`execve`'d code that doesn't know about fino's event loop.

## buildCStringArray and GC lifetime

`execve(2)` takes a `char**` argv and a `char**` envp. We build these from
JS strings by encoding each string to a null-terminated UTF-8 buffer and
placing pointers to those buffers into a pointer array. The tricky part is
GC lifetime: if the individual string buffers (`bufs`) are collected before
`execve` runs, the pointer array will contain dangling pointers. To prevent
this, `buildCStringArray` returns both the pointer array and the `bufs`
array; callers keep `bufs` as a local variable so it remains in scope (and
therefore kept alive by the GC) through the `execve` call.

## Waiting for the child process

`Process.wait()` uses kernel-native mechanisms to avoid polling:

- **macOS**: `loop.proc(lp, pid)` registers an EVFILT_PROC kevent. kqueue
  delivers a NOTE_EXIT event the instant the child changes state, with zero
  CPU overhead between fork and exit.

- **Linux**: `pidfd_open(2)` (syscall 434) returns a file descriptor that
  becomes readable when the child exits. We poll it with `loop.readable()`
  just like any other fd, then close the pidfd. This is the modern
  alternative to `waitpid(WNOHANG)` polling loops.

In both cases, after the kernel signals exit, a single `waitpid(pid, 0)` is
called to reap the zombie and retrieve the exit status. The status integer
is decoded using the POSIX WIFEXITED / WIFSIGNALED macros inlined as bit
operations.

## Exit status decoding

`waitpid` fills an `int` status word with the following encoding:
  - bits [6:0] = 0x00 → exited normally; exit code is bits [15:8]
  - bits [6:0] ≠ 0x00 and ≠ 0x7f → killed by signal; signal is bits [6:0]
  - bits [6:0] = 0x7f → stopped (WIFSTOPPED) — we ignore this case

```ts
import { pid, cwd, argv } from 'fino:process';
console.log(`PID ${pid}, CWD ${cwd()}, args: ${argv.join(' ')}`);
```

```ts
import { Process } from 'fino:process';

const proc = new Process('/bin/echo', ['hello world']);
for await (const chunk of proc.stdout) {
  console.log(new TextDecoder().decode(chunk));
}
const { code } = await proc.wait();
```

## ProcessOptions

```ts
interface ProcessOptions {
```

Options for spawning a child process.

### cwd

```ts
cwd?: string
```

### env

```ts
env?: Record<string, string>
```

## WaitResult

```ts
interface WaitResult {
```

Exit status returned by `Process.wait`.

### code

```ts
code: number | null
```

### signal

```ts
signal: number | null
```

## pid

```ts
const pid
```

Current process ID.

## ppid

```ts
const ppid
```

Parent process ID.

## exit

```ts
function exit(code: number = 0): never
```

Terminate the current process immediately.
Flushes buffered stdout/stderr before exiting so pending console output is
not lost. Uses `_exit` (not `exit(3)`) after the flush to avoid running C
atexit handlers.

## cwd

```ts
function cwd(): string
```

Return the current working directory.

## chdir

```ts
function chdir(path: string): void
```

Change the current working directory. Throws on failure.

## kill

```ts
function kill(targetPid: number, signal: number): void
```

Send a signal to a process. Throws if the syscall fails.

## stdin

```ts
function stdin(): FdReader
```

Returns a Reader for the current process's stdin (fd 0).
Sets the fd to non-blocking mode on first call.

## stdout

```ts
function stdout(): FdWriter
```

Returns a Writer for the current process's stdout (fd 1).
Sets the fd to non-blocking mode on first call.

## stderr

```ts
function stderr(): FdWriter
```

Returns a Writer for the current process's stderr (fd 2).
Sets the fd to non-blocking mode on first call.

## SIGHUP

```ts
const SIGHUP
```

Signal numbers (POSIX, platform-aware for platform-divergent signals).

## SIGINT

```ts
const SIGINT
```

Interrupt signal number.

## SIGQUIT

```ts
const SIGQUIT
```

Quit signal number.

## SIGKILL

```ts
const SIGKILL
```

Kill signal number.

## SIGUSR1

```ts
const SIGUSR1
```

User-defined signal 1 number.

## SIGUSR2

```ts
const SIGUSR2
```

User-defined signal 2 number.

## SIGPIPE

```ts
const SIGPIPE
```

Broken pipe signal number.

## SIGALRM

```ts
const SIGALRM
```

Alarm signal number.

## SIGTERM

```ts
const SIGTERM
```

Termination signal number.

## SIGCHLD

```ts
const SIGCHLD
```

Child-status signal number.

## signal

```ts
function signal(name: string): Topic
```

Subscribe to a POSIX signal via a Topic.

Returns a named Topic (`'process:<NAME>'`) that publishes `{ signal, signo }`
each time the signal is delivered. On the first call for a given signal name,
the signal is registered with the event loop so that delivery does not kill
the process. Subsequent calls return the same topic without re-registering.

```ts
import { signal } from './process.mts';

const handle = signal('SIGTERM').subscribe(({ signal }) => {
  console.log(`Received ${signal}, shutting down...`);
  process.exit(0);
});

// Later: handle.dispose() to unsubscribe
```

## Process

```ts
class Process {
```

Spawn a child process with piped stdin, stdout, and stderr.

The child is launched via fork()+execve(). The parent receives:
- `stdin`  — a Writer to send bytes to the child's stdin
- `stdout` — a Reader to receive bytes from the child's stdout
- `stderr` — a Reader to receive bytes from the child's stderr

```ts
const proc = new Process('/usr/bin/cat', []);
await proc.stdin.write(encodeUtf8('hello\n'));
proc.stdin.close();
for await (const chunk of proc.stdout) {
  console.log(decodeUtf8(chunk));
}
const { code } = await proc.wait();
```

### constructor

```ts
constructor(command: string, cmdArgs: string[], opts?: ProcessOptions)
```

### stdin

```ts
get stdin()
```

Write bytes to the child's stdin.

### stdout

```ts
get stdout()
```

Read bytes from the child's stdout.

### stderr

```ts
get stderr()
```

Read bytes from the child's stderr.

### pid

```ts
get pid()
```

The child process ID.

### wait

```ts
async wait(): Promise<WaitResult>
```

Wait for the child process to exit using kernel notifications.

- macOS: registers EVFILT_PROC via kqueue — zero-latency, zero-CPU wait.
- Linux: opens a pidfd via pidfd_open(2) and polls it with loop.readable()
         — the pidfd becomes readable the moment the child exits.

After the kernel signals exit, a single waitpid(pid, 0) reaps the zombie.

### kill

```ts
kill(signal: number = _SIGTERM): void
```

Send a signal to the child process.
