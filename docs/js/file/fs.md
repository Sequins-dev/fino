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
const fs = new DiskFileSystem(lp);
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

## DiskFileSystem

```ts
class DiskFileSystem extends FileSystem {
```

A POSIX filesystem backend backed by libc syscalls via FFI.

```ts
const fs = new DiskFileSystem(lp);
const text = await fs.readFile('/etc/hosts');
```

### stat

```ts
async stat(path: Path | string): Promise<Stat>
```

Stat a path, following symlinks.

### lstat

```ts
async lstat(path: Path | string): Promise<Stat>
```

Stat a path without following symlinks.

### open

```ts
async open(path: Path | string, mode: string = 'r'): Promise<File>
```

Open a file and return a File handle.

### dir

```ts
async dir(path: Path | string): Promise<DirEntry>
```

Open a directory and return a DirEntry handle.
Throws if the path does not refer to a directory.

### entry

```ts
async entry(path: Path | string): Promise<Entry>
```

Construct an Entry (FileEntry / DirEntry / Entry) for any path using lstat.

### mkdir

```ts
async mkdir(path: Path | string, mode: number = 0o755): Promise<void>
```

Create a directory.

### rmdir

```ts
async rmdir(path: Path | string): Promise<void>
```

Remove an empty directory.

### unlink

```ts
async unlink(path: Path | string): Promise<void>
```

Delete a file.

### chmod

```ts
async chmod(path: Path | string, mode: number): Promise<void>
```

Change the permissions of a file.

### chown

```ts
async chown(path: Path | string, uid: number, gid: number): Promise<void>
```

Change the owner and group of a file, following symlinks.

### lchown

```ts
async lchown(path: Path | string, uid: number, gid: number): Promise<void>
```

Change the owner and group of a file without following symlinks.

### utimes

```ts
async utimes(path: Path | string, atime: Date | number, mtime: Date | number): Promise<void>
```

Set the access and modification times of a file.

### truncate

```ts
async truncate(path: Path | string, size = 0): Promise<void>
```

Truncate a file to a specified length.

### link

```ts
async link(existingPath: Path | string, newPath: Path | string): Promise<void>
```

Create a hard link.

### access

```ts
async access(path: Path | string, mode = F_OK): Promise<void>
```

Test access to a path.

### copyFile

```ts
async copyFile(src: Path | string, dest: Path | string): Promise<void>
```

Copy a file, preserving permissions.

### rename

```ts
async rename(oldPath: Path | string, newPath: Path | string): Promise<void>
```

Rename or move a file or directory.

### readlink

```ts
async readlink(path: Path | string): Promise<string>
```

Read the target of a symbolic link.

### symlink

```ts
async symlink(target: Path | string, linkpath: Path | string): Promise<void>
```

Create a symbolic link.

### realpath

```ts
async realpath(path: Path | string): Promise<string>
```

Resolve the canonical absolute path, expanding symlinks.

### readFile

```ts
async readFile(path: Path | string): Promise<string>
```

Read an entire file and return its UTF-8 contents as a string.

### writeFile

```ts
async writeFile(path: Path | string, data: string | Uint8Array | ArrayBuffer): Promise<void>
```

Write data to a file, creating or truncating it.

### glob

```ts
glob(pattern: string, options?: GlobOptions): AsyncGenerator<Entry>
```

Walk the filesystem matching entries against a glob pattern.
Yields `Entry` / `FileEntry` / `DirEntry` objects for each match.

```ts
for await (const entry of fs.glob('**\/*.mts')) {
  console.log(entry.path.toString());
}
```
