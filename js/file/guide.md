---
weight: 10
---
# File Guide

The file APIs provide POSIX filesystem access through explicit filesystem
objects, path helpers, and async file watching. Use them when application code
needs local files, directory traversal, or reload-on-change behavior.

## Create a Filesystem

Most file work starts with `DiskFileSystem`:

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
```

The filesystem is explicit instead of global. That makes file access easier to
replace in tests, realms, and future virtual filesystem providers.

## Read and Write Files

Use `readFile` and `writeFile` for whole-file text or byte operations:

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();

await fs.writeFile('./message.txt', 'hello\n');
const text = await fs.readFile('./message.txt');

console.log(text.trim());
```

Use `open` when you need a file handle:

```ts
const file = await fs.open('./message.txt', 'r');

try {
  for await (const chunk of file.reader()) {
    console.log('read bytes', chunk.byteLength);
  }
} finally {
  await file.close();
}
```

Close file handles when you are done with them. Readers and writers borrow the
file descriptor; the file handle owns it.

## Work with Directories

Use `dir` for directory entries and `glob` for pattern-based traversal:

```ts
const dir = await fs.dir('./js');

for await (const entry of dir) {
  console.log(entry.path.toString());
}

for await (const entry of fs.glob('js/**/*.mts')) {
  console.log('module', entry.path.toString());
}
```

Use `stat` or `lstat` when you need metadata:

```ts
const stat = await fs.stat('./README.md');

if (stat.isFile()) {
  console.log('README is a file');
}
```

## Paths

Use `fino:file/path` when code needs to build or normalize paths instead of
manually concatenating strings:

```ts
import { join } from 'fino:file/path';

const configPath = join(process.cwd(), 'config', 'app.toml');
```

Path helpers keep platform behavior localized and make call sites easier to
read. Fino's current release contract is POSIX-first: `/` is the path
separator, drive-letter paths are not absolute, and backslashes are ordinary
filename characters rather than Windows separators.

## Watch Files

Use `Watcher` for rebuild, reload, or synchronization workflows:

```ts
import { Watcher } from 'fino:file/watch';

const watcher = new Watcher({ recursive: true });
watcher.watch('./src');

for await (const event of watcher) {
  console.log(event.type, event.path);
}
```

Call `watcher.close()` when the workflow should stop. Recursive watching has
platform-specific limits: macOS uses one file descriptor per watched path, while
Linux uses inotify watches.

## Common Choices

- Use `readFile` and `writeFile` for simple whole-file operations.
- Use `open`, `reader`, and `writer` for streaming or handle-oriented work.
- Use `glob` when selecting many files by pattern.
- Use `Watcher` when a long-running process should react to changes.
- Pass filesystem objects into code that needs testability or realm-specific
  file access.
- Use explicit `mkdir`, `rmdir`, and `unlink` operations for directory and file
  removal. `mkdir` creates one directory level and does not implement Node's
  recursive option shape.

## Release Scope

`fino:file` is not Node `fs` or `fs/promises` parity. There is no global `fs`,
no `Buffer` global, no `fs.promises` namespace, no `rm()` convenience API, no
recursive remove helper, and no read/write encoding option matrix. Whole-file
helpers accept UTF-8 strings or byte data (`Uint8Array` / `ArrayBuffer`) and
return UTF-8 strings. Use file handles for lower-level byte reads and writes.
