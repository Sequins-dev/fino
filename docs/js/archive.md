# archive

fino:archive — zip, tar, and tar.gz archive helpers implemented in JS.

This module reads, edits, creates, lists, and extracts common archive files
without shelling out to platform tools. It is intended for application-level
packaging workflows: bundling generated files, accepting uploaded archives,
unpacking fixture data, or producing portable build artifacts from Fino code.

Supported formats:
  - `zip`: local file headers plus a central directory, with stored or raw
    DEFLATE-compressed file entries.
  - `tar`: POSIX ustar-style 512-byte records with regular files and
    directories.
  - `tar.gz`: tar content wrapped in gzip compression via `fino:compress`.

Format detection is based on the destination path extension unless
`ArchiveOpenOptions.format` is supplied. Writable archive handles keep an
in-memory entry table and write the whole archive atomically through a
temporary file on `save()` or `close()`. Read-only helpers such as
`listArchive()` and `extractArchive()` open the archive, perform the single
operation, and close it for you.

## Safety model

Extraction rejects absolute paths and parent-directory escapes before writing
to disk, removes pre-existing symlinks at output paths, and ignores tar
hardlink/symlink entries. ZIP and tar parsing also enforce a maximum
decompressed entry size to reduce zip-bomb style expansion risks. Archives
are still untrusted input: callers should extract into a dedicated directory
and apply their own file-count, total-size, and business-policy limits.

## Examples

```ts
import { Archive, extractArchive, listArchive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('README.md', '# Project\n');
await archive.addFile('dist/app.js', 'app.js');
await archive.close();

const entries = await listArchive('bundle.zip');
await extractArchive('bundle.zip', 'unpacked');
```

```ts
import { createArchive } from 'fino:archive';

const archive = await createArchive('release.tar.gz');
await archive.addDirectory('dist', 'package');
await archive.save();
await archive.close();
```

Useful references:
  - ZIP APPNOTE: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
  - POSIX pax/tar format: https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html
  - gzip file format: https://www.rfc-editor.org/rfc/rfc1952

## ArchiveOpenOptions

```ts
interface ArchiveOpenOptions {
```

Options for opening or creating an archive.

Format detection normally follows the archive path extension. `readOnly`
applies to opened handles and prevents mutating methods from writing.

```ts
import { Archive, type ArchiveOpenOptions } from 'fino:archive';

const options: ArchiveOpenOptions = {
  format: 'tar.gz',
  readOnly: true,
};
const archive = await Archive.open('release.artifact', options);
await archive.extract('release');
await archive.close();
```

### format

```ts
format?: ArchiveFormat
```

Override format detection from the archive file extension.

Use this when the path does not end with `.zip`, `.tar`, `.tar.gz`, or
`.tgz`. Unsupported values are rejected by TypeScript and should not be
supplied dynamically.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.data', { format: 'zip' });
await archive.write('README.md', 'hello');
await archive.close();
```

### readOnly

```ts
readOnly?: boolean
```

Prevent write operations on the opened archive.

Read-only handles can list, read, and extract entries. Mutating methods
such as `write()`, `remove()`, `rename()`, and `save()` throw.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.open('bundle.zip', { readOnly: true });
const entries = await archive.entries();
await archive.close();
```

## ArchiveWriteOptions

```ts
interface ArchiveWriteOptions {
```

Metadata used when creating or replacing an archive entry.

Omitted fields use archive defaults: file entries default to mode `0o644`,
directory entries default to `0o755`, timestamps default to the current time,
and ZIP entries default to deflate compression.

```ts
import { Archive, type ArchiveWriteOptions } from 'fino:archive';

const options: ArchiveWriteOptions = {
  compression: 'store',
  mode: 0o600,
};
const archive = await Archive.create('secrets.zip');
await archive.write('token.txt', new Uint8Array([1, 2, 3]), options);
await archive.close();
```

### kind

```ts
kind?: ArchiveKind
```

Whether the entry should be stored as a file or directory.

When omitted, names ending with `/` are directories and all other entries
are files. Directory entries read back as empty byte arrays.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('site.tar');
await archive.write('assets/', new Uint8Array(), { kind: 'directory' });
await archive.close();
```

### compression

```ts
compression?: ZipCompression
```

ZIP compression mode.

Tar archives ignore this option. `deflate` is the default for file entries;
`store` writes uncompressed ZIP file data.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('assets.zip');
await archive.write('image.bin', new Uint8Array([1, 2, 3]), { compression: 'store' });
await archive.close();
```

### mtime

```ts
mtime?: Date | number
```

Modification timestamp stored in the archive entry.

A `Date` is used directly; a number is interpreted by `Date` as
milliseconds since the Unix epoch. ZIP timestamps are stored in DOS date
form and may lose precision.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('snapshot.zip');
await archive.write('README.md', 'hello', {
  mtime: new Date('2026-01-01T00:00:00Z'),
});
await archive.close();
```

### mode

```ts
mode?: number
```

POSIX file mode stored in tar or ZIP metadata.

Only metadata is stored; extraction currently writes file contents and
directories but does not apply every archived mode bit.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('tools.tar');
await archive.write('bin/run.sh', '#!/bin/sh\n', { mode: 0o755 });
await archive.close();
```

## ArchiveEntryInfo

```ts
interface ArchiveEntryInfo {
```

Normalized metadata for one archive entry.

Returned by listing APIs and entry handles. Paths are normalized to archive
form with forward slashes and no leading slash.

```ts
import { listArchive, type ArchiveEntryInfo } from 'fino:archive';

const entries: ArchiveEntryInfo[] = await listArchive('bundle.zip');
const files = entries.filter((entry) => entry.kind === 'file');
const firstFile = files[0];
```

### name

```ts
name: string
```

Normalized archive path.

Names use `/` separators and omit leading slashes. Empty names are not
valid for writable entries.

```ts
import { listArchive } from 'fino:archive';

const readme = (await listArchive('bundle.zip'))
  .find((entry) => entry.name === 'README.md');
```

### kind

```ts
kind: ArchiveKind
```

Entry kind.

Directory entries do not carry file payloads and read as empty byte arrays.

```ts
import { listArchive } from 'fino:archive';

const directories = (await listArchive('bundle.tar'))
  .filter((entry) => entry.kind === 'directory');
```

### size

```ts
size: number
```

Uncompressed entry size in bytes.

Directory entries report `0`. ZIP entries may load data lazily, but this
value is available from archive metadata.

```ts
import { listArchive } from 'fino:archive';

const largeFiles = (await listArchive('bundle.zip'))
  .filter((entry) => entry.kind === 'file' && entry.size > 1_000_000);
```

### compressedSize

```ts
compressedSize: number
```

Compressed size in bytes.

For tar entries this is the same as `size`. For ZIP entries it reflects
the stored compressed payload size.

```ts
import { listArchive } from 'fino:archive';

const compressedFiles = (await listArchive('bundle.zip'))
  .filter((entry) => entry.compressedSize < entry.size);
```

### mtime

```ts
mtime: Date | null
```

Modification time stored in the archive, when available.

Some archive entries do not carry a timestamp and return `null`.

```ts
import { listArchive } from 'fino:archive';

const cutoff = new Date('2026-01-01T00:00:00Z');
const recentEntries = (await listArchive('bundle.zip'))
  .filter((entry) => entry.mtime !== null && entry.mtime >= cutoff);
```

### mode

```ts
mode: number | null
```

POSIX mode stored in archive metadata, when available.

The value may be `null` when the source archive did not provide usable mode
metadata.

```ts
import { listArchive } from 'fino:archive';

const executableEntries = (await listArchive('tools.tar'))
  .filter((entry) => entry.mode !== null && (entry.mode & 0o111) !== 0);
```

## ExtractResult

```ts
interface ExtractResult {
```

Result returned by extraction helpers.

Counts regular file entries written to disk. Directory entries are created as
needed but are not included in the count.

```ts
import { extractArchive, type ExtractResult } from 'fino:archive';

const result: ExtractResult = await extractArchive('bundle.zip', 'out');
if (result.entries === 0) throw new Error('archive did not contain files');
```

### entries

```ts
entries: number
```

Number of file entries written to disk.

Directory entries are not counted. If extraction throws partway through,
no `ExtractResult` is returned and previously written files remain on disk.

```ts
import { extractArchive } from 'fino:archive';

const result = await extractArchive('bundle.zip', 'out');
if (result.entries > 1000) throw new Error('unexpectedly large archive');
```

## Archive

```ts
class Archive {
```

Mutable archive reader/writer for zip, tar, and tar.gz files.

Archives created with `Archive.create()` are written when `save()` or
`close()` is called. Archives opened read-only reject mutating operations.
Reading methods throw when an entry is missing; `entry()` is the nullable
lookup helper.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('README.md', '# Project\n');
await archive.close();
```

### constructor

```ts
constructor(path: string, format: ArchiveFormat, options: ArchiveOpenOptions = {})
```

Create an archive handle with an explicit format.

This constructor does not read or write the archive file. Prefer
`Archive.create()` or `Archive.open()` for extension-based format
detection and parsing.

```ts
import { Archive } from 'fino:archive';

const archive = new Archive('bundle.zip', 'zip');
await archive.close();
```

### path

```ts
get path(): string
```

Filesystem path backing this archive.

Writable `save()` and `close()` serialize to this path. The value is the
string provided to the constructor or factory.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
console.log(archive.path);
await archive.close();
```

### format

```ts
get format(): ArchiveFormat
```

Archive format in use after extension or option detection.

The value is `'zip'`, `'tar'`, or `'tar.gz'`.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.tar.gz');
console.log(archive.format);
await archive.close();
```

### closed

```ts
get closed(): boolean
```

Whether the archive handle has been closed.

Closed archives reject all operations that require an open handle. Calling
`close()` more than once is allowed.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.close();
console.log(archive.closed);
```

### create

```ts
static async create(path: string, options: ArchiveOpenOptions = {}): Promise<Archive>
```

Create a new empty archive handle without reading an existing file.

The archive is written when `save()` is called or when a dirty writable
handle is closed. Existing files at `path` are replaced on save.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('README.md', 'hello');
await archive.close();
```

### open

```ts
static async open(path: string, options: ArchiveOpenOptions = {}): Promise<Archive>
```

Open and parse an existing archive from disk.

ZIP file payloads may be loaded lazily; tar payloads are parsed from the
archive bytes. Throws when the file cannot be read, the format cannot be
inferred, or the archive structure is invalid.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.open('bundle.zip', { readOnly: true });
console.log(await archive.entries());
await archive.close();
```

### entries

```ts
async entries(): Promise<ArchiveEntryInfo[]>
```

List archive entries in normalized path order.

Returns metadata only; file payloads are not decoded unless already loaded.
Throws if the archive is closed.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('README.md', 'hello');
console.log((await archive.entries())[0].name);
await archive.close();
```

### entry

```ts
async entry(name: string): Promise<ArchiveEntryHandle | null>
```

Return a handle for an entry, or `null` if no entry exists at that path.

The lookup name is normalized before matching, so `docs/./README.md` and
`docs/README.md` refer to the same archive entry. Throws if the archive is
closed.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('README.md', 'hello');
const entry = await archive.entry('./README.md');
console.log(entry?.size);
await archive.close();
```

### read

```ts
async read(name: string): Promise<Uint8Array>
```

Read one file entry as bytes.

Directory entries return an empty byte array. ZIP entries compressed with
unsupported methods throw when read. Missing entries and closed archives
throw.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('data.bin', new Uint8Array([1, 2, 3]));
console.log((await archive.read('data.bin')).byteLength);
await archive.close();
```

### readText

```ts
async readText(name: string): Promise<string>
```

Read one file entry as UTF-8 text.

This decodes `read(name)` with `TextDecoder`. Directory entries decode as
an empty string. Invalid UTF-8 uses replacement behavior.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('README.md', 'hello');
console.log(await archive.readText('README.md'));
await archive.close();
```

### write

```ts
async write(name: string, data: ArchiveInput, options: ArchiveWriteOptions = {}): Promise<void>
```

Create or replace one archive entry.

Entry names are normalized to archive paths. Empty names throw. Strings are
encoded as UTF-8. Writable archives are marked dirty and are persisted by
`save()` or `close()`. Read-only and closed archives throw.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('README.md', '# Project\n', { mode: 0o644 });
await archive.close();
```

### addFile

```ts
async addFile(
  srcPath: string,
  archivePath: string | null = null,
  options: ArchiveWriteOptions = {
  }
): Promise<void>
```

Add a host filesystem file to the archive.

Reads the entire source file into memory and stores it under `archivePath`
or the source basename when `archivePath` is `null`. Source mtime and mode
are copied unless overridden. Throws on source read/stat errors, read-only
archives, or closed archives.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.addFile('dist/app.js', 'app.js');
await archive.close();
```

### addDirectory

```ts
async addDirectory(srcPath: string, archivePath: string = ''): Promise<void>
```

Recursively add the contents of a host directory to the archive.

Directory contents are walked through the Fino filesystem APIs. Regular
files are added; directories are traversed. Symlinks and special files are
skipped by the current implementation. Throws on directory read failures or
when the archive is not writable.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.tar.gz');
await archive.addDirectory('dist', 'package');
await archive.close();
```

### remove

```ts
async remove(name: string): Promise<void>
```

Remove an entry if it exists.

Missing entries are ignored. Removing an existing entry marks the archive
dirty. Read-only and closed archives throw.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('old.txt', 'old');
await archive.remove('old.txt');
await archive.close();
```

### rename

```ts
async rename(oldName: string, newName: string): Promise<void>
```

Rename an existing entry, failing if the target name already exists.

Both names are normalized before lookup. Throws if the source is missing,
the target exists, the archive is read-only, or the archive is closed.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('draft.txt', 'hello');
await archive.rename('draft.txt', 'README.txt');
await archive.close();
```

### extract

```ts
async extract(destination: string, _options: object = {}): Promise<ExtractResult>
```

Extract all entries to `destination`.

Extraction rejects absolute archive paths and parent-directory escapes,
removes pre-existing symlinks at output file paths, creates directories as
needed, and counts only file entries in the result. Existing regular files
are overwritten. If extraction throws, previously written files remain.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.open('bundle.zip', { readOnly: true });
const result = await archive.extract('unpacked');
console.log(result.entries);
await archive.close();
```

### save

```ts
async save(): Promise<void>
```

Serialize the archive to disk atomically through a temporary file.

The parent directory is created when needed. The archive is written to a
unique temporary path, then renamed into place. Read-only and closed
archives throw. Successful saves clear the dirty flag.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('README.md', 'hello');
await archive.save();
await archive.close();
```

### close

```ts
async close(): Promise<void>
```

Save pending changes when writable, then mark the handle closed.

Calling `close()` more than once is allowed. Dirty writable archives are
saved automatically; read-only archives are simply closed.

```ts
import { Archive } from 'fino:archive';

const archive = await Archive.create('bundle.zip');
await archive.write('README.md', 'hello');
await archive.close();
```

## openArchive

```ts
async function openArchive(path: string, options: ArchiveOpenOptions = {}): Promise<Archive>
```

Open an existing archive from disk.

Convenience wrapper for `Archive.open()`. Pass `{ readOnly: true }` to reject
writes. Throws on read, format, or parse failures.

```ts
import { openArchive } from 'fino:archive';

const archive = await openArchive('bundle.zip', { readOnly: true });
console.log(await archive.entries());
await archive.close();
```

## createArchive

```ts
async function createArchive(path: string, options: ArchiveOpenOptions = {}): Promise<Archive>
```

Create a new archive handle for `path`.

Convenience wrapper for `Archive.create()`. The archive is not written until
`save()` or writable `close()`.

```ts
import { createArchive } from 'fino:archive';

const archive = await createArchive('bundle.tar');
await archive.write('README.md', 'hello');
await archive.close();
```

## listArchive

```ts
async function listArchive(
  path: string,
  options: ArchiveOpenOptions = {
  }
): Promise<ArchiveEntryInfo[]>
```

Open an archive, return its entry list, and close it.

The archive is opened read-only regardless of `options.readOnly`. Throws on
read, parse, or listing failures.

```ts
import { listArchive } from 'fino:archive';

const entries = await listArchive('bundle.zip');
console.log(entries.map((entry) => entry.name));
```

## extractArchive

```ts
async function extractArchive(
  path: string,
  destination: string,
  options: ArchiveOpenOptions = {
  }
): Promise<ExtractResult>
```

Open an archive, extract it to a destination directory, and close it.

The archive is opened read-only regardless of `options.readOnly`. Extraction
uses the same safety checks as `Archive#extract()`: absolute paths and parent
escapes are rejected, and pre-existing symlinks at output paths are removed.

```ts
import { extractArchive } from 'fino:archive';

const result = await extractArchive('bundle.zip', 'unpacked');
console.log(result.entries);
```
