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

## WatchEvent

```ts
interface WatchEvent {
```

Filesystem event yielded by a watcher.

### type

```ts
type: WatchEventType
```

Type of filesystem event.

### path

```ts
path: string
```

Absolute or relative path of the affected file or directory.

## WatchOptions

```ts
interface WatchOptions {
```

### recursive

```ts
recursive?: boolean
```

Watch subdirectories recursively. On macOS, this opens one fd per
subdirectory. On Linux, it adds one inotify watch per subdirectory.
Default: false.

## Watcher

```ts
class Watcher {
```

Async-iterable filesystem watcher. Construct, call `watch()` for each path,
then iterate events with `for await`.

```ts
const watcher = new Watcher(lp, { recursive: true });
watcher.watch('/tmp/mydir');
for await (const { type, path } of watcher) {
  console.log(type, path);
}
```

### constructor

```ts
constructor(options: WatchOptions = {})
```

### watch

```ts
watch(path: string): void
```

Start watching `path` for changes.

On macOS, opens an fd for each watched path (and each subdirectory if
`recursive: true`). On Linux, adds an inotify watch.

May be called multiple times to watch multiple paths.

### close

```ts
close(): void
```

Stop watching all paths and release all resources.
Resolves any pending iterator .next() calls with `{ done: true }`.
