/**
 * internal:file/watch-bindings — Platform-specific bindings for file watching.
 *
 * On Linux: exposes inotify syscalls and event constants via libc FFI.
 * On macOS: stubs only — watching uses kqueue EVFILT_VNODE via internal:runtime/loop.
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
 *
 * ## Example
 *
 * ```typescript no_run
 * import * as watch from 'internal:file/watch-bindings';
 *
 * if (!watch.isDarwin) {
 *   const fd = watch.inotifyInit();
 *   const wd = watch.inotifyAddWatch(fd, '/tmp', watch.IN_ALL_CHANGES);
 *   const buf = new ArrayBuffer(4096);
 *   const n = watch.inotifyRead(fd, buf);
 *   const events = watch.parseEvents(buf, n);
 *   watch.inotifyRmWatch(fd, wd);
 *   watch.inotifyClose(fd);
 *   console.log(events);
 * }
 * ```
 *
 * @internal
 */

import { os } from 'internal:process';
import { dlopen, Pointer } from 'fino:ffi';
import { encodeUtf8, decodeUtf8 } from '../../globals/encoding.mts';

/**
 * True when the runtime is running on macOS.
 *
 * macOS file watching uses kqueue from `internal:runtime/loop`; inotify helpers
 * below are Linux-only stubs on Darwin.
 *
 * ```typescript no_run
 * import { isDarwin } from 'internal:file/watch-bindings';
 * if (isDarwin) {
 *   // Do not call inotifyInit().
 * }
 * ```
 *
 * @internal
 */
export const isDarwin = os === 'darwin';

// ---------------------------------------------------------------------------
// inotify event mask constants
// ---------------------------------------------------------------------------

/** Inotify flag for file access.
 * ```typescript no_run
 * import { IN_ACCESS } from 'internal:file/watch-bindings';
 * void IN_ACCESS;
 * ```
 * @internal */
export const IN_ACCESS        = 0x00000001; // file was read
/** Inotify flag for file content modification.
 * ```typescript no_run
 * import { IN_MODIFY } from 'internal:file/watch-bindings';
 * void IN_MODIFY;
 * ```
 * @internal */
export const IN_MODIFY        = 0x00000002; // file was written/truncated
/** Inotify flag for metadata changes.
 * ```typescript no_run
 * import { IN_ATTRIB } from 'internal:file/watch-bindings';
 * void IN_ATTRIB;
 * ```
 * @internal */
export const IN_ATTRIB        = 0x00000004; // metadata changed
/** Inotify flag for a child moved out of a watched directory.
 * ```typescript no_run
 * import { IN_MOVED_FROM } from 'internal:file/watch-bindings';
 * void IN_MOVED_FROM;
 * ```
 * @internal */
export const IN_MOVED_FROM    = 0x00000040; // file moved out of watched dir
/** Inotify flag for a child moved into a watched directory.
 * ```typescript no_run
 * import { IN_MOVED_TO } from 'internal:file/watch-bindings';
 * void IN_MOVED_TO;
 * ```
 * @internal */
export const IN_MOVED_TO      = 0x00000080; // file moved into watched dir
/** Inotify flag for child creation.
 * ```typescript no_run
 * import { IN_CREATE } from 'internal:file/watch-bindings';
 * void IN_CREATE;
 * ```
 * @internal */
export const IN_CREATE        = 0x00000100; // file/dir created in watched dir
/** Inotify flag for child deletion.
 * ```typescript no_run
 * import { IN_DELETE } from 'internal:file/watch-bindings';
 * void IN_DELETE;
 * ```
 * @internal */
export const IN_DELETE        = 0x00000200; // file/dir deleted from watched dir
/** Inotify flag for deletion of the watched path.
 * ```typescript no_run
 * import { IN_DELETE_SELF } from 'internal:file/watch-bindings';
 * void IN_DELETE_SELF;
 * ```
 * @internal */
export const IN_DELETE_SELF   = 0x00000400; // watched file/dir itself deleted
/** Inotify flag for movement of the watched path.
 * ```typescript no_run
 * import { IN_MOVE_SELF } from 'internal:file/watch-bindings';
 * void IN_MOVE_SELF;
 * ```
 * @internal */
export const IN_MOVE_SELF     = 0x00000800; // watched file/dir itself moved
/** Inotify flag indicating the event subject is a directory.
 * ```typescript no_run
 * import { IN_ISDIR } from 'internal:file/watch-bindings';
 * void IN_ISDIR;
 * ```
 * @internal */
export const IN_ISDIR         = 0x40000000; // subject is a directory
/** Inotify flag emitted when a watch was removed.
 * ```typescript no_run
 * import { IN_IGNORED } from 'internal:file/watch-bindings';
 * void IN_IGNORED;
 * ```
 * @internal */
export const IN_IGNORED       = 0x00008000; // watch was removed

/**
 * Mask for all inotify changes this runtime treats as watch events.
 *
 * Includes create, delete, rename, modify, attrib, and self-delete/move. It
 * excludes pure access events.
 *
 * ```typescript no_run
 * import { IN_ALL_CHANGES, inotifyAddWatch } from 'internal:file/watch-bindings';
 * const wd = inotifyAddWatch(fd, '/tmp', IN_ALL_CHANGES);
 * ```
 *
 * @internal
 */
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

/**
 * Parsed Linux `struct inotify_event`.
 *
 * `name` is present for directory child events and `null` for events about the
 * watched path itself, such as `IN_DELETE_SELF`.
 *
 * ```typescript no_run
 * import type { InotifyEvent } from 'internal:file/watch-bindings';
 * const event: InotifyEvent = {
 *   wd: 1,
 *   mask: 0,
 *   cookie: 0,
 *   name: null,
 * };
 * ```
 *
 * @internal
 */
export interface InotifyEvent {
  /**
   * Watch descriptor returned by `inotifyAddWatch`.
   *
   * ```typescript no_run
   * const descriptor = event.wd;
   * ```
   */
  wd:     number;
  /**
   * Bitmask of `IN_*` event flags.
   *
   * ```typescript no_run
   * const changed = (event.mask & IN_ALL_CHANGES) !== 0;
   * ```
   */
  mask:   number;
  /**
   * Cookie linking `IN_MOVED_FROM` and `IN_MOVED_TO` pairs.
   *
   * Zero means the event is not part of a move pair.
   *
   * ```typescript no_run
   * const cookie = event.cookie;
   * ```
   */
  cookie: number;
  /**
   * Filename of the affected entry within the watched directory.
   *
   * Null when the event concerns the watched path itself, such as
   * `IN_DELETE_SELF`.
   *
   * ```typescript no_run
   * const name = event.name ?? '';
   * ```
   */
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
 *
 * The fd is non-blocking and close-on-exec. Close it with `inotifyClose`.
 *
 * ```typescript no_run
 * import { inotifyInit, inotifyClose } from 'internal:file/watch-bindings';
 * const fd = inotifyInit();
 * inotifyClose(fd);
 * ```
 */
export function inotifyInit(): number {
  if (!_inotifyInit) throw new Error('inotify is not available on this platform');
  return _inotifyInit();
}

/**
 * Add a watch for `path` to the inotify instance `fd`.
 * Returns a watch descriptor (wd) used to identify events and remove the watch.
 * Linux only.
 *
 * Throws on failure or when inotify is unavailable. The `mask` should be a
 * combination of `IN_*` constants.
 *
 * ```typescript no_run
 * const watch = inotifyAddWatch(fd, '/tmp', IN_ALL_CHANGES);
 * ```
 */
export function inotifyAddWatch(fd: number, path: string, mask: number): number {
  if (!_inotifyAddWatch) throw new Error('inotify is not available on this platform');
  return _inotifyAddWatch(fd, path, mask);
}

/**
 * Remove a watch descriptor from the inotify instance.
 * Linux only.
 *
 * This wrapper ignores unavailable platforms and native removal errors.
 *
 * ```typescript no_run
 * inotifyRmWatch(fd, watch);
 * ```
 */
export function inotifyRmWatch(fd: number, wd: number): void {
  _inotifyRmWatch?.(fd, wd);
}

/**
 * Read pending inotify events from the fd into `buf`.
 * Returns the number of bytes read (0 if no events available — non-blocking).
 * Linux only.
 *
 * Throws on read errors other than `EAGAIN`. On macOS this returns zero.
 *
 * ```typescript no_run
 * const buf = new ArrayBuffer(4096);
 * const n = inotifyRead(fd, buf);
 * ```
 */
export function inotifyRead(fd: number, buf: ArrayBuffer): number {
  if (!_inotifyRead) return 0;
  return _inotifyRead(fd, buf);
}

/**
 * Close the inotify file descriptor.
 * Linux only.
 *
 * This wrapper is a no-op on macOS.
 *
 * ```typescript no_run
 * inotifyClose(fd);
 * ```
 */
export function inotifyClose(fd: number): void {
  _inotifyClose?.(fd);
}

/**
 * Parse `n` bytes from `buf` (filled by inotifyRead) into an array of events.
 * Always returns an empty array on macOS.
 *
 * The parser expects complete packed `struct inotify_event` records. Passing a
 * partial byte count may produce invalid reads.
 *
 * ```typescript no_run
 * const events = parseEvents(buf, n);
 * ```
 */
export function parseEvents(buf: ArrayBuffer, n: number): InotifyEvent[] {
  if (!_parseEvents || n === 0) return [];
  return _parseEvents(buf, n);
}
