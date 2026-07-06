/**
* fino:file/watch — Cross-platform filesystem event watcher.
*
* Watches files and directories for changes and exposes a unified async
* iterator interface. Platform implementations differ, but the event model
* is the same on both:
*
* ```ts no_run
* interface WatchEvent {
*   type: 'create' | 'modify' | 'delete' | 'rename';
*   path: string;
* }
* ```
*
* This is a Fino runtime watcher, not Node `fs.watch` parity. The public
* release contract accepts string paths, yields events through async
* iteration, and stops through explicit `close()`. The only supported option
* is `recursive`; Node-style `persistent`, `encoding`, and `AbortSignal`
* options are not interpreted.
*
*
* ## Platform details
*
* **macOS** — uses kqueue EVFILT_VNODE (via `internal:runtime/loop`'s `vnode()`
* API). One open fd is required per watched path. EV_CLEAR auto-re-arms the
* filter after each delivery. Events report which flags fired (NOTE_WRITE,
* NOTE_DELETE, etc.) but not which specific file changed within a directory —
* a NOTE_WRITE on a directory only means "something changed in this directory".
*
* **Linux** — uses inotify through the runtime watch backend. A single inotify
* fd handles all watches. Events include the specific filename that changed,
* providing finer-grained information than the macOS backend.
*
*
* ## Known limitations
*
* - macOS: each watched path requires an open fd. Deep recursive watches may
*   approach per-process fd limits (default 256; raise with `ulimit -n`).
* - macOS: directory watches only know that something changed, not which entry.
*   Callers that need the specific changed file must re-scan the directory.
* - macOS: renames report only the old path (NOTE_RENAME on the source).
* - Recursive watching: there is a brief race window between a new subdirectory
*   being created and its watch being registered — a few events may be missed.
*
*
* ## Usage
*
* ```ts no_run
* import { Watcher } from 'fino:file/watch';
*
* const watcher = new Watcher({ recursive: true });
* watcher.watch('/tmp/mydir');
*
* for await (const event of watcher) {
*   console.log(event.type, event.path);
*   if (event.type === 'delete') break; // breaking closes the watcher
* }
* ```
*
* kqueue reference: https://man.freebsd.org/cgi/man.cgi?kqueue
* inotify reference: https://man7.org/linux/man-pages/man7/inotify.7.html
*/
import { lib, cstr, isDarwin, O_RDONLY, DT_DIR } from '../internal/file/bindings.ts';
import { DirEntry } from '../internal/file/entry.ts';
import * as loopMod from '../internal/runtime/loop.ts';
import { isDarwin as _watchIsDarwin, inotifyInit, inotifyAddWatch, inotifyRmWatch, inotifyRead, inotifyClose, parseEvents, IN_MODIFY, IN_ATTRIB, IN_CREATE, IN_DELETE, IN_DELETE_SELF, IN_MOVED_FROM, IN_MOVED_TO, IN_MOVE_SELF, IN_ISDIR, IN_IGNORED, IN_ALL_CHANGES } from '../internal/file/watch-bindings.ts';
// ---------------------------------------------------------------------------
// macOS NOTE_* constants (kqueue EVFILT_VNODE fflags)
// ---------------------------------------------------------------------------
// Defined locally to avoid importing kqueue.ts (which opens libSystem and
// would fail on Linux).
const NOTE_DELETE = 1;
const NOTE_WRITE = 2;
const NOTE_EXTEND = 4;
const NOTE_ATTRIB = 8;
const NOTE_LINK = 16;
const NOTE_RENAME = 32;
const NOTE_REVOKE = 64;
// Watch all vnode events
const ALL_NOTES = NOTE_DELETE | NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB | NOTE_LINK | NOTE_RENAME | NOTE_REVOKE;
// macOS open(2) flag — allows watching without blocking unmounts.
// Does not give read access but works for kqueue event registration.
const O_EVTONLY = 32768;
// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------
/**
* Normalized filesystem event names emitted by `Watcher`.
*
* Platform backends collapse native event masks into these four names. A
* single filesystem operation can still produce multiple events, and directory
* watches may report the directory path rather than the exact changed child on
* macOS.
*
* ```ts no_run
* import { Watcher, type WatchEventType } from 'fino:file/watch';
*
* const counts: Record<WatchEventType, number> = {
*   create: 0, modify: 0, delete: 0, rename: 0,
* };
* const watcher = new Watcher();
* watcher.watch('/tmp/mydir');
* for await (const event of watcher) {
*   counts[event.type]++;
* }
* ```
*/
export type WatchEventType = 'create' | 'modify' | 'delete' | 'rename';
/**
* Filesystem event yielded by a watcher.
*
* Events are normalized from kqueue on macOS and inotify on Linux. The `path`
* is the watched path or changed child path reported by the backend; callers
* that need exact metadata should stat or rescan after receiving the event.
*
* ```ts no_run
* import { Watcher, type WatchEvent } from 'fino:file/watch';
*
* function isSourceChange(event: WatchEvent): boolean {
*   return event.type === 'modify' && event.path.endsWith('.ts');
* }
*
* const watcher = new Watcher({ recursive: true });
* watcher.watch('./src');
* for await (const event of watcher) {
*   if (isSourceChange(event)) console.log('rebuild:', event.path);
* }
* ```
*/
export interface WatchEvent {
  /**
  * Normalized event type.
  *
  * The value is one of `'create'`, `'modify'`, `'delete'`, or `'rename'`.
  * Backends may coalesce or duplicate events, so treat this as a notification
  * to re-check state rather than a complete change log.
  */
  type: WatchEventType;
  /**
  * Absolute or relative path of the affected file or directory.
  *
  * The path shape follows the path passed to `watch()` and the platform event
  * backend. Linux directory events usually include the changed child name;
  * macOS directory events may only identify the watched directory.
  */
  path: string;
}
// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
/**
* Options for [Watcher].
*
* The current option surface controls whether watched directories are scanned
* recursively. Watch events are backend notifications, not a transactional
* filesystem log: platforms may coalesce rapid changes, directory events may
* identify only the watched directory, and recursive watches can miss events
* created between directory discovery and backend registration.
*
* ```ts no_run
* import { Watcher, type WatchOptions } from 'fino:file/watch';
*
* const options: WatchOptions = { recursive: true };
* const watcher = new Watcher(options);
* watcher.watch('./src');
* watcher.close();
* ```
*/
export interface WatchOptions {
  /**
  * Watch subdirectories recursively. On macOS, this opens one fd per
  * subdirectory. On Linux, it adds one inotify watch per subdirectory.
  * Default: false.
  *
  * Recursive watching can miss a small number of events between a new
  * subdirectory being created and its watch being installed. Very large trees
  * may also hit fd or inotify watch limits.
  */
  recursive?: boolean;
}
// ---------------------------------------------------------------------------
// Watcher class
// ---------------------------------------------------------------------------
/**
* Async-iterable filesystem watcher. Construct, call `watch()` for each path,
* then iterate events with `for await`.
*
* The default is non-recursive watching. Call `close()` to stop watching and
* release fds or inotify resources. Iteration ends after `close()` or after
* the iterator's `return()` method is called by breaking out of `for await`.
*
* ```ts no_run
* import { Watcher } from 'fino:file/watch';
*
* const watcher = new Watcher({ recursive: true });
* watcher.watch('/tmp/mydir');
* for await (const { type, path } of watcher) {
*   console.log(type, path);
* }
* ```
*/
export class Watcher {
  /**
  * Whether directory watches descend into subdirectories, captured from the
  * constructor options.
  *
  * @internal
  */
  #recursive: boolean;
  /**
  * True once `close()` has run. Guards event emission, `watch()`, and the
  * Linux read loop.
  *
  * @internal
  */
  #closed = false;
  // Pending events waiting to be consumed by the async iterator.
  /**
  * Events emitted while no iterator `next()` call was pending, buffered until
  * consumed.
  *
  * @internal
  */
  #queue: WatchEvent[] = [];
  // Resolve functions for iterator .next() calls waiting for an event.
  /**
  * Resolve callbacks for iterator `next()` calls parked while the event queue
  * was empty. Resolved with `{ done: true }` on close.
  *
  * @internal
  */
  #waiters: Array<(result: IteratorResult<WatchEvent>) => void> = [];
  // macOS: fd → path string for each watched path.
  /**
  * macOS: open fd → watched path for each kqueue vnode registration. Closed
  * and cleared on `close()` or when a watched path is deleted.
  *
  * @internal
  */
  #fds: Map<number, string> = new Map();
  // Linux: inotify fd and wd → { path, isDir } mapping.
  /**
  * Linux: the single inotify fd shared by all watches. Stays `-1` on macOS.
  *
  * @internal
  */
  #inotifyFd = -1;
  /**
  * Linux: inotify watch descriptor → watched path and directory flag. Entries
  * are removed on `IN_IGNORED` and cleared on `close()`.
  *
  * @internal
  */
  #wds: Map<number, {
    path: string;
    isDir: boolean;
  }> = new Map();
  /**
  * Every currently watched path, on both platforms. Used to make repeated
  * `watch()` calls for the same path a no-op; entries are removed when a
  * watched path is deleted and cleared on `close()`.
  */
  #paths: Set<string> = new Set();
  // Used to signal the background read loop to stop.
  /**
  * Resolves when `close()` is called; the Linux read loop races it against
  * inotify readability so shutdown never blocks on a quiet fd.
  *
  * @internal
  */
  #closePromise: Promise<void>;
  /**
  * Resolver for `#closePromise`, captured at construction and invoked by
  * `close()`.
  *
  * @internal
  */
  #resolveClose!: () => void;
  /**
  * Create a filesystem watcher.
  *
  * By default, only the exact paths passed to `watch()` are watched.
  * `{ recursive: true }` scans subdirectories and adds backend watches for
  * them. Construction allocates an inotify fd and starts the background read
  * loop on Linux; close the watcher when done.
  *
  * ```ts no_run
  * import { Watcher } from 'fino:file/watch';
  *
  * const watcher = new Watcher({ recursive: false });
  * watcher.close();
  * ```
  */
  constructor(options: WatchOptions = {}) {
    this.#recursive = options.recursive ?? false;
    const watcher = this;
    this.#closePromise = new Promise(function captureCloseResolve(resolve) {
      watcher.#resolveClose = resolve;
    });
    if (!isDarwin) {
      this.#inotifyFd = inotifyInit();
      this.#runReadLoop();
    }
  }
  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  /**
  * Start watching `path` for changes.
  *
  * On macOS, opens an fd for each watched path (and each subdirectory if
  * `recursive: true`). On Linux, adds an inotify watch.
  *
  * May be called multiple times to watch multiple paths. Watching a path that
  * is already watched is a no-op.
  *
  * Throws if the watcher is already closed, if `path` is not a string, or if
  * the backend cannot register the path (for example, it does not exist).
  *
  * On macOS, directory watches do not identify the exact changed child —
  * events carry the watched directory's path, so re-scan the directory if the
  * specific entry matters.
  *
  * ```ts no_run
  * import { Watcher } from 'fino:file/watch';
  *
  * const watcher = new Watcher();
  * watcher.watch('/tmp/app.log');
  * watcher.close();
  * ```
  */
  watch(path: string): void {
    if (this.#closed) throw new Error('Watcher is closed');
    if (typeof path !== 'string') throw new TypeError('Watcher.watch path must be a string');
    const p = path;
    if (this.#paths.has(p)) return;
    if (isDarwin) {
      this.#watchDarwin(p);
    } else {
      this.#watchLinux(p);
    }
  }
  /**
  * Stop watching all paths and release all resources.
  * Resolves any pending iterator .next() calls with `{ done: true }`.
  *
  * Calling `close()` more than once is allowed. After close, `watch()` throws
  * and async iteration completes without yielding more queued events after the
  * queue is drained.
  *
  * ```ts no_run
  * import { Watcher } from 'fino:file/watch';
  *
  * const watcher = new Watcher();
  * watcher.watch('/tmp');
  * watcher.close();
  * ```
  */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#resolveClose();
    if (isDarwin) {
      for (const [fd] of this.#fds) {
        loopMod.removeVnode(fd);
        lib.symbols.close(fd);
      }
      this.#fds.clear();
    } else {
      // Cancel the pending readable (if any)
      loopMod.removeRead(this.#inotifyFd);
      for (const [wd] of this.#wds) {
        inotifyRmWatch(this.#inotifyFd, wd);
      }
      this.#wds.clear();
      inotifyClose(this.#inotifyFd);
    }
    this.#paths.clear();
    // Resolve all pending waiters with done.
    for (const resolve of this.#waiters) {
      resolve({
        value: undefined as any,
        done: true
      });
    }
    this.#waiters.length = 0;
  }
  /**
  * Close the watcher when it leaves a `using` scope.
  *
  * Equivalent to calling `close()`; declared so a watcher can participate in
  * explicit resource management.
  *
  * ```ts no_run
  * import { Watcher } from 'fino:file/watch';
  *
  * {
  *   using watcher = new Watcher();
  *   watcher.watch('/tmp');
  * } // close() runs automatically here
  * ```
  */
  [Symbol.dispose](): void {
    this.close();
  }
  /**
  * Return an async iterator of filesystem events.
  *
  * `next()` yields queued events immediately and otherwise waits until an
  * event arrives; once the watcher is closed and the queue is drained it
  * resolves `{ done: true }`. Breaking out of a `for await` loop calls the
  * iterator's `return()` method, which closes the watcher and releases native
  * resources.
  *
  * ```ts no_run
  * import { Watcher } from 'fino:file/watch';
  *
  * const watcher = new Watcher();
  * watcher.watch('/tmp');
  * for await (const event of watcher) {
  *   console.log(event.path);
  *   break;
  * }
  * ```
  */
  [Symbol.asyncIterator](): AsyncIterator<WatchEvent> {
    const watcher = this;
    return {
      next(): Promise<IteratorResult<WatchEvent>> {
        if (watcher.#closed && watcher.#queue.length === 0) {
          return Promise.resolve({
            value: undefined as any,
            done: true
          });
        }
        if (watcher.#queue.length > 0) {
          return Promise.resolve({
            value: watcher.#queue.shift()!,
            done: false
          });
        }
        return new Promise(function parkWatchNext(resolve) {
          watcher.#waiters.push(resolve);
        });
      },
      return(): Promise<IteratorResult<WatchEvent>> {
        watcher.close();
        return Promise.resolve({
          value: undefined as any,
          done: true
        });
      }
    };
  }
  // ---------------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------------
  /**
  * Deliver an event to the oldest parked iterator waiter, or buffer it in the
  * queue. Events emitted after `close()` are dropped.
  *
  * @internal
  */
  #emit(event: WatchEvent): void {
    if (this.#closed) return;
    if (this.#waiters.length > 0) {
      this.#waiters.shift()!({
        value: event,
        done: false
      });
    } else {
      this.#queue.push(event);
    }
  }
  // ---------------------------------------------------------------------------
  // macOS implementation (kqueue EVFILT_VNODE)
  // ---------------------------------------------------------------------------
  /**
  * macOS: open `path` with `O_EVTONLY` and register a kqueue vnode filter for
  * all NOTE_* flags, then recurse into subdirectories when recursive watching
  * is enabled. Throws if the path cannot be opened.
  *
  * @internal
  */
  #watchDarwin(path: string): void {
    // Open the path read-only. O_EVTONLY allows watching without blocking unmounts.
    const fd = lib.symbols.open(cstr(path), O_RDONLY | O_EVTONLY, 0);
    if (fd < 0) throw new Error(`watch: cannot open '${path}'`);
    this.#fds.set(fd, path);
    this.#paths.add(path);
    const watcher = this;
    loopMod.vnode(fd, ALL_NOTES, function onVnodeEvent(ev: {
      fflags: number;
    }) {
      watcher.#handleVnode(fd, path, ev.fflags);
    });
    if (this.#recursive) {
      this.#scanDirDarwin(path);
    }
  }
  /**
  * macOS: translate kqueue vnode fflags into normalized events. NOTE_DELETE
  * closes and forgets the now-invalid fd; NOTE_WRITE on a recursive directory
  * watch triggers a re-scan for new subdirectories.
  *
  * @internal
  */
  #handleVnode(fd: number, path: string, fflags: number): void {
    if (fflags & NOTE_DELETE) {
      this.#emit({
        type: 'delete',
        path
      });
      // The fd is now invalid (deleted file). Clean up.
      loopMod.removeVnode(fd);
      lib.symbols.close(fd);
      this.#fds.delete(fd);
      this.#paths.delete(path);
      return;
    }
    if (fflags & NOTE_RENAME) {
      this.#emit({
        type: 'rename',
        path
      });
    }
    if (fflags & (NOTE_WRITE | NOTE_EXTEND)) {
      this.#emit({
        type: 'modify',
        path
      });
      // If this is a directory and recursive, re-scan for new subdirs.
      if (this.#recursive && this.#fds.has(fd)) {
        this.#rescanDirDarwin(path);
      }
    }
    if (fflags & NOTE_ATTRIB) {
      this.#emit({
        type: 'modify',
        path
      });
    }
    if (fflags & NOTE_REVOKE) {
      this.#emit({
        type: 'delete',
        path
      });
    }
  }
  /**
  * macOS: asynchronously list `dirPath` and open a vnode watch for every
  * subdirectory not already being watched. Listing errors (for example, the
  * directory was deleted mid-scan) are swallowed.
  *
  * @internal
  */
  #scanDirDarwin(dirPath: string): void {
    // Use DirEntry.entries() for directory listing.
    // Pass null as fs — entries() doesn't use it for the opendir/readdir syscalls.
    const watcher = this;
    const dirEntry = new DirEntry('', dirPath, null, DT_DIR);
    dirEntry.entries().then(function darwinDirEntries(entries: any[]) {
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const childPath = entry.path.toString();
          // Only watch if not already watching
          if (![...watcher.#fds.values()].includes(childPath)) {
            watcher.#watchDarwin(childPath);
          }
        }
      }
    }).catch(function swallowDarwinScanErr() {
      // Directory may have been deleted — ignore
    });
  }
  /**
  * macOS: re-scan a directory for newly added subdirectories after a
  * directory modify event.
  *
  * @internal
  */
  #rescanDirDarwin(dirPath: string): void {
    this.#scanDirDarwin(dirPath);
  }
  // ---------------------------------------------------------------------------
  // Linux implementation (inotify)
  // ---------------------------------------------------------------------------
  /**
  * Linux: add an inotify watch for `path` on the shared inotify fd, then
  * recurse into subdirectories when recursive watching is enabled and the
  * path is a directory.
  *
  * @internal
  */
  #watchLinux(path: string, isDir = true): void {
    const wd = inotifyAddWatch(this.#inotifyFd, path, IN_ALL_CHANGES);
    this.#wds.set(wd, {
      path,
      isDir
    });
    this.#paths.add(path);
    if (this.#recursive && isDir) {
      this.#scanDirLinux(path);
    }
  }
  /**
  * Linux: translate a parsed inotify event into normalized events, joining the
  * watch's directory path with the event's child name. New subdirectories seen
  * via IN_CREATE or IN_MOVED_TO are auto-watched when recursive; IN_IGNORED
  * drops the watch descriptor's state.
  *
  * @internal
  */
  #handleInotify(ev: {
    wd: number;
    mask: number;
    cookie: number;
    name: string | null;
  }): void {
    const entry = this.#wds.get(ev.wd);
    if (!entry) return;
    const { path: dirPath } = entry;
    const fullPath = ev.name ? `${dirPath}/${ev.name}` : dirPath;
    const isDir = !!(ev.mask & IN_ISDIR);
    if (ev.mask & IN_CREATE) {
      this.#emit({
        type: 'create',
        path: fullPath
      });
      // Auto-add watch for new subdirectories.
      if (this.#recursive && isDir && ev.name) {
        this.#watchLinux(fullPath, true);
      }
    }
    if (ev.mask & (IN_MODIFY | IN_ATTRIB)) {
      this.#emit({
        type: 'modify',
        path: fullPath
      });
    }
    if (ev.mask & (IN_DELETE | IN_DELETE_SELF)) {
      this.#emit({
        type: 'delete',
        path: fullPath
      });
    }
    if (ev.mask & (IN_MOVED_FROM | IN_MOVE_SELF)) {
      this.#emit({
        type: 'rename',
        path: fullPath
      });
    }
    if (ev.mask & IN_MOVED_TO) {
      this.#emit({
        type: 'create',
        path: fullPath
      });
      if (this.#recursive && isDir && ev.name) {
        this.#watchLinux(fullPath, true);
      }
    }
    if (ev.mask & IN_IGNORED) {
      // Watch was removed (file deleted or inotify_rm_watch called).
      const removed = this.#wds.get(ev.wd);
      if (removed) this.#paths.delete(removed.path);
      this.#wds.delete(ev.wd);
    }
  }
  /**
  * Linux: asynchronously list `dirPath` and add inotify watches for every
  * subdirectory not already being watched. Listing errors (for example, the
  * directory was deleted mid-scan) are swallowed.
  *
  * @internal
  */
  #scanDirLinux(dirPath: string): void {
    const watcher = this;
    const dirEntry = new DirEntry('', dirPath, null, DT_DIR);
    dirEntry.entries().then(function linuxDirEntries(entries: any[]) {
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const childPath = entry.path.toString();
          // Check if not already watching
          const alreadyWatched = [...watcher.#wds.values()].some(function isWatched(v) {
            return v.path === childPath;
          });
          if (!alreadyWatched) {
            watcher.#watchLinux(childPath, true);
          }
        }
      }
    }).catch(function swallowLinuxScanErr() {
      // Directory may have been deleted — ignore
    });
  }
  /**
  * Linux: background loop started at construction. Waits for the inotify fd
  * to become readable (racing against `close()`), reads a batch of events,
  * and dispatches each to `#handleInotify`. IN_ATTRIB events on a watch that
  * also reported IN_DELETE_SELF in the same batch are suppressed to avoid a
  * spurious modify-after-delete.
  *
  * @internal
  */
  async #runReadLoop(): Promise<void> {
    const buf = new ArrayBuffer(8192);
    const closedTag = Symbol('closed');
    const closedSignal = this.#closePromise.then(() => closedTag);
    while (!this.#closed) {
      // Race between becoming readable and the watcher being closed.
      const winner = await Promise.race([loopMod.readable(this.#inotifyFd).then(() => null), closedSignal]);
      if (winner === closedTag || this.#closed) break;
      const n = inotifyRead(this.#inotifyFd, buf);
      const events = parseEvents(buf, n);
      const deletedWds = new Set<number>();
      for (const ev of events) {
        if (ev.mask & IN_DELETE_SELF) deletedWds.add(ev.wd);
      }
      for (const ev of events) {
        if (ev.mask & IN_ATTRIB && deletedWds.has(ev.wd)) continue;
        this.#handleInotify(ev);
      }
    }
  }
}
