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
 * **macOS** — uses kqueue EVFILT_VNODE (via `fino:runtime/loop`'s `vnode()`
 * API). One open fd is required per watched path. EV_CLEAR auto-re-arms the
 * filter after each delivery. Events report which flags fired (NOTE_WRITE,
 * NOTE_DELETE, etc.) but not which specific file changed within a directory —
 * a NOTE_WRITE on a directory only means "something changed in this directory".
 *
 * **Linux** — uses inotify (via `internal:file/watch-bindings`). A single
 * inotify fd handles all watches. Events include the specific filename that
 * changed, providing finer-grained information than the macOS backend.
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
 * ```ts
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

import { lib, cstr, isDarwin, O_RDONLY, DT_DIR } from './bindings.mts';
import { DirEntry } from './entry.mts';
import * as loopMod from '../runtime/loop.mts';
import {
  isDarwin as _watchIsDarwin,
  inotifyInit, inotifyAddWatch, inotifyRmWatch, inotifyRead, inotifyClose,
  parseEvents,
  IN_MODIFY, IN_ATTRIB, IN_CREATE, IN_DELETE, IN_DELETE_SELF,
  IN_MOVED_FROM, IN_MOVED_TO, IN_MOVE_SELF, IN_ISDIR, IN_IGNORED,
  IN_ALL_CHANGES,
} from './watch-bindings.mts';

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

export type WatchEventType = 'create' | 'modify' | 'delete' | 'rename';

export interface WatchEvent {
  /** Type of filesystem event. */
  type:  WatchEventType;
  /** Absolute or relative path of the affected file or directory. */
  path:  string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WatchOptions {
  /**
   * Watch subdirectories recursively. On macOS, this opens one fd per
   * subdirectory. On Linux, it adds one inotify watch per subdirectory.
   * Default: false.
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
 * ```ts
 * const watcher = new Watcher(lp, { recursive: true });
 * watcher.watch('/tmp/mydir');
 * for await (const { type, path } of watcher) {
 *   console.log(type, path);
 * }
 * ```
 */
export class Watcher {
  #recursive: boolean;
  #closed = false;

  // Pending events waiting to be consumed by the async iterator.
  #queue: WatchEvent[] = [];
  // Resolve functions for iterator .next() calls waiting for an event.
  #waiters: Array<(result: IteratorResult<WatchEvent>) => void> = [];

  // macOS: fd → path string for each watched path.
  #fds: Map<number, string> = new Map();

  // Linux: inotify fd and wd → { path, isDir } mapping.
  #inotifyFd = -1;
  #wds: Map<number, { path: string; isDir: boolean }> = new Map();
  // Used to signal the background read loop to stop.
  #closePromise: Promise<void>;
  #resolveClose!: () => void;

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
   * @param path  Absolute or relative filesystem path to watch.
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
  #rescanDirDarwin(dirPath: string): void {
    this.#scanDirDarwin(dirPath);
  }

  // ---------------------------------------------------------------------------
  // Linux implementation (inotify)
  // ---------------------------------------------------------------------------

  #watchLinux(path: string, isDir = true): void {
    const wd = inotifyAddWatch(this.#inotifyFd, path, IN_ALL_CHANGES);
    this.#wds.set(wd, { path, isDir });

    if (this.#recursive && isDir) {
      this.#scanDirLinux(path);
    }
  }

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
