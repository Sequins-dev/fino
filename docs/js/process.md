# process

fino:process - process information and child process spawning.

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
pipes, `chdir` to set the working directory, and close file descriptors -
all without the `posix_spawn` attribute machinery. The child side of the
fork runs between the `childPid === 0` branch and the `execve` call; any
failure in that branch causes `_exit(127)` (the shell convention for
"command not found").

## Pipe lifecycle

Three `pipe(2)` calls create six file descriptors before the fork:

  stdin:  [stdinR  -> child stdin,  stdinW  -> parent Writer]
  stdout: [stdoutR -> parent Reader, stdoutW -> child stdout]
  stderr: [stderrR -> parent Reader, stderrW -> child stderr]

After the fork, each process immediately closes the ends it doesn't own.
The parent-side fds are set to O_NONBLOCK so they can be used with the
event loop. The child-side fds are left blocking - they run inside
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
  - bits [6:0] = 0x00 -> exited normally; exit code is bits [15:8]
  - bits [6:0] != 0x00 and != 0x7f -> killed by signal; signal is bits [6:0]
  - bits [6:0] = 0x7f -> stopped (WIFSTOPPED) - we ignore this case

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

```ts
import { Process, type ProcessOptions } from 'fino:process';

const opts: ProcessOptions = { cwd: '/tmp', env: { PATH: '/usr/bin' } };
const proc = new Process('/usr/bin/env', [], opts);
```

### cwd

```ts
cwd?: string
```

Working directory for the child process.

When omitted, the child inherits the parent's current working directory.
If the directory cannot be entered after fork, the child exits with the
same failure path as other exec setup errors.

```ts
import type { ProcessOptions } from 'fino:process';

const opts: ProcessOptions = { cwd: '/srv/app' };
```

### env

```ts
env?: Record<string, string>
```

Environment passed to `execve`.

When omitted, the runtime startup environment snapshot is used. Supplying
this object replaces, rather than merges with, the inherited environment.

```ts
import type { ProcessOptions } from 'fino:process';

const opts: ProcessOptions = { env: { PATH: '/usr/bin', NODE_ENV: 'test' } };
```

## WaitResult

```ts
interface WaitResult {
```

Exit status returned by `Process.wait`.

Exactly one of `code` or `signal` is usually non-null. Both can be `null` for
status states the decoder does not currently expose, such as stopped
children.

```ts
import type { WaitResult } from 'fino:process';

const result: WaitResult = { code: 0, signal: null };
```

### code

```ts
code: number | null
```

Numeric exit code for a normally exited child.

The value is `null` when the child was killed by a signal or when the
status could not be decoded as a normal exit.

```ts
import { Process } from 'fino:process';

const result = await new Process('/bin/true', []).wait();
console.log(result.code);
```

### signal

```ts
signal: number | null
```

Signal number that terminated the child.

The value is `null` for normal exits. Use exported signal constants such as
`SIGTERM` when comparing known signals.

```ts
import { Process, SIGTERM } from 'fino:process';

const result = await new Process('/bin/sleep', ['1']).wait();
console.log(result.signal === SIGTERM);
```

## pid

```ts
const pid
```

Current process ID.

This value is read once from `getpid()` during module evaluation and is
stable for the lifetime of the process.

```ts
import { pid } from 'fino:process';

console.log(`running as ${pid}`);
```

## ppid

```ts
const ppid
```

Parent process ID.

This value is read from `getppid()` during module evaluation. It may not
reflect later parent changes caused by reparenting after startup.

```ts
import { ppid } from 'fino:process';

console.log(`parent ${ppid}`);
```

## exit

```ts
function exit(code: number = 0): never
```

Terminate the current process immediately.
Flushes buffered stdout/stderr before exiting so pending console output is
not lost. Uses `_exit` (not `exit(3)`) after the flush to avoid running C
atexit handlers.

This function never returns. Errors during stream flushing are swallowed so
the process still exits.

```ts
import { exit } from 'fino:process';

exit(0);
```

## cwd

```ts
function cwd(): string
```

Return the current working directory.

Throws if `getcwd(2)` fails. The returned string is decoded as UTF-8 from a
fixed-size buffer.

```ts
import { cwd } from 'fino:process';

console.log(cwd());
```

## chdir

```ts
function chdir(path: string): void
```

Change the current working directory. Throws on failure.

The change affects the whole current process and therefore all realms in the
process that consult process cwd. Use absolute paths for predictable results.

```ts
import { chdir, cwd } from 'fino:process';

chdir('/tmp');
console.log(cwd());
```

## kill

```ts
function kill(targetPid: number, signal: number): void
```

Send a signal to a process. Throws if the syscall fails.

The target may be the current process, a child, or any process permitted by
the operating system. Passing an invalid PID or signal causes an error.

```ts
import { kill, pid, SIGTERM } from 'fino:process';

kill(pid, SIGTERM);
```

## stdin

```ts
function stdin(): FdReader
```

Returns a Reader for the current process's stdin (fd 0).
Sets the fd to non-blocking mode on first call.

The same `FdReader` instance is returned on subsequent calls. The call can
throw if changing fd 0 to non-blocking mode fails.

```ts
import { stdin } from 'fino:process';

for await (const chunk of stdin()) console.log(chunk.byteLength);
```

## stdout

```ts
function stdout(): FdWriter
```

Returns a Writer for the current process's stdout (fd 1).
Sets the fd to non-blocking mode on first call.

The same `FdWriter` instance is returned on subsequent calls. Use
`flushSync()` before abrupt exits when output ordering matters.

```ts
import { stdout } from 'fino:process';

await stdout().write(new TextEncoder().encode('hello\n'));
```

## stderr

```ts
function stderr(): FdWriter
```

Returns a Writer for the current process's stderr (fd 2).
Sets the fd to non-blocking mode on first call.

The same `FdWriter` instance is returned on subsequent calls. The call can
throw if changing fd 2 to non-blocking mode fails.

```ts
import { stderr } from 'fino:process';

await stderr().write(new TextEncoder().encode('error\n'));
```

## SIGHUP

```ts
const SIGHUP
```

Hangup signal number.

```ts
import { SIGHUP, signal } from 'fino:process';

signal('SIGHUP').subscribe(({ signo }) => console.log(signo === SIGHUP));
```

## SIGINT

```ts
const SIGINT
```

Interrupt signal number.

```ts
import { SIGINT, signal } from 'fino:process';

signal('SIGINT').subscribe(({ signo }) => console.log(signo === SIGINT));
```

## SIGQUIT

```ts
const SIGQUIT
```

Quit signal number.

```ts
import { SIGQUIT } from 'fino:process';

console.log(SIGQUIT);
```

## SIGKILL

```ts
const SIGKILL
```

Kill signal number.

`SIGKILL` cannot be caught or handled by `signal()`, but it can be sent with
`kill()` where the operating system permits it.

```ts
import { kill, pid, SIGKILL } from 'fino:process';

kill(pid, SIGKILL);
```

## SIGUSR1

```ts
const SIGUSR1
```

User-defined signal 1 number.

The numeric value is platform-aware: Linux and Darwin use different values.

```ts
import { SIGUSR1, signal } from 'fino:process';

signal('SIGUSR1').subscribe(({ signo }) => console.log(signo === SIGUSR1));
```

## SIGUSR2

```ts
const SIGUSR2
```

User-defined signal 2 number.

The numeric value is platform-aware: Linux and Darwin use different values.

```ts
import { SIGUSR2, signal } from 'fino:process';

signal('SIGUSR2').subscribe(({ signo }) => console.log(signo === SIGUSR2));
```

## SIGPIPE

```ts
const SIGPIPE
```

Broken pipe signal number.

```ts
import { SIGPIPE } from 'fino:process';

console.log(SIGPIPE);
```

## SIGALRM

```ts
const SIGALRM
```

Alarm signal number.

```ts
import { SIGALRM, signal } from 'fino:process';

signal('SIGALRM').subscribe(({ signal }) => console.log(signal));
```

## SIGTERM

```ts
const SIGTERM
```

Termination signal number.

This is the default signal used by `Process.kill()`.

```ts
import { Process, SIGTERM } from 'fino:process';

const proc = new Process('/bin/sleep', ['10']);
proc.kill(SIGTERM);
```

## SIGCHLD

```ts
const SIGCHLD
```

Child-status signal number.

The numeric value is platform-aware. This signal is delivered when child
process status changes.

```ts
import { SIGCHLD, signal } from 'fino:process';

signal('SIGCHLD').subscribe(({ signo }) => console.log(signo === SIGCHLD));
```

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
  handle.dispose();
});

// Later: handle.dispose() to unsubscribe
```

Unknown signal names throw. The returned topic is shared by signal name, so
multiple calls subscribe to the same event source.

## Process

```ts
class Process {
```

Spawn a child process with piped stdin, stdout, and stderr.

The child is launched via fork()+execve(). The parent receives:
- `stdin` - a Writer to send bytes to the child's stdin
- `stdout` - a Reader to receive bytes from the child's stdout
- `stderr` - a Reader to receive bytes from the child's stderr

Construction throws if pipe creation, fork, or parent-side non-blocking setup
fails. If `execve` fails in the child, the child exits with status 127.

```ts
import { Process } from 'fino:process';

const proc = new Process('/usr/bin/cat', []);
await proc.stdin.write(new TextEncoder().encode('hello\n'));
proc.stdin.close();
for await (const chunk of proc.stdout) {
  console.log(new TextDecoder().decode(chunk));
}
const { code } = await proc.wait();
```

### constructor

```ts
constructor(command: string, cmdArgs: string[], opts?: ProcessOptions)
```

Spawn a child process.

The command should be an executable path accepted by `execve(2)`. Arguments
exclude `argv[0]`; the constructor prepends `command`. `opts.env` replaces
the inherited environment snapshot, and `opts.cwd` is applied in the child
before `execve`.

```ts
import { Process } from 'fino:process';

const proc = new Process('/bin/echo', ['hello'], { cwd: '/tmp' });
const result = await proc.wait();
```

### stdin

```ts
get stdin()
```

Writer connected to the child's stdin.

Close this writer when no more input will be sent so programs waiting for
EOF can exit. The writer is backed by a non-blocking pipe fd.

```ts
import { Process } from 'fino:process';

const proc = new Process('/usr/bin/cat', []);
await proc.stdin.write(new TextEncoder().encode('hello\n'));
proc.stdin.close();
```

### stdout

```ts
get stdout()
```

Reader connected to the child's stdout.

The reader yields `Uint8Array` chunks until the child closes stdout. It is
backed by a non-blocking pipe fd.

```ts
import { Process } from 'fino:process';

const proc = new Process('/bin/echo', ['hello']);
for await (const chunk of proc.stdout) console.log(chunk.byteLength);
```

### stderr

```ts
get stderr()
```

Reader connected to the child's stderr.

The reader yields `Uint8Array` chunks until the child closes stderr. Drain
it when running commands that may write enough stderr to fill the pipe.

```ts
import { Process } from 'fino:process';

const proc = new Process('/bin/sh', ['-c', 'echo error >&2']);
for await (const chunk of proc.stderr) console.log(chunk.byteLength);
```

### pid

```ts
get pid()
```

Child process ID returned by `fork()`.

The PID is available immediately after construction and remains the same
after the child exits.

```ts
import { Process } from 'fino:process';

const proc = new Process('/bin/sleep', ['1']);
console.log(proc.pid);
```

### wait

```ts
async wait(): Promise<WaitResult>
```

Wait for the child process to exit using kernel notifications.

- macOS: registers EVFILT_PROC via kqueue - zero-latency, zero-CPU wait.
- Linux: opens a pidfd via pidfd_open(2) and polls it with loop.readable()
         - the pidfd becomes readable the moment the child exits.

After the kernel signals exit, a single waitpid(pid, 0) reaps the zombie.

Calling `wait()` more than once is not supported because the first call
reaps the process. The promise rejects if the platform wait primitive
cannot be created.

```ts
import { Process } from 'fino:process';

const proc = new Process('/bin/true', []);
const result = await proc.wait();
console.log(result.code);
```

### kill

```ts
kill(signal: number = _SIGTERM): void
```

Send a signal to the child process.

Defaults to `SIGTERM`. This method does not wait for the child to exit and
does not currently throw when the underlying `kill(2)` call fails.

```ts
import { Process, SIGTERM } from 'fino:process';

const proc = new Process('/bin/sleep', ['10']);
proc.kill(SIGTERM);
```
