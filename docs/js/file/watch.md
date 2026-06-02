# watch

fino:file/watch — Cross-platform filesystem event watcher.

Watches files and directories for changes and exposes a unified async
iterator interface. Platform implementations differ, but the event model
is the same on both:

  { type: 'create' | 'modify' | 'delete' | 'rename', path: string }

## Platform details

**macOS** — uses kqueue EVFILT_VNODE (via `internal:runtime/loop`'s `vnode()`
API). One open fd is required per watched path. EV_CLEAR auto-re-arms the
filter after each delivery. Events report which flags fired (NOTE_WRITE,
NOTE_DELETE, etc.) but not which specific file changed within a directory —
a NOTE_WRITE on a directory only means "something changed in this directory".

**Linux** — uses inotify through the runtime watch backend. A single inotify
fd handles all watches. Events include the specific filename that changed,
providing finer-grained information than the macOS backend.

## Known limitations

- macOS: each watched path requires an open fd. Deep recursive watches may
  approach per-process fd limits (default 256; raise with `ulimit -n`).
- macOS: directory watches only know that something changed, not which entry.
  Callers that need the specific changed file must re-scan the directory.
- macOS: renames report only the old path (NOTE_RENAME on the source).
- Recursive watching: there is a brief race window between a new subdirectory
  being created and its watch being registered — a few events may be missed.

## Usage

```ts
import { Watcher } from './watch.mts';

const watcher = new Watcher();
watcher.watch('/tmp/mydir');

for await (const event of watcher) {
  console.log(event.type, event.path);
}

watcher.close();
```

## WatchEventType

```ts
type WatchEventType = 'create' | 'modify' | 'delete' | 'rename'
```

Normalized filesystem event names emitted by `Watcher`.

Platform backends collapse native event masks into these four names. A
single filesystem operation can still produce multiple events, and directory
watches may report the directory path rather than the exact changed child on
macOS.

```ts
const type = 'modify';
console.log(type);
```

## WatchEvent

```ts
interface WatchEvent {
```

Filesystem event yielded by a watcher.

Events are normalized from kqueue on macOS and inotify on Linux. The `path`
is the watched path or changed child path reported by the backend; callers
that need exact metadata should stat or rescan after receiving the event.

```ts
function logEvent(event) {
  console.log(event.type, event.path);
}
```

### type

```ts
type: WatchEventType
```

Normalized event type.

The value is one of `'create'`, `'modify'`, `'delete'`, or `'rename'`.
Backends may coalesce or duplicate events, so treat this as a notification
to re-check state rather than a complete change log.

```ts
const event = { type: 'create', path: '/tmp/file.txt' };
console.log(event.type);
```

### path

```ts
path: string
```

Absolute or relative path of the affected file or directory.

The path shape follows the path passed to `watch()` and the platform event
backend. Linux directory events usually include the changed child name;
macOS directory events may only identify the watched directory.

```ts
const event = { type: 'modify', path: 'src/main.mts' };
console.log(event.path);
```

## Watcher

```ts
class Watcher {
```

Async-iterable filesystem watcher. Construct, call `watch()` for each path,
then iterate events with `for await`.

The default is non-recursive watching. Call `close()` to stop watching and
release fds or inotify resources. Iteration ends after `close()` or after
the iterator's `return()` method is called by breaking out of `for await`.

```ts
import { Watcher } from 'fino:file/watch';

const watcher = new Watcher({ recursive: true });
watcher.watch('/tmp/mydir');
for await (const { type, path } of watcher) {
  console.log(type, path);
}
```

### constructor

```ts
constructor(options: WatchOptions = {})
```

Create a filesystem watcher.

By default, only the exact paths passed to `watch()` are watched.
`{ recursive: true }` scans subdirectories and adds backend watches for
them. Construction may allocate native watch state on Linux; close the
watcher when done.

```ts
import { Watcher } from 'fino:file/watch';

const watcher = new Watcher({ recursive: false });
watcher.close();
```

### watch

```ts
watch(path: string): void
```

Start watching `path` for changes.

On macOS, opens an fd for each watched path (and each subdirectory if
`recursive: true`). On Linux, adds an inotify watch.

May be called multiple times to watch multiple paths.

Throws if the watcher is already closed or the backend cannot register the
path. On macOS, directory watches do not identify the exact changed child.

```ts
import { Watcher } from 'fino:file/watch';

const watcher = new Watcher();
watcher.watch('/tmp/app.log');
watcher.close();
```

### close

```ts
close(): void
```

Stop watching all paths and release all resources.
Resolves any pending iterator .next() calls with `{ done: true }`.

Calling `close()` more than once is allowed. After close, `watch()` throws
and async iteration completes without yielding more queued events after the
queue is drained.

```ts
import { Watcher } from 'fino:file/watch';

const watcher = new Watcher();
watcher.watch('/tmp');
watcher.close();
```
