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

### format

```ts
format?: ArchiveFormat
```

Override format detection from the archive file extension.

### readOnly

```ts
readOnly?: boolean
```

Prevent write operations on the opened archive.

## ArchiveWriteOptions

```ts
interface ArchiveWriteOptions {
```

Metadata used when creating or replacing an archive entry.

### kind

```ts
kind?: ArchiveKind
```

Whether the entry should be stored as a file or directory.

### compression

```ts
compression?: ZipCompression
```

Zip compression mode. Tar archives ignore this option.

### mtime

```ts
mtime?: Date | number
```

Modification timestamp stored in the archive entry.

### mode

```ts
mode?: number
```

POSIX file mode stored in tar/zip metadata.

## ArchiveEntryInfo

```ts
interface ArchiveEntryInfo {
```

Normalized metadata for one archive entry.

### name

```ts
name: string
```

### kind

```ts
kind: ArchiveKind
```

### size

```ts
size: number
```

### compressedSize

```ts
compressedSize: number
```

### mtime

```ts
mtime: Date | null
```

### mode

```ts
mode: number | null
```

## ExtractResult

```ts
interface ExtractResult {
```

Result returned by extraction helpers.

### entries

```ts
entries: number
```

Number of file entries written to disk. Directory entries are not counted.

## Archive

```ts
class Archive {
```

Mutable archive reader/writer for zip, tar, and tar.gz files.

Archives created with `Archive.create()` are written when `save()` or
`close()` is called. Archives opened read-only reject mutating operations.

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

### path

```ts
get path(): string
```

Filesystem path backing this archive.

### format

```ts
get format(): ArchiveFormat
```

Archive format in use after extension or option detection.

### closed

```ts
get closed(): boolean
```

Whether the archive handle has been closed.

### create

```ts
static async create(path: string, options: ArchiveOpenOptions = {}): Promise<Archive>
```

Create a new empty archive handle without reading an existing file.

### open

```ts
static async open(path: string, options: ArchiveOpenOptions = {}): Promise<Archive>
```

Open and parse an existing archive from disk.

### _entryInfo

```ts
_entryInfo(name: string): ArchiveEntryInfo
```

### entries

```ts
async entries(): Promise<ArchiveEntryInfo[]>
```

List archive entries in normalized path order.

### entry

```ts
async entry(name: string): Promise<ArchiveEntryHandle | null>
```

Return a handle for an entry, or `null` if no entry exists at that path.

### read

```ts
async read(name: string): Promise<Uint8Array>
```

Read one file entry as bytes. Directory entries return an empty byte array.

### readText

```ts
async readText(name: string): Promise<string>
```

Read one file entry as UTF-8 text.

### write

```ts
async write(name: string, data: ArchiveInput, options: ArchiveWriteOptions = {}): Promise<void>
```

Create or replace one archive entry.

### addFile

```ts
async addFile(srcPath: string, archivePath: string | null = null, options: ArchiveWriteOptions = {}): Promise<void>
```

Add a host filesystem file to the archive.

### addDirectory

```ts
async addDirectory(srcPath: string, archivePath: string = ''): Promise<void>
```

Recursively add the contents of a host directory to the archive.

### remove

```ts
async remove(name: string): Promise<void>
```

Remove an entry if it exists.

### rename

```ts
async rename(oldName: string, newName: string): Promise<void>
```

Rename an existing entry, failing if the target name already exists.

### extract

```ts
async extract(destination: string, _options: object = {}): Promise<ExtractResult>
```

Extract all entries to `destination`, rejecting unsafe absolute or parent paths.

### save

```ts
async save(): Promise<void>
```

Serialize the archive to disk atomically through a temporary file.

### close

```ts
async close(): Promise<void>
```

Save pending changes when writable, then mark the handle closed.

## openArchive

```ts
async function openArchive(path: string, options: ArchiveOpenOptions = {}): Promise<Archive>
```

Open an existing archive from disk.

## createArchive

```ts
async function createArchive(path: string, options: ArchiveOpenOptions = {}): Promise<Archive>
```

Create a new archive handle for `path`.

## listArchive

```ts
async function listArchive(path: string, options: ArchiveOpenOptions = {}): Promise<ArchiveEntryInfo[]>
```

Open an archive, return its entry list, and close it.

## extractArchive

```ts
async function extractArchive(path: string, destination: string, options: ArchiveOpenOptions = {}): Promise<ExtractResult>
```

Open an archive, extract it to a destination directory, and close it.
