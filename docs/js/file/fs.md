# fs

fino:file — POSIX filesystem with async I/O and a virtualizable handle model.

This module provides file and directory access via `libc` FFI. It exposes a
`DiskFileSystem` class that wraps every relevant POSIX syscall: `open(2)`,
`read(2)`, `write(2)`, `stat(2)`, `readdir(3)`, `rename(2)`, `symlink(2)`,
etc. The I/O is wired to the event loop so that reads and writes yield
control to other async tasks while waiting for the kernel.

## Design: explicit filesystem instance

Unlike Node.js's implicit global `fs` module, here callers construct a
`DiskFileSystem` explicitly and pass their loop handle:

```ts
const fs = new DiskFileSystem();
```

This is intentional. It makes the event-loop dependency visible, enables
future alternative backends (in-memory, zip archive, overlay), and avoids
shared global state that makes testing harder.

## Object hierarchy

  DiskFileSystem          — the factory; owns no fds itself
    .open()   → File      — an open fd; owns the fd lifecycle
      .reader()  → async iterable of Uint8Array chunks
      .writer()  → Writer (from fino:stream)
      .bytes()   → Promise<Uint8Array>  (reads entire file)
      .text()    → Promise<string>
    .dir()    → DirEntry  — directory handle (uses opendir/readdir/closedir)
      .entries() → Promise<Entry[]>
      [Symbol.asyncIterator]  — iterates entries
    .entry()  → Entry / FileEntry / DirEntry

`File` owns its fd and closes it on `file.close()`. The Reader/Writer
produced by `file.reader()` / `file.writer()` borrow the fd with a no-op
`onClose` callback — do not close the Reader/Writer to release the fd; call
`file.close()` instead.

## F_OK

```ts
const F_OK
```

Access flag that checks whether a path exists.

Pass this to `DiskFileSystem.access()` when existence is the only required
condition. This is the default mode.

```ts
import { DiskFileSystem, F_OK } from 'fino:file';

const fs = new DiskFileSystem();
await fs.access('/tmp/app.log', F_OK);
```

## R_OK

```ts
const R_OK
```

Access flag that checks read permission for the current process.

Combine with `W_OK` or `X_OK` using bitwise OR when multiple permissions are
required.

```ts
import { DiskFileSystem, R_OK } from 'fino:file';

const fs = new DiskFileSystem();
await fs.access('/tmp/app.log', R_OK);
```

## W_OK

```ts
const W_OK
```

Access flag that checks write permission for the current process.

The result reflects the process credentials and platform `access(2)`
behavior; it is not a guarantee that a later write will succeed.

```ts
import { DiskFileSystem, W_OK } from 'fino:file';

const fs = new DiskFileSystem();
await fs.access('/tmp/app.log', W_OK);
```

## X_OK

```ts
const X_OK
```

Access flag that checks execute/search permission for the current process.

For directories this checks search permission. For files this checks
executable permission according to the platform.

```ts
import { DiskFileSystem, X_OK } from 'fino:file';

const fs = new DiskFileSystem();
await fs.access('/tmp/script.sh', X_OK);
```

## DiskFileSystem

```ts
class DiskFileSystem extends FileSystem {
```

A POSIX filesystem backend backed by libc syscalls via FFI.

Each method accepts either a raw path string or a `Path` instance. Methods
throw errno-backed errors when the underlying syscall fails; they do not
return `null` for missing paths unless documented by a lower-level handle
API. File handles returned from `open()` must be closed by the caller.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const text = await fs.readFile('/etc/hosts');
```

### stat

```ts
async stat(path: Path | string): Promise<Stat>
```

Stat a path, following symlinks.

Returns parsed POSIX metadata for the target. If `path` is a symlink, the
returned `Stat` describes the symlink target. Throws when the path cannot
be resolved or the process lacks permission.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const stat = await fs.stat('/tmp/app.log');
console.log(stat.isFile(), stat.size);
```

### lstat

```ts
async lstat(path: Path | string): Promise<Stat>
```

Stat a path without following symlinks.

Returns metadata for the directory entry itself. For symlinks, this
describes the link rather than the linked target. Throws on missing paths,
permission failures, or other `lstat(2)` errors.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const stat = await fs.lstat('/tmp/current');
console.log(stat.isSymlink());
```

### open

```ts
async open(path: Path | string, mode: string = 'r'): Promise<File>
```

Open a file and return a File handle.

The default mode is `'r'`. Mode strings are translated to POSIX open flags
by the file bindings; create modes use `0o666` before the process umask and
then normalize new files to `0o644`. Throws if the file cannot be opened.
Close the returned `File` when finished.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const file = await fs.open('/tmp/out.txt', 'w');
try {
  await file.writer().write(new TextEncoder().encode('hello'));
} finally {
  await file.close();
}
```

### dir

```ts
async dir(path: Path | string): Promise<DirEntry>
```

Open a directory and return a DirEntry handle.
Throws if the path does not refer to a directory.

The returned entry can enumerate children with `entries()` or async
iteration. Symlinks are not followed for the directory check.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const dir = await fs.dir('/tmp');
for (const entry of await dir.entries()) console.log(entry.name);
```

### entry

```ts
async entry(path: Path | string): Promise<Entry>
```

Construct an Entry (FileEntry / DirEntry / Entry) for any path using lstat.

Directories become `DirEntry`, regular files become `FileEntry`, symlinks
become a generic `Entry` with link type, and other filesystem nodes become
a generic `Entry` with unknown type. Throws if `path` cannot be lstat'ed.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const entry = await fs.entry('/tmp/app.log');
console.log(entry.name, entry.isFile());
```

### mkdir

```ts
async mkdir(path: Path | string, mode: number = 493): Promise<void>
```

Create a directory.

Creates exactly one directory. Parent directories are not created
automatically. The default mode is `0o755` before the process umask.
Throws if the path exists, a parent is missing, or permissions fail.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.mkdir('/tmp/fino-cache', 0o700);
```

### rmdir

```ts
async rmdir(path: Path | string): Promise<void>
```

Remove an empty directory.

This wraps `rmdir(2)`, so it only succeeds for empty directories. It
throws if the path is not a directory, is not empty, is missing, or cannot
be removed.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.rmdir('/tmp/empty-cache');
```

### unlink

```ts
async unlink(path: Path | string): Promise<void>
```

Delete a file.

Removes a directory entry with `unlink(2)`. For symlinks, the link itself
is removed and the target is left untouched. Throws for directories,
missing paths, or permission failures.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.unlink('/tmp/output.tmp');
```

### chmod

```ts
async chmod(path: Path | string, mode: number): Promise<void>
```

Change the permissions of a file.

Follows symlinks, matching `chmod(2)`. Throws when the target is missing or
the process cannot change permissions.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.chmod('/tmp/run.sh', 0o755);
```

### chown

```ts
async chown(path: Path | string, uid: number, gid: number): Promise<void>
```

Change the owner and group of a file, following symlinks.

Pass numeric user and group IDs. This follows symlinks and usually
requires elevated privileges. Throws for missing paths, invalid IDs, or
permission failures.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.chown('/tmp/app.log', 501, 20);
```

### lchown

```ts
async lchown(path: Path | string, uid: number, gid: number): Promise<void>
```

Change the owner and group of a file without following symlinks.

For symlinks, changes ownership of the link itself. The same permission
and platform caveats as `lchown(2)` apply.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.lchown('/tmp/current-link', 501, 20);
```

### utimes

```ts
async utimes(path: Path | string, atime: Date | number, mtime: Date | number): Promise<void>
```

Set the access and modification times of a file.

Numeric timestamps are interpreted as seconds since the Unix epoch. `Date`
values are converted to fractional seconds. Throws when the target is
missing or timestamp updates are not permitted.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.utimes('/tmp/app.log', new Date(), new Date());
```

### truncate

```ts
async truncate(path: Path | string, size = 0): Promise<void>
```

Truncate a file to a specified length.

The default size is `0`, which empties the file. Growing a file may create
sparse zero-filled space depending on the filesystem. Throws if the path is
missing, not writable, or invalid for truncation.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.truncate('/tmp/app.log');
```

### link

```ts
async link(existingPath: Path | string, newPath: Path | string): Promise<void>
```

Create a hard link.

Creates `newPath` as another directory entry for `existingPath`. The source
and destination must usually be on the same filesystem. Throws when the
target exists, the source is missing, or hard links are not allowed.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.link('/tmp/report.txt', '/tmp/report-copy.txt');
```

### access

```ts
async access(path: Path | string, mode = F_OK): Promise<void>
```

Test access to a path.

Wraps `access(2)`. The default mode is `F_OK`, which only checks
existence. Combine `R_OK`, `W_OK`, and `X_OK` to check permissions from
the process perspective. Throws when the requested access is unavailable.

```ts
import { DiskFileSystem, R_OK, W_OK } from 'fino:file';

const fs = new DiskFileSystem();
await fs.access('/tmp/app.log', R_OK | W_OK);
```

### copyFile

```ts
async copyFile(src: Path | string, dest: Path | string): Promise<void>
```

Copy a file, preserving permissions.

Reads the entire source file into memory, writes the destination with
truncation, then applies the source mode bits. This is intended for modest
files; stream manually for very large files. Throws if either open, read,
write, or chmod step fails.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.copyFile('/tmp/input.txt', '/tmp/output.txt');
```

### rename

```ts
async rename(oldPath: Path | string, newPath: Path | string): Promise<void>
```

Rename or move a file or directory.

Wraps `rename(2)`. Existing destination behavior follows the host POSIX
rules. Moving across filesystems may fail. Throws on missing sources,
invalid destinations, or permission errors.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.rename('/tmp/upload.tmp', '/tmp/upload.txt');
```

### readlink

```ts
async readlink(path: Path | string): Promise<string>
```

Read the target of a symbolic link.

Returns the raw link target string exactly as stored by the symlink. The
target may be relative and may not exist. Throws if `path` is not a symlink
or cannot be read.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
console.log(await fs.readlink('/tmp/current'));
```

### symlink

```ts
async symlink(target: Path | string, linkpath: Path | string): Promise<void>
```

Create a symbolic link.

The `target` is stored as provided; it is not required to exist and is not
normalized. Throws if `linkpath` already exists or the platform rejects the
link creation.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.symlink('releases/current', '/tmp/app-current');
```

### realpath

```ts
async realpath(path: Path | string): Promise<string>
```

Resolve the canonical absolute path, expanding symlinks.

Wraps `realpath(3)` and returns a string. The path and all required
components must exist. Throws for missing components, loops, or permission
failures.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
console.log(await fs.realpath('/tmp/../tmp'));
```

### readFile

```ts
async readFile(path: Path | string): Promise<string>
```

Read an entire file and return its UTF-8 contents as a string.

Opens the file in read mode, reads all bytes, decodes them as UTF-8, and
closes the handle. This loads the full file into memory. Throws on open,
read, or decode-related filesystem errors.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const text = await fs.readFile('/tmp/config.json');
```

### writeFile

```ts
async writeFile(path: Path | string, data: string | Uint8Array | ArrayBuffer): Promise<void>
```

Write data to a file, creating or truncating it.

Opens the path with mode `'w'`, writes the full buffer, and closes the
handle. Strings are encoded as UTF-8. Parent directories are not created.
Throws on open or write failure.

```ts
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
await fs.writeFile('/tmp/message.txt', 'hello\n');
```

### glob

```ts
glob(pattern: string, options?: GlobOptions): AsyncGenerator<Entry>
```

Walk the filesystem matching entries against a glob pattern.
Yields `Entry` / `FileEntry` / `DirEntry` objects for each match.

Pattern evaluation is delegated to the internal glob walker. Directory
reads happen lazily as iteration advances. Errors from directory listing or
entry inspection propagate through the async iterator.

```ts
for await (const entry of fs.glob('**\/*.mts')) {
  console.log(entry.path.toString());
}
```
