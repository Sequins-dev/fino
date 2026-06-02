/**
 * fino:file/watch — Cross-platform filesystem event watcher.
 *
 * Watches files and directories for changes and exposes a unified async
 * iterator interface. Platform implementations differ, but the event model
 * is the same on both:
 *
 *   { type: 'create' | 'modify' | 'delete' | 'rename', path: string }
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
 * import { Watcher } from './watch.mts';
 *
 * const watcher = new Watcher();
 * watcher.watch('/tmp/mydir');
 *
 * for await (const event of watcher) {
 *   console.log(event.type, event.path);
 * }
 *
 * watcher.close();
 * ```
 */

import { lib, cstr, isDarwin, O_RDONLY, DT_DIR } from '../internal/file/bindings.mts';
import { DirEntry } from '../internal/file/entry.mts';
import * as loopMod from '../internal/runtime/loop.mts';
import {
  isDarwin as _watchIsDarwin,
  inotifyInit, inotifyAddWatch, inotifyRmWatch, inotifyRead, inotifyClose,
  parseEvents,
  IN_MODIFY, IN_ATTRIB, IN_CREATE, IN_DELETE, IN_DELETE_SELF,
  IN_MOVED_FROM, IN_MOVED_TO, IN_MOVE_SELF, IN_ISDIR, IN_IGNORED,
  IN_ALL_CHANGES,
} from '../internal/file/watch-bindings.mts';

// ---------------------------------------------------------------------------
// macOS NOTE_* constants (kqueue EVFILT_VNODE fflags)
// ---------------------------------------------------------------------------
// Defined locally to avoid importing kqueue.mts (which opens libSystem and
// would fail on Linux).

const NOTE_DELETE = 0x00000001;
const NOTE_WRITE  = 0x00000002;
const NOTE_EXTEND = 0x00000004;
const NOTE_ATTRIB = 0x00000008;
const NOTE_LINK   = 0x00000010;
const NOTE_RENAME = 0x00000020;
const NOTE_REVOKE = 0x00000040;

// Watch all vnode events
const ALL_NOTES = NOTE_DELETE | NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB | NOTE_LINK | NOTE_RENAME | NOTE_REVOKE;

// macOS open(2) flag — allows watching without blocking unmounts.
// Does not give read access but works for kqueue event registration.
const O_EVTONLY = 0x8000;

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
 * const type = 'modify';
 * console.log(type);
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
 * function logEvent(event) {
 *   console.log(event.type, event.path);
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
   *
   * ```ts no_run
   * const event = { type: 'create', path: '/tmp/file.txt' };
   * console.log(event.type);
   * ```
   */
  type:  WatchEventType;
  /**
   * Absolute or relative path of the affected file or directory.
   *
   * The path shape follows the path passed to `watch()` and the platform event
   * backend. Linux directory events usually include the changed child name;
   * macOS directory events may only identify the watched directory.
   *
   * ```ts no_run
   * const event = { type: 'modify', path: 'src/main.mts' };
   * console.log(event.path);
   * ```
   */
  path:  string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Generated-doc-visible interface `WatchOptions`.
 *
 * This implementation detail is included when documentation is built with
 * `--include-private`. It describes state or helper behavior used by the
 * owning module rather than a stable application-facing contract. Prefer the
 * public API around the owning type unless you are maintaining this runtime.
 *
 * @example
 * ```ts no_run
 * const documentedType = 'WatchOptions';
 * console.log(documentedType);
 * ```
 *
 * @internal
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
   *
   * ```ts no_run
   * const options = { recursive: true };
   * console.log(options.recursive);
   * ```
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
   * Private property `#recursive` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #recursive = undefined;
   *
   *   readInternalState() {
   *     return this.#recursive;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #recursive: boolean;
  /**
   * Private property `#closed` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closed = undefined;
   *
   *   readInternalState() {
   *     return this.#closed;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closed = false;

  // Pending events waiting to be consumed by the async iterator.
  /**
   * Private property `#queue` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #queue = undefined;
   *
   *   readInternalState() {
   *     return this.#queue;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #queue: WatchEvent[] = [];
  // Resolve functions for iterator .next() calls waiting for an event.
  /**
   * Private property `#waiters` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #waiters = undefined;
   *
   *   readInternalState() {
   *     return this.#waiters;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #waiters: Array<(result: IteratorResult<WatchEvent>) => void> = [];

  // macOS: fd → path string for each watched path.
  /**
   * Private property `#fds` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fds = undefined;
   *
   *   readInternalState() {
   *     return this.#fds;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fds: Map<number, string> = new Map();

  // Linux: inotify fd and wd → { path, isDir } mapping.
  /**
   * Private property `#inotifyFd` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #inotifyFd = undefined;
   *
   *   readInternalState() {
   *     return this.#inotifyFd;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #inotifyFd = -1;
  /**
   * Private property `#wds` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #wds = undefined;
   *
   *   readInternalState() {
   *     return this.#wds;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #wds: Map<number, { path: string; isDir: boolean }> = new Map();
  // Used to signal the background read loop to stop.
  /**
   * Private property `#closePromise` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closePromise = undefined;
   *
   *   readInternalState() {
   *     return this.#closePromise;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closePromise: Promise<void>;
  /**
   * Private property `#resolveClose` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #resolveClose = undefined;
   *
   *   readInternalState() {
   *     return this.#resolveClose;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #resolveClose!: () => void;

  /**
   * Create a filesystem watcher.
   *
   * By default, only the exact paths passed to `watch()` are watched.
   * `{ recursive: true }` scans subdirectories and adds backend watches for
   * them. Construction may allocate native watch state on Linux; close the
   * watcher when done.
   *
   * @param {WatchOptions} [options={}] Watch behavior options.
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
    this.#closePromise = new Promise(function captureCloseResolve(resolve) { watcher.#resolveClose = resolve; });

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
   * May be called multiple times to watch multiple paths.
   *
   * Throws if the watcher is already closed or the backend cannot register the
   * path. On macOS, directory watches do not identify the exact changed child.
   *
   * @param path Absolute or relative filesystem path to watch.
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
    const p = String(path);
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

    // Resolve all pending waiters with done.
    for (const resolve of this.#waiters) {
      resolve({ value: undefined as any, done: true });
    }
    this.#waiters.length = 0;
  }

  /**
   * Return an async iterator of filesystem events.
   *
   * `next()` waits until an event is available, unless the watcher is closed.
   * Breaking out of a `for await` loop calls the iterator's `return()` method,
   * which closes the watcher and releases native resources.
   *
   * @returns {AsyncIterator<WatchEvent>} Async iterator over queued and future events.
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
          return Promise.resolve({ value: undefined as any, done: true });
        }
        if (watcher.#queue.length > 0) {
          return Promise.resolve({ value: watcher.#queue.shift()!, done: false });
        }
        return new Promise(function parkWatchNext(resolve) {
          watcher.#waiters.push(resolve);
        });
      },
      return(): Promise<IteratorResult<WatchEvent>> {
        watcher.close();
        return Promise.resolve({ value: undefined as any, done: true });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------------

  /**
   * Private method `#emit` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #emit() {
   *     return 'emit';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#emit();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #emit(event: WatchEvent): void {
    if (this.#closed) return;
    if (this.#waiters.length > 0) {
      this.#waiters.shift()!({ value: event, done: false });
    } else {
      this.#queue.push(event);
    }
  }

  // ---------------------------------------------------------------------------
  // macOS implementation (kqueue EVFILT_VNODE)
  // ---------------------------------------------------------------------------

  /**
   * Private method `#watchDarwin` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #watchDarwin() {
   *     return 'watchDarwin';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#watchDarwin();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #watchDarwin(path: string): void {
    // Open the path read-only. O_EVTONLY allows watching without blocking unmounts.
    const fd = lib.symbols.open(cstr(path), O_RDONLY | O_EVTONLY, 0);
    if (fd < 0) throw new Error(`watch: cannot open '${path}'`);

    this.#fds.set(fd, path);
    const watcher = this;
    loopMod.vnode(fd, ALL_NOTES, function onVnodeEvent(ev: { fflags: number }) {
      watcher.#handleVnode(fd, path, ev.fflags);
    });

    if (this.#recursive) {
      this.#scanDirDarwin(path);
    }
  }

  /**
   * Private method `#handleVnode` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #handleVnode() {
   *     return 'handleVnode';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#handleVnode();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #handleVnode(fd: number, path: string, fflags: number): void {
    if (fflags & NOTE_DELETE) {
      this.#emit({ type: 'delete', path });
      // The fd is now invalid (deleted file). Clean up.
      loopMod.removeVnode(fd);
      lib.symbols.close(fd);
      this.#fds.delete(fd);
      return;
    }
    if (fflags & NOTE_RENAME) {
      this.#emit({ type: 'rename', path });
    }
    if (fflags & (NOTE_WRITE | NOTE_EXTEND)) {
      this.#emit({ type: 'modify', path });
      // If this is a directory and recursive, re-scan for new subdirs.
      if (this.#recursive && this.#fds.has(fd)) {
        this.#rescanDirDarwin(path);
      }
    }
    if (fflags & NOTE_ATTRIB) {
      this.#emit({ type: 'modify', path });
    }
    if (fflags & NOTE_REVOKE) {
      this.#emit({ type: 'delete', path });
    }
  }

  /** Recursively open+watch all subdirectories under `path`. */
  /**
   * Private method `#scanDirDarwin` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #scanDirDarwin() {
   *     return 'scanDirDarwin';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#scanDirDarwin();
   *   }
   * }
   * ```
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

  /** Re-scan a directory for newly added subdirectories. */
  /**
   * Private method `#rescanDirDarwin` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #rescanDirDarwin() {
   *     return 'rescanDirDarwin';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#rescanDirDarwin();
   *   }
   * }
   * ```
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
   * Private method `#watchLinux` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #watchLinux() {
   *     return 'watchLinux';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#watchLinux();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #watchLinux(path: string, isDir = true): void {
    const wd = inotifyAddWatch(this.#inotifyFd, path, IN_ALL_CHANGES);
    this.#wds.set(wd, { path, isDir });

    if (this.#recursive && isDir) {
      this.#scanDirLinux(path);
    }
  }

  /**
   * Private method `#handleInotify` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #handleInotify() {
   *     return 'handleInotify';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#handleInotify();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #handleInotify(ev: { wd: number; mask: number; cookie: number; name: string | null }): void {
    const entry = this.#wds.get(ev.wd);
    if (!entry) return;

    const { path: dirPath } = entry;
    const fullPath = ev.name ? `${dirPath}/${ev.name}` : dirPath;
    const isDir = !!(ev.mask & IN_ISDIR);

    if (ev.mask & IN_IGNORED) {
      // Watch was removed (file deleted or inotify_rm_watch called).
      this.#wds.delete(ev.wd);
      return;
    }

    if (ev.mask & IN_CREATE) {
      this.#emit({ type: 'create', path: fullPath });
      // Auto-add watch for new subdirectories.
      if (this.#recursive && isDir && ev.name) {
        this.#watchLinux(fullPath, true);
      }
    }
    if (ev.mask & (IN_MODIFY | IN_ATTRIB)) {
      this.#emit({ type: 'modify', path: fullPath });
    }
    if (ev.mask & (IN_DELETE | IN_DELETE_SELF)) {
      this.#emit({ type: 'delete', path: fullPath });
    }
    if (ev.mask & (IN_MOVED_FROM | IN_MOVE_SELF)) {
      this.#emit({ type: 'rename', path: fullPath });
    }
    if (ev.mask & IN_MOVED_TO) {
      this.#emit({ type: 'create', path: fullPath });
      if (this.#recursive && isDir && ev.name) {
        this.#watchLinux(fullPath, true);
      }
    }
  }

  /** Recursively add inotify watches for all subdirectories under `dirPath`. */
  /**
   * Private method `#scanDirLinux` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #scanDirLinux() {
   *     return 'scanDirLinux';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#scanDirLinux();
   *   }
   * }
   * ```
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
          const alreadyWatched = [...watcher.#wds.values()].some(function isWatched(v) { return v.path === childPath; });
          if (!alreadyWatched) {
            watcher.#watchLinux(childPath, true);
          }
        }
      }
    }).catch(function swallowLinuxScanErr() {
      // Directory may have been deleted — ignore
    });
  }

  /** Background read loop for inotify (Linux). */
  /**
   * Private method `#runReadLoop` used by `Watcher`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #runReadLoop() {
   *     return 'runReadLoop';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#runReadLoop();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #runReadLoop(): Promise<void> {
    const buf = new ArrayBuffer(8192);
    const closedTag = Symbol('closed');
    const closedSignal = this.#closePromise.then(() => closedTag);

    while (!this.#closed) {
      // Race between becoming readable and the watcher being closed.
      const winner = await Promise.race([
        loopMod.readable(this.#inotifyFd).then(() => null),
        closedSignal,
      ]);
      if (winner === closedTag || this.#closed) break;

      const n = inotifyRead(this.#inotifyFd, buf);
      for (const ev of parseEvents(buf, n)) {
        this.#handleInotify(ev);
      }
    }
  }
}
