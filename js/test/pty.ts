/**
 * fino:test/pty — drive a terminal app under a real pty and assert on its
 * emulated screen.
 *
 * `openPty()` allocates a pseudo-terminal pair, spawns a child process whose
 * stdin/stdout/stderr are the slave side, and feeds every byte the child
 * writes into a VT terminal emulator (`internal:tty/vt`). Tests interact with
 * the child as a user would — keystrokes, mouse clicks, window resizes — and
 * assert on the emulated screen: visible text, styled spans, tracked DEC
 * modes, the alternate screen, and cursor state.
 *
 * The child runs with the slave as its controlling terminal (a new session is
 * created via `POSIX_SPAWN_SETSID`, and opening the slave binds it), so raw
 * mode, `ioctl(TIOCGWINSZ)`, mouse reporting, and `SIGWINCH` all behave as
 * they do in a real terminal.
 *
 * All I/O is asynchronous: the master fd is read through the event loop, and
 * child exit is observed with kernel notifications (kqueue `EVFILT_PROC` on
 * macOS, `pidfd_open(2)` on Linux) — never by blocking the main thread.
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

export type { Terminal };

const isLinux = os === 'linux';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const errnoFn = os === 'darwin' ? '__error' : '__errno_location';

const O_RDWR = 2;
const O_NOCTTY = isLinux ? 0x100 : 0x20000;
const O_NONBLOCK = isLinux ? 2048 : 4;
const F_GETFL = 3;
const F_SETFL = 4;
const TIOCSWINSZ = isLinux ? 0x5414 : 0x80087467;
const POSIX_SPAWN_SETSIGDEF = 0x0004;
const POSIX_SPAWN_SETSIGMASK = 0x0008;
const POSIX_SPAWN_SETSID = isLinux ? 0x80 : 0x0400;
const SIGKILL = 9;
const SIGTERM = 15;
const SIGWINCH = 28;
const SYS_PIDFD_OPEN = 434n;
const POSIX_SPAWN_FILE_ACTIONS_BYTES = 512;
const POSIX_SPAWN_ATTR_BYTES = 512;
const SIGSET_BYTES = 128;
const CATCHABLE_SIGNALS = [1, 2, 3, 13, 14, 15, 28];

const lib = dlopen(LIBC, {
  posix_openpt: { parameters: ['i32'], result: 'i32' },
  grantpt: { parameters: ['i32'], result: 'i32' },
  unlockpt: { parameters: ['i32'], result: 'i32' },
  ptsname: { parameters: ['i32'], result: 'pointer' },
  open: { parameters: ['buffer', 'i32', 'i32'], result: 'i32', variadic: 2 },
  // fcntl and ioctl are variadic; the trailing argument must be marshaled
  // with the variadic ABI (on-stack on macOS arm64) or the callee reads
  // garbage and fails with EFAULT.
  fcntl: { parameters: ['i32', 'i32', 'i32'], result: 'i32', variadic: 2 },
  close: { parameters: ['i32'], result: 'i32' },
  ioctl: { parameters: ['i32', 'u64', 'buffer'], result: 'i32', variadic: 2 },
  kill: { parameters: ['i32', 'i32'], result: 'i32' },
  waitpid: { parameters: ['i32', 'buffer', 'i32'], result: 'i32' },
  syscall: { parameters: ['i64', 'i64', 'i64'], result: 'i64' },
  posix_spawnp: {
    parameters: ['buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'],
    result: 'i32',
  },
  posix_spawn_file_actions_init: { parameters: ['buffer'], result: 'i32' },
  posix_spawn_file_actions_destroy: { parameters: ['buffer'], result: 'i32' },
  posix_spawn_file_actions_addopen: {
    parameters: ['buffer', 'i32', 'buffer', 'i32', 'i32'],
    result: 'i32',
  },
  posix_spawn_file_actions_adddup2: {
    parameters: ['buffer', 'i32', 'i32'],
    result: 'i32',
  },
  posix_spawn_file_actions_addclose: {
    parameters: ['buffer', 'i32'],
    result: 'i32',
  },
  posix_spawnattr_init: { parameters: ['buffer'], result: 'i32' },
  posix_spawnattr_destroy: { parameters: ['buffer'], result: 'i32' },
  posix_spawnattr_setflags: { parameters: ['buffer', 'u16'], result: 'i32' },
  posix_spawnattr_setsigdefault: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  posix_spawnattr_setsigmask: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  [errnoFn]: { parameters: [], result: 'pointer' },
});

const spawnChdirLib = (() => {
  try {
    return dlopen(LIBC, {
      posix_spawn_file_actions_addchdir_np: {
        parameters: ['buffer', 'buffer'],
        result: 'i32',
      },
    });
  } catch (_) {
    return null;
  }
})();

function getErrno(): number {
  return Pointer.readI32(lib.symbols[errnoFn]!() as ArrayBuffer, 0);
}

function cstr(s: string): Uint8Array {
  const enc = encodeUtf8(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}

function readCStr(ptr: ArrayBuffer): string {
  const bytes: number[] = [];
  let i = 0;
  while (true) {
    const b = Pointer.readU8(ptr, i);
    if (b === 0) break;
    bytes.push(b);
    i++;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// Callers must keep `bufs` alive through the spawn call so the GC does not
// reclaim the string memory the pointer array refers to.
function buildCStringArray(strings: string[]): {
  ptrBuf: ArrayBuffer;
  bufs: Uint8Array[];
} {
  const bufs = strings.map(cstr);
  const ptrBuf = new ArrayBuffer((bufs.length + 1) * 8);
  const view = new DataView(ptrBuf);
  for (let i = 0; i < bufs.length; i++) {
    view.setBigUint64(i * 8, Pointer.addr(bufs[i]!), true);
  }
  return { ptrBuf, bufs };
}

function setNonblocking(fd: number): void {
  const flags = Number(lib.symbols.fcntl(fd, F_GETFL, 0));
  if (flags < 0) throw new Error(`fcntl(F_GETFL) failed on fd ${fd}: errno ${getErrno()}`);
  const rc = Number(lib.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK));
  if (rc < 0) throw new Error(`fcntl(F_SETFL) failed on fd ${fd}: errno ${getErrno()}`);
}

function setWinsize(fd: number, cols: number, rows: number): void {
  const winsize = new ArrayBuffer(8);
  const view = new DataView(winsize);
  view.setUint16(0, rows, true);
  view.setUint16(2, cols, true);
  const rc = Number(lib.symbols.ioctl(fd, TIOCSWINSZ, winsize));
  if (rc !== 0) throw new Error(`ioctl(TIOCSWINSZ) failed on fd ${fd}: errno ${getErrno()}`);
}

function addSignalToSet(set: ArrayBuffer, signo: number): void {
  const bit = signo - 1;
  const bytes = new Uint8Array(set);
  bytes[bit >> 3]! |= 1 << (bit & 7);
}

function spawnCheck(rc: number, action: string): void {
  if (rc !== 0) throw new Error(`${action} failed: errno ${rc}`);
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
  const envStrings = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
  if (envVars['TERM'] === undefined) envStrings.push('TERM=xterm-256color');
  const { ptrBuf: argvBuf, bufs: argvBufs } = buildCStringArray([command, ...args]);
  const { ptrBuf: envpBuf, bufs: envpBufs } = buildCStringArray(envStrings);
  const commandBuf = cstr(command);
  const slaveBuf = cstr(slavePath);
  const cwdBuf = options.cwd != null ? cstr(options.cwd) : null;

  const actions = new ArrayBuffer(POSIX_SPAWN_FILE_ACTIONS_BYTES);
  const attrs = new ArrayBuffer(POSIX_SPAWN_ATTR_BYTES);
  const sigDefault = new ArrayBuffer(SIGSET_BYTES);
  const sigMask = new ArrayBuffer(SIGSET_BYTES);
  for (const signo of CATCHABLE_SIGNALS) addSignalToSet(sigDefault, signo);

  let actionsInitialized = false;
  let attrsInitialized = false;
  try {
    spawnCheck(
      Number(lib.symbols.posix_spawn_file_actions_init(actions)),
      'posix_spawn_file_actions_init',
    );
    actionsInitialized = true;
    spawnCheck(Number(lib.symbols.posix_spawnattr_init(attrs)), 'posix_spawnattr_init');
    attrsInitialized = true;
    spawnCheck(
      Number(lib.symbols.posix_spawnattr_setsigdefault(attrs, sigDefault)),
      'posix_spawnattr_setsigdefault',
    );
    spawnCheck(
      Number(lib.symbols.posix_spawnattr_setsigmask(attrs, sigMask)),
      'posix_spawnattr_setsigmask',
    );
    spawnCheck(
      Number(
        lib.symbols.posix_spawnattr_setflags(
          attrs,
          POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK,
        ),
      ),
      'posix_spawnattr_setflags',
    );
    // The child is a fresh session (SETSID above), so this open of the slave
    // — the first tty it opens, without O_NOCTTY — makes the pty its
    // controlling terminal on both macOS and Linux.
    spawnCheck(
      Number(lib.symbols.posix_spawn_file_actions_addopen(actions, 0, slaveBuf, O_RDWR, 0)),
      'posix_spawn_file_actions_addopen(slave)',
    );
    spawnCheck(
      Number(lib.symbols.posix_spawn_file_actions_adddup2(actions, 0, 1)),
      'posix_spawn_file_actions_adddup2(stdout)',
    );
    spawnCheck(
      Number(lib.symbols.posix_spawn_file_actions_adddup2(actions, 0, 2)),
      'posix_spawn_file_actions_adddup2(stderr)',
    );
    spawnCheck(
      Number(lib.symbols.posix_spawn_file_actions_addclose(actions, masterFd)),
      'posix_spawn_file_actions_addclose(master)',
    );
    spawnCheck(
      Number(lib.symbols.posix_spawn_file_actions_addclose(actions, parentSlaveFd)),
      'posix_spawn_file_actions_addclose(parent slave)',
    );
    if (cwdBuf !== null) {
      if (spawnChdirLib === null) {
        throw new Error(
          'cwd option requires posix_spawn_file_actions_addchdir_np, which is unavailable on this platform',
        );
      }
      spawnCheck(
        Number(spawnChdirLib.symbols.posix_spawn_file_actions_addchdir_np(actions, cwdBuf)),
        'posix_spawn_file_actions_addchdir_np',
      );
    }
    const pidBuf = new ArrayBuffer(4);
    const rc = Number(
      lib.symbols.posix_spawnp(pidBuf, commandBuf, actions, attrs, argvBuf, envpBuf),
    );
    if (rc !== 0) throw new Error(`posix_spawnp('${command}') failed: errno ${rc}`);
    void argvBufs;
    void envpBufs;
    return new DataView(pidBuf).getInt32(0, true);
  } finally {
    if (actionsInitialized) lib.symbols.posix_spawn_file_actions_destroy(actions);
    if (attrsInitialized) lib.symbols.posix_spawnattr_destroy(attrs);
  }
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

interface ExitStatus {
  code: number | null;
  signal: number | null;
}

class Pty implements PtyHandle {
  #term: Terminal;
  #pid: number;
  #master: number;
  #reader: FdReader;
  #writer: FdWriter;
  #anchor: 'cursor' | 'bottom';
  #exit: Promise<ExitStatus>;
  #exitStatus: ExitStatus | null = null;
  #pumpDone: Promise<void>;
  #closePromise: Promise<void> | null = null;
  #masterClosed = false;

  constructor(pid: number, master: number, term: Terminal, anchor: 'cursor' | 'bottom') {
    this.#pid = pid;
    this.#master = master;
    this.#term = term;
    this.#anchor = anchor;
    const closeMaster = () => {
      if (this.#masterClosed) return;
      this.#masterClosed = true;
      lib.symbols.close(master);
    };
    this.#reader = new FdReader(master, closeMaster);
    this.#writer = new FdWriter(master, closeMaster);
    this.#exit = this.#watchExit();
    void this.#exit
      .then((status) => {
        this.#exitStatus = status;
      })
      .catch(() => {});
    this.#pumpDone = this.#pump();
  }

  async #watchExit(): Promise<ExitStatus> {
    if (isLinux) {
      const pidfd = Number(lib.symbols.syscall(SYS_PIDFD_OPEN, BigInt(this.#pid), 0n));
      if (pidfd < 0) throw new Error(`pidfd_open(${this.#pid}) failed: errno ${-pidfd}`);
      await loop.readable(pidfd);
      lib.symbols.close(pidfd);
    } else {
      await loop.proc(this.#pid);
    }
    const statusBuf = new ArrayBuffer(4);
    lib.symbols.waitpid(this.#pid, statusBuf, 0);
    const s = new DataView(statusBuf).getInt32(0, true);
    if ((s & 127) === 0) return { code: (s >> 8) & 255, signal: null };
    if ((s & 127) !== 127) return { code: null, signal: s & 127 };
    return { code: null, signal: null };
  }

  async #pump(): Promise<void> {
    try {
      while (true) {
        const chunk = await this.#reader.read();
        if (chunk === null) break;
        this.#term.write(chunk);
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
    if (this.#exitStatus === null) lib.symbols.kill(this.#pid, SIGWINCH);
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
      lib.symbols.kill(this.#pid, SIGTERM);
      const grace = loop.timeout(500);
      const exited = await Promise.race([this.#exit.then(() => true), grace.then(() => false)]);
      if (exited) {
        grace.cancel();
      } else {
        lib.symbols.kill(this.#pid, SIGKILL);
        await this.#exit;
      }
    }
    // The child's death closes the slave, which surfaces as EOF on the
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
      lib.symbols.close(this.#master);
    }
  }
}

/**
 * Open a pseudo-terminal and spawn `command` on its slave side.
 *
 * The returned {@link PtyHandle} exposes the child's screen as a live VT
 * emulator plus input, resize, exit, and teardown primitives. The child gets
 * a fresh session with the slave as its controlling terminal, sized to
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
  try {
    if (Number(lib.symbols.grantpt(master)) !== 0) {
      throw new Error(`grantpt failed: errno ${getErrno()}`);
    }
    if (Number(lib.symbols.unlockpt(master)) !== 0) {
      throw new Error(`unlockpt failed: errno ${getErrno()}`);
    }
    const slavePtr = lib.symbols.ptsname(master) as ArrayBuffer | null;
    if (slavePtr === null) throw new Error(`ptsname failed: errno ${getErrno()}`);
    // ptsname returns static storage — copy it out immediately.
    const slavePath = readCStr(slavePtr);
    // macOS masters reject winsize ioctls until a slave is open, so the
    // initial size is set through a short-lived parent-side slave fd. It is
    // closed only after spawn: posix_spawn's file actions complete before it
    // returns, so the child already holds the slave and the master never
    // observes an all-slaves-closed EOF.
    const slaveFd = Number(lib.symbols.open(cstr(slavePath), O_RDWR | O_NOCTTY, 0));
    if (slaveFd < 0) throw new Error(`open('${slavePath}') failed: errno ${getErrno()}`);
    let pid: number;
    try {
      setWinsize(slaveFd, cols, rows);
      pid = spawnOnSlave(command, args, slavePath, master, slaveFd, options);
    } finally {
      lib.symbols.close(slaveFd);
    }
    setNonblocking(master);
    const term = new Terminal({ cols, rows });
    return new Pty(pid, master, term, options.anchor ?? 'cursor');
  } catch (err) {
    lib.symbols.close(master);
    throw err;
  }
}
