/**
 * fino:test/pty — drive a terminal app under a real pty and assert on its
 * emulated screen.
 *
 * `openPty()` allocates a pseudo-terminal pair, spawns a child process whose
 * stdin/stdout/stderr are the slave side, and feeds every byte the child
 * writes into a VT terminal emulator (`internal:tty/vt`). On macOS, the parent
 * retains the slave until close drains pending output, so child exit cannot
 * discard bytes before the emulator reads them. Tests interact with
 * the child as a user would — keystrokes, mouse clicks, window resizes — and
 * assert on the emulated screen: visible text, styled spans, tracked DEC
 * modes, the alternate screen, and cursor state.
 *
 * The child runs in a new session with its standard descriptors connected to
 * the slave. Raw mode, terminal geometry, and mouse reporting use that terminal;
 * `resize()` updates the geometry and explicitly signals the child with
 * `SIGWINCH`.
 *
 * All I/O is asynchronous: the master fd is read through the event loop, and
 * child exit is observed with kernel notifications (kqueue `EVFILT_PROC` on
 * macOS, `pidfd_open(2)` on Linux) — never by blocking the main thread.
 *
 * Useful references:
 *
 * - [POSIX terminal interface](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap11.html)
 * - [Linux pseudoterminals](https://man7.org/linux/man-pages/man7/pty.7.html)
 * - [POSIX terminal output draining](https://pubs.opengroup.org/onlinepubs/9799919799/functions/tcdrain.html)
 *
 * ```ts no_run
 * import { openPty } from 'fino:test/pty';
 * import { execPath } from 'fino:process';
 *
 * const pty = await openPty(execPath, ['app.ts'], { cols: 100, rows: 30 });
 * await pty.waitFor((term) => term.text().some((l) => l.includes('ready')));
 * await pty.sendKey('enter');
 * const code = await pty.waitExit();
 * await pty.close();
 * ```
 */
import { dlopen, Pointer } from 'fino:ffi';
import { os, env as baseEnv } from 'internal:process';
import { encodeUtf8 } from 'internal:encoding';
import { Terminal } from 'internal:tty/vt';
import { FdReader, FdWriter } from '../internal/stream.ts';
import * as loop from '../internal/runtime/loop.ts';
import {
  closeFd,
  setFdNonblocking,
  signalChild,
  spawnPosix,
  trySignalChild,
  watchChildExit,
} from '../internal/process/spawn.ts';

export type { Terminal };

const isLinux = os === 'linux';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const errnoFn = os === 'darwin' ? '__error' : '__errno_location';

const O_RDWR = 2;
const O_NOCTTY = isLinux ? 0x100 : 0x20000;
const TIOCSWINSZ = isLinux ? 0x5414 : 0x80087467;
const SIGKILL = 9;
const SIGTERM = 15;
const SIGWINCH = 28;
const CATCHABLE_SIGNALS = [1, 2, 3, 13, 14, 15, 28];

const lib = dlopen(LIBC, {
  posix_openpt: { parameters: ['i32'], result: 'i32' },
  tcdrain: { parameters: ['i32'], result: 'i32', async: true },
  grantpt: { parameters: ['i32'], result: 'i32' },
  unlockpt: { parameters: ['i32'], result: 'i32' },
  ptsname_r: { parameters: ['i32', 'buffer', 'usize'], result: 'i32' },
  open: { parameters: ['buffer', 'i32', 'i32'], result: 'i32', variadic: 2 },
  // ioctl is variadic; the trailing argument must use the variadic ABI.
  ioctl: { parameters: ['i32', 'u64', 'buffer'], result: 'i32', variadic: 2 },
  [errnoFn]: { parameters: [], result: 'pointer' },
});

function getErrno(): number {
  return Pointer.readI32(lib.symbols[errnoFn]!() as ArrayBuffer, 0);
}

function cstr(s: string): Uint8Array {
  const enc = encodeUtf8(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}

function slaveName(master: number): string {
  const buffer = new Uint8Array(4096);
  const rc = Number(lib.symbols.ptsname_r(master, buffer, buffer.byteLength));
  if (rc !== 0) throw new Error(`ptsname_r failed: errno ${rc}`);
  const end = buffer.indexOf(0);
  return new TextDecoder().decode(end < 0 ? buffer : buffer.subarray(0, end));
}

function setWinsize(fd: number, cols: number, rows: number): void {
  const winsize = new ArrayBuffer(8);
  const view = new DataView(winsize);
  view.setUint16(0, rows, true);
  view.setUint16(2, cols, true);
  const rc = Number(lib.symbols.ioctl(fd, TIOCSWINSZ, winsize));
  if (rc !== 0) throw new Error(`ioctl(TIOCSWINSZ) failed on fd ${fd}: errno ${getErrno()}`);
}

interface SpawnPtyOptions {
  cwd?: string;
  env?: Record<string, string>;
}

function spawnOnSlave(
  command: string,
  args: string[],
  slavePath: string,
  masterFd: number,
  parentSlaveFd: number,
  options: SpawnPtyOptions,
): number {
  const envVars = options.env ?? (baseEnv as Record<string, string>);
  const childEnv = envVars['TERM'] === undefined ? { ...envVars, TERM: 'xterm-256color' } : envVars;
  return spawnPosix({
    command,
    argv: [command, ...args],
    env: childEnv,
    cwd: options.cwd,
    defaultSignals: CATCHABLE_SIGNALS,
    createSession: true,
    closeOnExecDefault: true,
    configure(actions) {
      // Wire all standard descriptors to the slave in the new session.
      actions.open(0, slavePath, O_RDWR);
      actions.dup2(0, 1);
      actions.dup2(0, 2);
      if (!actions.closeFrom(3)) {
        actions.close(masterFd);
        actions.close(parentSlaveFd);
      }
    },
  });
}

/**
 * Options for {@link openPty}.
 *
 * ```ts no_run
 * import type { PtyOptions } from 'fino:test/pty';
 *
 * const opts: PtyOptions = { cols: 100, rows: 30, env: { TERM: 'xterm' } };
 * ```
 */
export interface PtyOptions {
  /** Initial terminal width in columns. Defaults to 80. */
  cols?: number;
  /** Initial terminal height in rows. Defaults to 24. */
  rows?: number;
  /** Working directory for the child process. */
  cwd?: string;
  /**
   * Environment for the child. Replaces rather than merges with the inherited
   * snapshot, matching `fino:process`. `TERM=xterm-256color` is appended when
   * the effective environment has no `TERM`.
   */
  env?: Record<string, string>;
  /**
   * How the emulator re-anchors content when {@link PtyHandle.resize} shrinks
   * the screen: `'cursor'` (default) scrolls only far enough to keep the
   * cursor visible, `'bottom'` always keeps the bottom rows.
   */
  anchor?: 'cursor' | 'bottom';
}

/**
 * A live pseudo-terminal session returned by {@link openPty}.
 *
 * The handle owns the master fd, the child process, and the screen emulator.
 * Always `close()` it — the method is idempotent and safe after exit.
 */
export interface PtyHandle {
  /** Emulated screen, updated as child output arrives. */
  readonly term: Terminal;
  /** Child process ID. */
  readonly pid: number;
  /** Write bytes to the master side, as if typed at the keyboard. */
  send(data: string | Uint8Array): Promise<void>;
  /**
   * Send a named key: `'enter'`, `'tab'`, `'escape'`, `'backspace'`,
   * `'up'`/`'down'`/`'right'`/`'left'` (CSI A/B/C/D), or `'ctrl+<letter>'`
   * for a control byte. Anything else is sent verbatim.
   */
  sendKey(key: string): Promise<void>;
  /**
   * Send an SGR-encoded mouse event at zero-based cell `(x, y)`. The wire
   * encoding uses 1-based coordinates, matching what terminals emit when SGR
   * mouse reporting (mode 1006) is active.
   */
  sendMouse(
    action: 'press' | 'release' | 'wheel-up' | 'wheel-down',
    x: number,
    y: number,
  ): Promise<void>;
  /**
   * Change the pty window size: `ioctl(TIOCSWINSZ)` on the master, `SIGWINCH`
   * to the child, and a matching resize of the emulated screen.
   */
  resize(cols: number, rows: number): void;
  /**
   * Resolve when `predicate(term)` becomes true. Polls the screen (~15ms) and
   * rejects after `timeout` ms (default 5000) with the current screen text in
   * the error message.
   */
  waitFor(predicate: (term: Terminal) => boolean, options?: { timeout?: number }): Promise<void>;
  /**
   * Resolve with the child's exit code once it terminates. A signal death
   * resolves to `128 + signo`. Rejects after `timeout` ms (default 5000).
   */
  waitExit(options?: { timeout?: number }): Promise<number>;
  /**
   * Terminate the session: `SIGTERM`, a ~500ms grace period, then `SIGKILL`
   * if needed; reap the child and close the master fd. Idempotent and safe
   * after the child has already exited.
   */
  close(): Promise<void>;
}

class Pty implements PtyHandle {
  #term: Terminal;
  #pid: number;
  #master: number;
  #retainedSlave: number | null;
  #reader: FdReader;
  #writer: FdWriter;
  #anchor: 'cursor' | 'bottom';
  #exit: ReturnType<typeof watchChildExit>;
  #exitStatus: Awaited<ReturnType<typeof watchChildExit>> | null = null;
  #pumpDone: Promise<void>;
  #closePromise: Promise<void> | null = null;
  #masterClosed = false;

  constructor(
    pid: number,
    master: number,
    term: Terminal,
    anchor: 'cursor' | 'bottom',
    retainedSlave: number | null,
  ) {
    this.#pid = pid;
    this.#master = master;
    this.#retainedSlave = retainedSlave;
    this.#term = term;
    this.#anchor = anchor;
    const closeMaster = () => {
      if (this.#masterClosed) return;
      this.#masterClosed = true;
      closeFd(master);
    };
    this.#reader = new FdReader(master, closeMaster);
    this.#writer = new FdWriter(master, closeMaster);
    this.#exit = watchChildExit(pid);
    void this.#exit
      .then((status) => {
        this.#exitStatus = status;
      })
      .catch(() => {});
    this.#pumpDone = this.#pump();
  }

  async #pump(): Promise<void> {
    try {
      while (true) {
        const result = await this.#reader.read();
        if (result.done) break;
        this.#term.write(result.value);
      }
    } catch (_) {}
  }

  get term(): Terminal {
    return this.#term;
  }

  get pid(): number {
    return this.#pid;
  }

  async send(data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
    await this.#writer.write(bytes);
    await this.#writer.flush();
  }

  sendKey(key: string): Promise<void> {
    const ctrl = /^ctrl\+([a-z])$/.exec(key);
    if (ctrl) return this.send(String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96));
    const named: Record<string, string> = {
      enter: '\r',
      tab: '\t',
      escape: '\x1b',
      backspace: '\x7f',
      up: '\x1b[A',
      down: '\x1b[B',
      right: '\x1b[C',
      left: '\x1b[D',
    };
    return this.send(named[key] ?? key);
  }

  sendMouse(
    action: 'press' | 'release' | 'wheel-up' | 'wheel-down',
    x: number,
    y: number,
  ): Promise<void> {
    const X = x + 1;
    const Y = y + 1;
    const seq =
      action === 'press'
        ? `\x1b[<0;${X};${Y}M`
        : action === 'release'
          ? `\x1b[<0;${X};${Y}m`
          : action === 'wheel-up'
            ? `\x1b[<64;${X};${Y}M`
            : `\x1b[<65;${X};${Y}M`;
    return this.send(seq);
  }

  resize(cols: number, rows: number): void {
    setWinsize(this.#master, cols, rows);
    if (this.#exitStatus === null) signalChild(this.#pid, SIGWINCH);
    this.#term.resize(cols, rows, this.#anchor);
  }

  async waitFor(
    predicate: (term: Terminal) => boolean,
    options?: { timeout?: number },
  ): Promise<void> {
    const timeoutMs = options?.timeout ?? 5000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (predicate(this.#term)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `waitFor timed out after ${timeoutMs}ms; screen:\n` + this.#term.text().join('\n'),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  async waitExit(options?: { timeout?: number }): Promise<number> {
    const timeoutMs = options?.timeout ?? 5000;
    const timer = loop.timeout(timeoutMs);
    const result = await Promise.race([
      this.#exit.then((status) => status),
      timer.then(() => null),
    ]);
    if (result === null) throw new Error(`waitExit timed out after ${timeoutMs}ms`);
    timer.cancel();
    return result.code ?? 128 + (result.signal ?? 0);
  }

  close(): Promise<void> {
    if (this.#closePromise === null) this.#closePromise = this.#doClose();
    return this.#closePromise;
  }

  async #doClose(): Promise<void> {
    if (this.#exitStatus === null) {
      trySignalChild(this.#pid, SIGTERM);
      const grace = loop.timeout(500);
      const exited = await Promise.race([this.#exit.then(() => true), grace.then(() => false)]);
      if (exited) {
        grace.cancel();
      } else {
        trySignalChild(this.#pid, SIGKILL);
        await this.#exit;
      }
    }
    if (this.#retainedSlave !== null) {
      const slave = this.#retainedSlave;
      this.#retainedSlave = null;
      try {
        // Keep the slave open until the pump consumes its final output. Native
        // tcdrain waits on a blocking-pool thread, leaving the Realm free to read.
        await lib.symbols.tcdrain(slave);
      } finally {
        closeFd(slave);
      }
    }
    // Once every slave descriptor is closed, EOF becomes visible on the
    // master; wait briefly for the pump to drain before closing the fd so no
    // read is left pending against a closed descriptor.
    const drain = loop.timeout(250);
    await Promise.race([this.#pumpDone.then(() => drain.cancel()), drain]);
    try {
      await this.#writer.close();
    } catch (_) {}
    try {
      await this.#reader.close();
    } catch (_) {}
    if (!this.#masterClosed) {
      this.#masterClosed = true;
      closeFd(this.#master);
    }
  }
}

/**
 * Open a pseudo-terminal and spawn `command` on its slave side.
 *
 * The returned {@link PtyHandle} exposes the child's screen as a live VT
 * emulator plus input, resize, exit, and teardown primitives. The child gets
 * a fresh session with its standard streams connected to the slave, sized to
 * `cols`x`rows` before it starts.
 *
 * ```ts no_run
 * import { openPty } from 'fino:test/pty';
 *
 * const pty = await openPty('/bin/sh', ['-i']);
 * await pty.send('echo hi\r');
 * await pty.waitFor((term) => term.text().some((l) => l.includes('hi')));
 * await pty.close();
 * ```
 */
export async function openPty(
  command: string,
  args: string[] = [],
  options: PtyOptions = {},
): Promise<PtyHandle> {
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
    throw new Error(`invalid pty size ${cols}x${rows}`);
  }
  const master = Number(lib.symbols.posix_openpt(O_RDWR | O_NOCTTY));
  if (master < 0) throw new Error(`posix_openpt failed: errno ${getErrno()}`);
  let retainedSlave: number | null = null;
  try {
    if (Number(lib.symbols.grantpt(master)) !== 0) {
      throw new Error(`grantpt failed: errno ${getErrno()}`);
    }
    if (Number(lib.symbols.unlockpt(master)) !== 0) {
      throw new Error(`unlockpt failed: errno ${getErrno()}`);
    }
    // ptsname() uses process-global static storage, which races when separate
    // test Realms open PTYs concurrently. ptsname_r() writes into storage
    // owned by this call instead on both Linux and macOS.
    const slavePath = slaveName(master);
    // macOS masters reject winsize ioctls until a slave is open, so the
    // initial size is set through a parent-side slave fd. Linux can release
    // it after spawn. macOS needs it until the PTY pump drains final output:
    // closing the last slave descriptor otherwise discards unread bytes.
    const slaveFd = Number(lib.symbols.open(cstr(slavePath), O_RDWR | O_NOCTTY, 0));
    if (slaveFd < 0) throw new Error(`open('${slavePath}') failed: errno ${getErrno()}`);
    let pid: number;
    let spawned = false;
    try {
      setWinsize(slaveFd, cols, rows);
      pid = spawnOnSlave(command, args, slavePath, master, slaveFd, options);
      spawned = true;
    } finally {
      if (isLinux || !spawned) closeFd(slaveFd);
      else retainedSlave = slaveFd;
    }
    setFdNonblocking(master);
    const term = new Terminal({ cols, rows });
    return new Pty(pid, master, term, options.anchor ?? 'cursor', retainedSlave);
  } catch (err) {
    if (retainedSlave !== null) closeFd(retainedSlave);
    closeFd(master);
    throw err;
  }
}
