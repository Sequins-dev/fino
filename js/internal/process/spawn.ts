/**
 * Shared POSIX child-process mechanics.
 *
 * This module owns the error-prone, policy-neutral parts of launching and
 * observing children: C-string lifetimes, spawn actions and attributes,
 * signal disposition, cwd/environment handling, and asynchronous reaping.
 * Callers provide only their descriptor wiring and lifecycle policy.
 *
 * Useful references:
 *
 * - [POSIX `posix_spawn`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/posix_spawn.html)
 * - [POSIX `waitpid`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/wait.html)
 * - [Linux `pidfd_open(2)`](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)
 */
import { spawn as lib, spawnChdirLib, spawnInheritLib, spawnCloseFromLib } from 'internal:io';
import { Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import { encodeUtf8 } from 'internal:encoding';
import * as loop from '../runtime/loop.ts';

const isLinux = os === 'linux';
const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = isLinux ? 2048 : 4;
const WNOHANG = 1;
const SYS_PIDFD_OPEN = 434n;
const POSIX_SPAWN_FILE_ACTIONS_BYTES = 512;
const POSIX_SPAWN_ATTR_BYTES = 512;
const SIGSET_BYTES = 128;
const POSIX_SPAWN_SETSIGDEF = 0x0004;
const POSIX_SPAWN_SETSIGMASK = 0x0008;
const POSIX_SPAWN_CLOEXEC_DEFAULT = 0x4000;
const POSIX_SPAWN_SETSID = isLinux ? 0x80 : 0x0400;

function check(rc: number, action: string): void {
  if (rc !== 0) throw new Error(`${action} failed: errno ${rc}`);
}

function cstr(value: string): Uint8Array {
  const encoded = encodeUtf8(value);
  const buffer = new Uint8Array(encoded.length + 1);
  buffer.set(encoded);
  return buffer;
}

function buildCStringArray(strings: string[]): { ptrBuf: ArrayBuffer; bufs: Uint8Array[] } {
  const bufs = strings.map(cstr);
  const ptrBuf = new ArrayBuffer((bufs.length + 1) * 8);
  const view = new DataView(ptrBuf);
  for (let index = 0; index < bufs.length; index++) {
    view.setBigUint64(index * 8, Pointer.addr(bufs[index]!), true);
  }
  return { ptrBuf, bufs };
}

function addSignal(set: ArrayBuffer, signal: number): void {
  if (signal <= 0) return;
  const bit = signal - 1;
  const byteOffset = bit >> 3;
  if (byteOffset >= set.byteLength) return;
  new Uint8Array(set)[byteOffset]! |= 1 << (bit & 7);
}

export interface SpawnActions {
  open(targetFd: number, path: string, flags: number, mode?: number): void;
  dup2(fd: number, targetFd: number): void;
  close(fd: number): void;
  closeIfNeeded(fd: number, targetFd: number): void;
  closeFrom(fd: number): boolean;
  inherit(fd: number): void;
}

export interface SpawnOptions {
  command: string;
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
  defaultSignals?: number[];
  createSession?: boolean;
  closeOnExecDefault?: boolean;
  configure(actions: SpawnActions): void;
}

/** Launch a child after applying caller-provided descriptor actions. */
export function spawnPosix(options: SpawnOptions): number {
  const envStrings = Object.entries(options.env).map(([key, value]) => `${key}=${value}`);
  const { ptrBuf: argvBuf, bufs: argvBufs } = buildCStringArray(options.argv);
  const { ptrBuf: envpBuf, bufs: envpBufs } = buildCStringArray(envStrings);
  const commandBuf = cstr(options.command);
  const cwdBuf = options.cwd === undefined ? null : cstr(options.cwd);
  const actionStrings: Uint8Array[] = [];
  const actionsBuffer = new ArrayBuffer(POSIX_SPAWN_FILE_ACTIONS_BYTES);
  const attrs = new ArrayBuffer(POSIX_SPAWN_ATTR_BYTES);
  const signalDefaults = new ArrayBuffer(SIGSET_BYTES);
  const signalMask = new ArrayBuffer(SIGSET_BYTES);
  for (const signal of options.defaultSignals ?? []) addSignal(signalDefaults, signal);

  const actions: SpawnActions = {
    open(targetFd, path, flags, mode = 0) {
      const pathBuf = cstr(path);
      actionStrings.push(pathBuf);
      check(
        Number(
          lib.symbols.posix_spawn_file_actions_addopen(
            actionsBuffer,
            targetFd,
            pathBuf,
            flags,
            mode,
          ),
        ),
        `posix_spawn_file_actions_addopen(${targetFd})`,
      );
    },
    dup2(fd, targetFd) {
      check(
        Number(lib.symbols.posix_spawn_file_actions_adddup2(actionsBuffer, fd, targetFd)),
        `posix_spawn_file_actions_adddup2(${fd}, ${targetFd})`,
      );
    },
    close(fd) {
      check(
        Number(lib.symbols.posix_spawn_file_actions_addclose(actionsBuffer, fd)),
        `posix_spawn_file_actions_addclose(${fd})`,
      );
    },
    closeIfNeeded(fd, targetFd) {
      if (fd !== targetFd) this.close(fd);
    },
    closeFrom(fd) {
      if (spawnCloseFromLib === null) return false;
      check(
        Number(
          spawnCloseFromLib.symbols.posix_spawn_file_actions_addclosefrom_np(actionsBuffer, fd),
        ),
        `posix_spawn_file_actions_addclosefrom_np(${fd})`,
      );
      return true;
    },
    inherit(fd) {
      if (spawnInheritLib === null) return;
      check(
        Number(spawnInheritLib.symbols.posix_spawn_file_actions_addinherit_np(actionsBuffer, fd)),
        `posix_spawn_file_actions_addinherit_np(${fd})`,
      );
    },
  };

  let actionsInitialized = false;
  let attrsInitialized = false;
  try {
    check(
      Number(lib.symbols.posix_spawn_file_actions_init(actionsBuffer)),
      'posix_spawn_file_actions_init',
    );
    actionsInitialized = true;
    check(Number(lib.symbols.posix_spawnattr_init(attrs)), 'posix_spawnattr_init');
    attrsInitialized = true;
    check(
      Number(lib.symbols.posix_spawnattr_setsigdefault(attrs, signalDefaults)),
      'posix_spawnattr_setsigdefault',
    );
    check(
      Number(lib.symbols.posix_spawnattr_setsigmask(attrs, signalMask)),
      'posix_spawnattr_setsigmask',
    );
    let flags = POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK;
    if (options.createSession) flags |= POSIX_SPAWN_SETSID;
    if (options.closeOnExecDefault && os === 'darwin') flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;
    check(Number(lib.symbols.posix_spawnattr_setflags(attrs, flags)), 'posix_spawnattr_setflags');
    options.configure(actions);
    if (cwdBuf !== null) {
      if (spawnChdirLib === null) {
        throw new Error(
          'cwd option requires posix_spawn_file_actions_addchdir_np, which is unavailable on this platform',
        );
      }
      check(
        Number(spawnChdirLib.symbols.posix_spawn_file_actions_addchdir_np(actionsBuffer, cwdBuf)),
        'posix_spawn_file_actions_addchdir_np',
      );
    }
    const pidBuffer = new ArrayBuffer(4);
    const rc = Number(
      lib.symbols.posix_spawnp(pidBuffer, commandBuf, actionsBuffer, attrs, argvBuf, envpBuf),
    );
    if (rc !== 0) throw new Error(`posix_spawnp('${options.command}') failed: errno ${rc}`);
    return new DataView(pidBuffer).getInt32(0, true);
  } finally {
    if (actionsInitialized) lib.symbols.posix_spawn_file_actions_destroy(actionsBuffer);
    if (attrsInitialized) lib.symbols.posix_spawnattr_destroy(attrs);
    // Keep every C string alive until libc has copied the spawn arguments.
    void argvBufs;
    void envpBufs;
    void actionStrings;
  }
}

export interface ChildExitStatus {
  code: number | null;
  signal: number | null;
}

/** Wait asynchronously for a child and reap it exactly once. */
export async function watchChildExit(pid: number): Promise<ChildExitStatus> {
  const statusBuffer = new ArrayBuffer(4);
  if (isLinux) {
    const pidfd = Number(lib.symbols.syscall(SYS_PIDFD_OPEN, BigInt(pid), 0n));
    if (pidfd < 0) throw new Error(`pidfd_open(${pid}) failed: errno ${-pidfd}`);
    try {
      while (true) {
        await loop.readable(pidfd);
        const waited = Number(lib.symbols.waitpid(pid, statusBuffer, WNOHANG));
        if (waited === pid) break;
        if (waited < 0) throw new Error(`waitpid(${pid}) failed`);
      }
    } finally {
      loop.removeRead(pidfd);
      closeFd(pidfd);
    }
  } else {
    while (true) {
      await loop.proc(pid);
      const waited = Number(lib.symbols.waitpid(pid, statusBuffer, WNOHANG));
      if (waited === pid) break;
      if (waited < 0) throw new Error(`waitpid(${pid}) failed`);
    }
  }
  const status = new DataView(statusBuffer).getInt32(0, true);
  if ((status & 127) === 0) return { code: (status >> 8) & 255, signal: null };
  if ((status & 127) !== 127) return { code: null, signal: status & 127 };
  return { code: null, signal: null };
}

export function closeFd(fd: number): void {
  lib.symbols.close(fd);
}

export function setFdNonblocking(fd: number): void {
  const flags = Number(lib.symbols.fcntl(fd, F_GETFL, 0));
  if (flags < 0) throw new Error(`fcntl(F_GETFL) failed on fd ${fd}`);
  if (Number(lib.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK)) < 0) {
    throw new Error(`fcntl(F_SETFL) failed on fd ${fd}`);
  }
}

export function signalChild(pid: number, signal: number): void {
  if (!trySignalChild(pid, signal)) {
    throw new Error(`kill(${pid}, ${signal}) failed`);
  }
}

/** Signal a child when teardown should tolerate an already-exited target. */
export function trySignalChild(pid: number, signal: number): boolean {
  return Number(lib.symbols.kill(pid, signal)) === 0;
}
