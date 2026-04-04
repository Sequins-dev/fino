/**
 * internal:file/watch-bindings — Platform-specific bindings for file watching.
 *
 * On Linux: exposes inotify syscalls and event constants via libc FFI.
 * On macOS: stubs only — watching uses kqueue EVFILT_VNODE via fino:runtime/loop.
 *
 *
 * ## inotify overview (Linux)
 *
 * inotify is the Linux kernel's file event notification facility. A single
 * inotify fd (from `inotifyInit`) can watch many paths via watch descriptors
 * (from `inotifyAddWatch`). Events are read as a stream of variable-length
 * `struct inotify_event` records from the inotify fd.
 *
 *
 * ## struct inotify_event layout
 *
 *   offset  0: wd     (i32)   — watch descriptor that fired
 *   offset  4: mask   (u32)   — event bitmask (IN_CREATE, IN_DELETE, etc.)
 *   offset  8: cookie (u32)   — links related IN_MOVED_FROM / IN_MOVED_TO pairs
 *   offset 12: len    (u32)   — byte length of the name field (incl. null + padding)
 *   offset 16: name   (char[])— null-terminated filename of the affected entry
 *                               (only when the event has a subject file)
 *
 * Total size = 16 + len. Events are packed sequentially; advance (16 + len)
 * bytes to reach the next event.
 */

import { os } from 'internal:process';

export const isDarwin = os === 'darwin';

// ---------------------------------------------------------------------------
// inotify event mask constants
// ---------------------------------------------------------------------------

export const IN_ACCESS        = 0x00000001; // file was read
export const IN_MODIFY        = 0x00000002; // file was written/truncated
export const IN_ATTRIB        = 0x00000004; // metadata changed
export const IN_MOVED_FROM    = 0x00000040; // file moved out of watched dir
export const IN_MOVED_TO      = 0x00000080; // file moved into watched dir
export const IN_CREATE        = 0x00000100; // file/dir created in watched dir
export const IN_DELETE        = 0x00000200; // file/dir deleted from watched dir
export const IN_DELETE_SELF   = 0x00000400; // watched file/dir itself deleted
export const IN_MOVE_SELF     = 0x00000800; // watched file/dir itself moved
export const IN_ISDIR         = 0x40000000; // subject is a directory
export const IN_IGNORED       = 0x00008000; // watch was removed

/** All change events: create, delete, rename, modify, attrib. */
export const IN_ALL_CHANGES =
  IN_MODIFY | IN_ATTRIB | IN_CREATE | IN_DELETE | IN_DELETE_SELF |
  IN_MOVED_FROM | IN_MOVED_TO | IN_MOVE_SELF;

// ---------------------------------------------------------------------------
// inotify_init1 flags
// ---------------------------------------------------------------------------

const _IN_NONBLOCK = 0x800;
const _IN_CLOEXEC  = 0x80000;

// ---------------------------------------------------------------------------
// Parsed event type
// ---------------------------------------------------------------------------

export interface InotifyEvent {
  wd:     number;
  mask:   number;
  cookie: number;
  /** Filename of the affected entry within the watched directory. Null when the
   *  event concerns the watched path itself (e.g. IN_DELETE_SELF). */
  name:   string | null;
}

// ---------------------------------------------------------------------------
// Platform-specific implementation
// ---------------------------------------------------------------------------

// These are set up once at module load and exported as module-level functions.
let _inotifyInit: (() => number) | null = null;
let _inotifyAddWatch: ((fd: number, path: string, mask: number) => number) | null = null;
let _inotifyRmWatch: ((fd: number, wd: number) => void) | null = null;
let _inotifyRead: ((fd: number, buf: ArrayBuffer) => number) | null = null;
let _inotifyClose: ((fd: number) => void) | null = null;
let _parseEvents: ((buf: ArrayBuffer, n: number) => InotifyEvent[]) | null = null;

if (!isDarwin) {
  const { dlopen, Pointer } = await import('fino:ffi');
  const { encodeUtf8, decodeUtf8 } = await import('../internal/globals/encoding.mts');

  const lib = dlopen('libc.so.6', {
    inotify_init1:     { parameters: ['i32'],                    result: 'i32'    },
    inotify_add_watch: { parameters: ['i32', 'buffer', 'u32'],   result: 'i32'    },
    inotify_rm_watch:  { parameters: ['i32', 'i32'],             result: 'i32'    },
    read:              { parameters: ['i32', 'buffer', 'usize'], result: 'isize'  },
    close:             { parameters: ['i32'],                    result: 'i32'    },
    __errno_location:  { parameters: [],                         result: 'pointer'},
  });

  function errnoVal(): number {
    return Pointer.readI32(lib.symbols.__errno_location(), 0);
  }

  _inotifyInit = function inotifyInit(): number {
    const fd = lib.symbols.inotify_init1(_IN_NONBLOCK | _IN_CLOEXEC);
    if (fd < 0) throw new Error(`inotify_init1 failed: errno ${errnoVal()}`);
    return fd;
  };

  _inotifyAddWatch = function inotifyAddWatch(fd: number, path: string, mask: number): number {
    // Null-terminate manually: append \0 byte
    const enc = encodeUtf8(path);
    const buf = new Uint8Array(enc.length + 1);
    buf.set(enc);
    const wd = lib.symbols.inotify_add_watch(fd, buf, mask);
    if (wd < 0) throw new Error(`inotify_add_watch('${path}') failed: errno ${errnoVal()}`);
    return wd;
  };

  _inotifyRmWatch = function inotifyRmWatch(fd: number, wd: number): void {
    lib.symbols.inotify_rm_watch(fd, wd);
  };

  _inotifyRead = function inotifyRead(fd: number, buf: ArrayBuffer): number {
    const n = Number(lib.symbols.read(fd, buf, buf.byteLength));
    if (n < 0) {
      const e = errnoVal();
      if (e === 11 /* EAGAIN */) return 0;
      throw new Error(`inotify read failed: errno ${e}`);
    }
    return n;
  };

  _inotifyClose = function inotifyClose(fd: number): void {
    lib.symbols.close(fd);
  };

  _parseEvents = function parseInotifyEvents(buf: ArrayBuffer, n: number): InotifyEvent[] {
    const view = new DataView(buf);
    const events: InotifyEvent[] = [];
    let offset = 0;
    while (offset < n) {
      const wd     = view.getInt32(offset + 0,  true);
      const mask   = view.getUint32(offset + 4,  true);
      const cookie = view.getUint32(offset + 8,  true);
      const len    = view.getUint32(offset + 12, true);
      let name: string | null = null;
      if (len > 0) {
        const raw = new Uint8Array(buf, offset + 16, len);
        let end = 0;
        while (end < raw.length && raw[end] !== 0) end++;
        name = decodeUtf8(raw.subarray(0, end));
      }
      events.push({ wd, mask, cookie, name });
      offset += 16 + len;
    }
    return events;
  };
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Create a new inotify instance. Returns the inotify file descriptor.
 * Linux only — throws on macOS.
 */
export function inotifyInit(): number {
  if (!_inotifyInit) throw new Error('inotify is not available on this platform');
  return _inotifyInit();
}

/**
 * Add a watch for `path` to the inotify instance `fd`.
 * Returns a watch descriptor (wd) used to identify events and remove the watch.
 * Linux only.
 */
export function inotifyAddWatch(fd: number, path: string, mask: number): number {
  if (!_inotifyAddWatch) throw new Error('inotify is not available on this platform');
  return _inotifyAddWatch(fd, path, mask);
}

/**
 * Remove a watch descriptor from the inotify instance.
 * Linux only.
 */
export function inotifyRmWatch(fd: number, wd: number): void {
  _inotifyRmWatch?.(fd, wd);
}

/**
 * Read pending inotify events from the fd into `buf`.
 * Returns the number of bytes read (0 if no events available — non-blocking).
 * Linux only.
 */
export function inotifyRead(fd: number, buf: ArrayBuffer): number {
  if (!_inotifyRead) return 0;
  return _inotifyRead(fd, buf);
}

/**
 * Close the inotify file descriptor.
 * Linux only.
 */
export function inotifyClose(fd: number): void {
  _inotifyClose?.(fd);
}

/**
 * Parse `n` bytes from `buf` (filled by inotifyRead) into an array of events.
 * Always returns an empty array on macOS.
 */
export function parseEvents(buf: ArrayBuffer, n: number): InotifyEvent[] {
  if (!_parseEvents || n === 0) return [];
  return _parseEvents(buf, n);
}
