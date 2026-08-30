/**
 * fino:archive — zip, tar, and tar.gz archive helpers implemented in JS.
 *
 * This module reads, edits, creates, lists, and extracts common archive files
 * without shelling out to platform tools. It is intended for application-level
 * packaging workflows: bundling generated files, accepting uploaded archives,
 * unpacking fixture data, or producing portable build artifacts from Fino code.
 *
 * Supported formats:
 *   - `zip`: local file headers plus a central directory, with stored or raw
 *     DEFLATE-compressed file entries.
 *   - `tar`: POSIX ustar-style 512-byte records with regular files and
 *     directories.
 *   - `tar.gz`: tar content wrapped in gzip compression via `fino:compress`.
 *
 * Format detection is based on the destination path extension unless
 * `ArchiveOpenOptions.format` is supplied. Writable archive handles keep an
 * in-memory entry table and write the whole archive atomically through a
 * temporary file on `save()` or `close()`. Read-only helpers such as
 * `listArchive()` and `extractArchive()` open the archive, perform the single
 * operation, and close it for you. These are whole-archive operations, not
 * streaming reader or writer APIs; callers should avoid using them for archives
 * that are too large to hold comfortably in memory.
 *
 * This release baseline intentionally supports a small, predictable archive
 * subset. ZIP64 records, ZIP data descriptors, tar PAX headers, GNU long-name
 * records, symlink restoration, and hardlink restoration are not supported.
 * Unsupported ZIP and tar extensions are rejected or skipped before extraction
 * writes file contents.
 *
 * ## Supported subset and validation map
 *
 * - ZIP entries use local headers plus central-directory records. Opening
 *   rejects truncated records, ZIP64 markers, data-descriptor entries, and
 *   central/local disagreement for flags, method, CRC, sizes, and name.
 * - ZIP file data is accepted only for stored and raw DEFLATE entries. Reads
 *   and extraction verify CRC-32 and enforce the decompressed entry-size limit.
 * - Tar parsing accepts regular files, directories, and POSIX ustar names.
 *   Header checksums, octal numeric fields, and payload lengths are validated.
 * - Tar symlink and hardlink typeflags are ignored during extraction; PAX and
 *   GNU long-name extensions are rejected because this module does not merge
 *   extension metadata into following entries.
 * - Archive paths are normalized to slash-separated relative names. Extraction
 *   rejects absolute paths and parent-directory escapes before touching output.
 * - `ArchiveExtractOptions.maxEntries` and `maxTotalBytes` add caller-supplied
 *   extraction limits on top of the built-in per-entry decompressed-size limit.
 * - `tar.gz` relies on `fino:compress` gzip member validation for the wrapping
 *   stream, caps the decoded tar payload, then applies the same tar validation
 *   as plain `.tar` archives.
 *
 * ## Safety model
 *
 * Extraction rejects absolute paths and parent-directory escapes before writing
 * to disk, removes pre-existing symlinks at output paths, and ignores tar
 * hardlink/symlink entries. ZIP and tar parsing also enforce a maximum
 * decompressed entry size to reduce zip-bomb style expansion risks. Archives
 * are still untrusted input: callers should extract into a dedicated directory
 * and apply their own file-count, total-size, and business-policy limits.
 *
 * ## Examples
 *
 * ```ts no_run
 * import { Archive, extractArchive, listArchive } from 'fino:archive';
 *
 * const archive = await Archive.create('bundle.zip');
 * await archive.write('README.md', '# Project\n');
 * await archive.addFile('dist/app.js', 'app.js');
 * await archive.close();
 *
 * const entries = await listArchive('bundle.zip');
 * await extractArchive('bundle.zip', 'unpacked');
 * ```
 *
 * ```ts no_run
 * import { createArchive } from 'fino:archive';
 *
 * const archive = await createArchive('release.tar.gz');
 * await archive.addDirectory('dist', 'package');
 * await archive.save();
 * await archive.close();
 * ```
 *
 * Useful references:
 *   - ZIP APPNOTE: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 *   - POSIX pax/tar format: https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html
 *   - gzip file format: https://www.rfc-editor.org/rfc/rfc1952
 */
import { DiskFileSystem } from './file/fs.ts';
import { compress, decompress } from 'fino:compress';
const fs = new DiskFileSystem();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ZIP_LOCAL_FILE_HEADER = 67324752;
const ZIP_CENTRAL_FILE_HEADER = 33639248;
const ZIP_END_OF_CENTRAL_DIR = 101010256;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const DEFAULT_MODE = 420;
const DEFAULT_DIR_MODE = 493;
// Max decompressed bytes per entry, and for a whole in-memory tar.gz payload.
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
/**
 * Archive container format supported by `Archive`.
 *
 * `zip` supports mutation and per-entry compression. `tar` and `tar.gz` use
 * tar headers, with `tar.gz` applying gzip compression to the whole archive.
 */
export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz';
/**
 * Entry kind stored in archive metadata.
 *
 * File entries carry payload bytes. Directory entries carry no payload and
 * read back as empty byte arrays.
 */
export type ArchiveKind = 'file' | 'directory';
/**
 * ZIP per-entry compression mode.
 *
 * `deflate` compresses file data and is the default. `store` writes the bytes
 * unchanged and is useful for already-compressed assets.
 */
export type ZipCompression = 'store' | 'deflate';
/**
 * Binary or text input accepted by archive write helpers.
 *
 * Strings are encoded as UTF-8. `Uint8Array` and `ArrayBuffer` inputs are
 * copied into the archive entry payload.
 */
export type ArchiveInput = string | Uint8Array | ArrayBuffer;
type ArchiveLoader = () => Promise<Uint8Array>;
/**
 * Options for opening or creating an archive.
 *
 * Format detection normally follows the archive path extension. `readOnly`
 * applies to opened handles and prevents mutating methods from writing.
 *
 * ```ts no_run
 * import { Archive, type ArchiveOpenOptions } from 'fino:archive';
 *
 * const options: ArchiveOpenOptions = {
 *   format: 'tar.gz',
 *   readOnly: true,
 * };
 * const archive = await Archive.open('release.artifact', options);
 * await archive.extract('release');
 * await archive.close();
 * ```
 */
export interface ArchiveOpenOptions {
  /**
   * Override format detection from the archive file extension.
   *
   * Use this when the path does not end with `.zip`, `.tar`, `.tar.gz`, or
   * `.tgz`. Unsupported values are rejected by TypeScript and should not be
   * supplied dynamically.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.data', { format: 'zip' });
   * await archive.write('README.md', 'hello');
   * await archive.close();
   * ```
   */
  format?: ArchiveFormat;
  /**
   * Prevent write operations on the opened archive.
   *
   * Read-only handles can list, read, and extract entries. Mutating methods
   * such as `write()`, `remove()`, `rename()`, and `save()` throw.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.open('bundle.zip', { readOnly: true });
   * const entries = await archive.entries();
   * await archive.close();
   * ```
   */
  readOnly?: boolean;
}
/**
 * Optional extraction policy limits.
 *
 * Limits are opt-in so existing extraction behavior remains unchanged unless a
 * caller supplies an explicit cap. `maxEntries` counts regular file entries
 * written to disk. `maxTotalBytes` counts uncompressed file payload bytes.
 */
export interface ArchiveExtractOptions extends ArchiveOpenOptions {
  /** Maximum number of regular file entries to extract. */
  maxEntries?: number;
  /** Maximum total uncompressed bytes to extract across regular files. */
  maxTotalBytes?: number;
}
/**
 * Metadata used when creating or replacing an archive entry.
 *
 * Omitted fields use archive defaults: file entries default to mode `0o644`,
 * directory entries default to `0o755`, timestamps default to the current time,
 * and ZIP entries default to deflate compression.
 *
 * ```ts no_run
 * import { Archive, type ArchiveWriteOptions } from 'fino:archive';
 *
 * const options: ArchiveWriteOptions = {
 *   compression: 'store',
 *   mode: 0o600,
 * };
 * const archive = await Archive.create('secrets.zip');
 * await archive.write('token.txt', new Uint8Array([1, 2, 3]), options);
 * await archive.close();
 * ```
 */
export interface ArchiveWriteOptions {
  /**
   * Whether the entry should be stored as a file or directory.
   *
   * When omitted, names ending with `/` are directories and all other entries
   * are files. Directory entries read back as empty byte arrays.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('site.tar');
   * await archive.write('assets/', new Uint8Array(), { kind: 'directory' });
   * await archive.close();
   * ```
   */
  kind?: ArchiveKind;
  /**
   * ZIP compression mode.
   *
   * Tar archives ignore this option. `deflate` is the default for file entries;
   * `store` writes uncompressed ZIP file data.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('assets.zip');
   * await archive.write('image.bin', new Uint8Array([1, 2, 3]), { compression: 'store' });
   * await archive.close();
   * ```
   */
  compression?: ZipCompression;
  /**
   * Modification timestamp stored in the archive entry.
   *
   * A `Date` is used directly; a number is interpreted by `Date` as
   * milliseconds since the Unix epoch. ZIP timestamps are stored in DOS date
   * form and may lose precision.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('snapshot.zip');
   * await archive.write('README.md', 'hello', {
   *   mtime: new Date('2026-01-01T00:00:00Z'),
   * });
   * await archive.close();
   * ```
   */
  mtime?: Date | number;
  /**
   * POSIX file mode stored in tar or ZIP metadata.
   *
   * Only metadata is stored; extraction currently writes file contents and
   * directories but does not apply every archived mode bit.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('tools.tar');
   * await archive.write('bin/run.sh', '#!/bin/sh\n', { mode: 0o755 });
   * await archive.close();
   * ```
   */
  mode?: number;
}
/**
 * Normalized metadata for one archive entry.
 *
 * Returned by listing APIs and entry handles. Paths are normalized to archive
 * form with forward slashes and no leading slash.
 *
 * ```ts no_run
 * import { listArchive, type ArchiveEntryInfo } from 'fino:archive';
 *
 * const entries: ArchiveEntryInfo[] = await listArchive('bundle.zip');
 * const files = entries.filter((entry) => entry.kind === 'file');
 * const firstFile = files[0];
 * ```
 */
export interface ArchiveEntryInfo {
  /**
   * Normalized archive path.
   *
   * Names use `/` separators and omit leading slashes. Empty names are not
   * valid for writable entries.
   *
   * ```ts no_run
   * import { listArchive } from 'fino:archive';
   *
   * const readme = (await listArchive('bundle.zip'))
   *   .find((entry) => entry.name === 'README.md');
   * ```
   */
  name: string;
  /**
   * Entry kind.
   *
   * Directory entries do not carry file payloads and read as empty byte arrays.
   *
   * ```ts no_run
   * import { listArchive } from 'fino:archive';
   *
   * const directories = (await listArchive('bundle.tar'))
   *   .filter((entry) => entry.kind === 'directory');
   * ```
   */
  kind: ArchiveKind;
  /**
   * Uncompressed entry size in bytes.
   *
   * Directory entries report `0`. ZIP entries may load data lazily, but this
   * value is available from archive metadata.
   *
   * ```ts no_run
   * import { listArchive } from 'fino:archive';
   *
   * const largeFiles = (await listArchive('bundle.zip'))
   *   .filter((entry) => entry.kind === 'file' && entry.size > 1_000_000);
   * ```
   */
  size: number;
  /**
   * Compressed size in bytes.
   *
   * For tar entries this is the same as `size`. For ZIP entries it reflects
   * the stored compressed payload size.
   *
   * ```ts no_run
   * import { listArchive } from 'fino:archive';
   *
   * const compressedFiles = (await listArchive('bundle.zip'))
   *   .filter((entry) => entry.compressedSize < entry.size);
   * ```
   */
  compressedSize: number;
  /**
   * Modification time stored in the archive, when available.
   *
   * Some archive entries do not carry a timestamp and return `null`.
   *
   * ```ts no_run
   * import { listArchive } from 'fino:archive';
   *
   * const cutoff = new Date('2026-01-01T00:00:00Z');
   * const recentEntries = (await listArchive('bundle.zip'))
   *   .filter((entry) => entry.mtime !== null && entry.mtime >= cutoff);
   * ```
   */
  mtime: Date | null;
  /**
   * POSIX mode stored in archive metadata, when available.
   *
   * The value may be `null` when the source archive did not provide usable mode
   * metadata.
   *
   * ```ts no_run
   * import { listArchive } from 'fino:archive';
   *
   * const executableEntries = (await listArchive('tools.tar'))
   *   .filter((entry) => entry.mode !== null && (entry.mode & 0o111) !== 0);
   * ```
   */
  mode: number | null;
}
/**
 * Result returned by extraction helpers.
 *
 * Counts regular file entries written to disk. Directory entries are created as
 * needed but are not included in the count.
 *
 * ```ts no_run
 * import { extractArchive, type ExtractResult } from 'fino:archive';
 *
 * const result: ExtractResult = await extractArchive('bundle.zip', 'out');
 * if (result.entries === 0) throw new Error('archive did not contain files');
 * ```
 */
export interface ExtractResult {
  /**
   * Number of file entries written to disk.
   *
   * Directory entries are not counted. If extraction throws partway through,
   * no `ExtractResult` is returned and previously written files remain on disk.
   *
   * ```ts no_run
   * import { extractArchive } from 'fino:archive';
   *
   * const result = await extractArchive('bundle.zip', 'out');
   * if (result.entries > 1000) throw new Error('unexpectedly large archive');
   * ```
   */
  entries: number;
}
interface LoadedArchiveEntry {
  name: string;
  kind: ArchiveKind;
  size: number;
  compressedSize: number;
  mtime: Date | null;
  mode: number;
  method: number;
  crc32?: number;
  data?: Uint8Array;
  loader?: ArchiveLoader;
}
interface DosDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
interface DosTimestamp {
  dosTime: number;
  dosDate: number;
}
function toU8(data: ArchiveInput): Uint8Array {
  if (typeof data === 'string') return textEncoder.encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}
function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}
function concatBytes(parts: Uint8Array[], total: number | null = null): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0]!;
  if (total === null) {
    total = 0;
    for (const part of parts) total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
function normalizedArchivePath(input: string): string {
  const text = String(input).replace(/\\/g, '/');
  const parts: string[] = [];
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    parts.push(part);
  }
  return parts.join('/');
}
function isUnsafeExtractPath(name: string): boolean {
  const raw = String(name).replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return true;
  const parts = raw.split('/');
  let depth = 0;
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      depth--;
      if (depth < 0) return true;
    } else {
      depth++;
    }
  }
  return false;
}
function dirname(path: string): string {
  const normalized = normalizedArchivePath(path);
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? '' : normalized.slice(0, idx);
}
function hostDirname(path: string): string {
  const text = String(path);
  const idx = text.lastIndexOf('/');
  if (idx < 0) return '';
  if (idx === 0) return '/';
  return text.slice(0, idx);
}
function basename(path: string): string {
  const normalized = normalizedArchivePath(path);
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? normalized : normalized.slice(idx + 1);
}
function inferFormat(path: string, options: ArchiveOpenOptions = {}): ArchiveFormat {
  if (options.format) return options.format;
  const text = String(path).toLowerCase();
  if (text.endsWith('.tar.gz') || text.endsWith('.tgz')) return 'tar.gz';
  if (text.endsWith('.tar')) return 'tar';
  if (text.endsWith('.zip')) return 'zip';
  throw new Error(`Unsupported archive format for '${path}'`);
}
async function readFileBytes(path: string): Promise<Uint8Array> {
  const file = await fs.open(path, 'r');
  try {
    return await file.bytes();
  } finally {
    await file.close();
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (_) {
    return false;
  }
}
async function ensureHostDir(path: string): Promise<void> {
  if (!path || path === '/') return;
  if (await exists(path)) return;
  const idx = path.lastIndexOf('/');
  if (idx > 0) await ensureHostDir(path.slice(0, idx));
  if (!(await exists(path))) await fs.mkdir(path);
}
async function uniqueTempPath(path: string): Promise<string> {
  for (let i = 0; i < 32; i++) {
    const candidate = `${path}.tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Could not allocate temporary path for '${path}'`);
}
function getDateParts(date: Date | number | null | undefined): DosDateParts {
  const value = date instanceof Date ? date : new Date(date ?? Date.now());
  return {
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
    hour: value.getHours(),
    minute: value.getMinutes(),
    second: value.getSeconds(),
  };
}
function dateToDos(date: Date | number | null | undefined): DosTimestamp {
  const { year, month, day, hour, minute, second } = getDateParts(date);
  const clampedYear = Math.max(1980, Math.min(2107, year));
  const dosTime = ((hour & 31) << 11) | ((minute & 63) << 5) | (Math.floor(second / 2) & 31);
  const dosDate = (((clampedYear - 1980) & 127) << 9) | ((month & 15) << 5) | (day & 31);
  return {
    dosTime,
    dosDate,
  };
}
function dosToDate(dosDate: number, dosTime: number): Date {
  const year = ((dosDate >> 9) & 127) + 1980;
  const month = ((dosDate >> 5) & 15) - 1;
  const day = dosDate & 31;
  const hour = (dosTime >> 11) & 31;
  const minute = (dosTime >> 5) & 63;
  const second = (dosTime & 31) * 2;
  return new Date(year, Math.max(0, month), Math.max(1, day), hour, minute, second);
}
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 3988292384 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(data: ArchiveInput): number {
  const bytes = toU8(data);
  let crc = 4294967295;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
  }
  return (crc ^ 4294967295) >>> 0;
}
function writeAscii(view: Uint8Array, offset: number, width: number, value: string | number): void {
  const text = String(value);
  for (let i = 0; i < width; i++) view[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
}
function writeOctal(view: Uint8Array, offset: number, width: number, value: number): void {
  const octal = Math.max(0, Number(value || 0)).toString(8);
  const padded = octal.padStart(Math.max(0, width - 2), '0');
  for (let i = 0; i < width; i++) view[offset + i] = 0;
  for (let i = 0; i < padded.length && i < width - 2; i++) {
    view[offset + i] = padded.charCodeAt(i);
  }
  view[offset + width - 2] = 0;
  view[offset + width - 1] = 32;
}
function parseTarOctal(
  bytes: Uint8Array,
  offset: number,
  length: number,
  field = 'numeric field',
): number {
  let value = '';
  let sawTerminator = false;
  for (let i = offset; i < offset + length; i++) {
    const byte = bytes[i]!;
    if (byte === 0 || byte === 32) {
      sawTerminator = true;
      continue;
    }
    if (sawTerminator) {
      throw new Error(`Invalid tar archive: ${field} contains data after terminator`);
    }
    if (byte < 48 || byte > 55) {
      throw new Error(`Invalid tar archive: ${field} contains non-octal data`);
    }
    value += String.fromCharCode(byte);
  }
  if (value === '') return 0;
  const parsed = parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid tar archive: ${field} contains an invalid octal value`);
  }
  return parsed;
}
function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + 512; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}
/**
 * Handle for reading or mutating one archive entry.
 *
 * Handles are returned by `Archive.entry()`. Metadata getters read the current
 * archive entry state and throw if the archive is closed or the entry has been
 * removed.
 *
 * ```ts no_run
 * import { Archive } from 'fino:archive';
 *
 * const archive = await Archive.create('bundle.zip');
 * await archive.write('README.md', 'hello');
 * const entry = await archive.entry('README.md');
 * console.log(entry?.name);
 * await archive.close();
 * ```
 */
export class ArchiveEntryHandle {
  #archive: Archive;
  #name: string;
  /**
   * Create an entry handle bound to an archive and normalized entry name.
   *
   * Application code normally obtains handles through `Archive.entry()`.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('file.txt', 'ok');
   * const handle = await archive.entry('file.txt');
   * console.log(handle?.name);
   * await archive.close();
   * ```
   */
  constructor(archive: Archive, name: string) {
    this.#archive = archive;
    this.#name = name;
  }
  /**
   * Normalized archive entry name.
   *
   * Names use forward slashes and have no leading slash.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('docs/readme.txt', 'ok');
   * console.log((await archive.entry('docs/readme.txt'))?.name);
   * await archive.close();
   * ```
   */
  get name(): string {
    return this.#name;
  }
  /**
   * Current entry kind.
   *
   * Returns `'file'` or `'directory'`. Throws if the backing archive is closed
   * or the entry no longer exists.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('docs/', new Uint8Array(), { kind: 'directory' });
   * console.log((await archive.entry('docs'))?.kind);
   * await archive.close();
   * ```
   */
  get kind(): ArchiveKind {
    return this.#archive._entryInfo(this.#name).kind;
  }
  /**
   * Current uncompressed entry size in bytes.
   *
   * Directories report `0`. Throws if the archive is closed or the entry has
   * been removed.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('file.txt', 'hello');
   * console.log((await archive.entry('file.txt'))?.size);
   * await archive.close();
   * ```
   */
  get size(): number {
    return this.#archive._entryInfo(this.#name).size;
  }
  /**
   * Current compressed size in bytes.
   *
   * For tar entries this matches `size`; for ZIP entries it reflects the
   * compressed payload size when known.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('file.txt', 'hello');
   * console.log((await archive.entry('file.txt'))?.compressedSize);
   * await archive.close();
   * ```
   */
  get compressedSize(): number {
    return this.#archive._entryInfo(this.#name).compressedSize;
  }
  /**
   * Current entry modification time, when available.
   *
   * Returns `null` when the archive entry has no timestamp metadata.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('file.txt', 'hello', { mtime: new Date() });
   * console.log((await archive.entry('file.txt'))?.mtime);
   * await archive.close();
   * ```
   */
  get mtime(): Date | null {
    return this.#archive._entryInfo(this.#name).mtime;
  }
  /**
   * Current entry mode, when available.
   *
   * Returns POSIX mode metadata or `null`. Extraction does not guarantee every
   * archived mode bit is applied on disk.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('file.txt', 'hello', { mode: 0o600 });
   * console.log((await archive.entry('file.txt'))?.mode);
   * await archive.close();
   * ```
   */
  get mode(): number | null {
    return this.#archive._entryInfo(this.#name).mode;
  }
  /**
   * Read this entry as bytes.
   *
   * Directory entries return an empty byte array. Missing entries or closed
   * archives throw.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('file.txt', new Uint8Array([1, 2]));
   * console.log((await archive.entry('file.txt')) && await (await archive.entry('file.txt'))!.bytes());
   * await archive.close();
   * ```
   */
  async bytes(): Promise<Uint8Array> {
    return this.#archive.read(this.#name);
  }
  /**
   * Read this entry as UTF-8 text.
   *
   * Directory entries decode as an empty string. Invalid UTF-8 is handled by
   * `TextDecoder` replacement behavior.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('README.md', 'hello');
   * console.log(await (await archive.entry('README.md'))!.text());
   * await archive.close();
   * ```
   */
  async text(): Promise<string> {
    return this.#archive.readText(this.#name);
  }
  /**
   * Replace this entry's data and metadata.
   *
   * This delegates to `Archive.write()` using the handle's current name.
   * Read-only or closed archives throw.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('file.txt', 'old');
   * await (await archive.entry('file.txt'))!.write('new');
   * await archive.close();
   * ```
   */
  async write(data: ArchiveInput, options?: ArchiveWriteOptions): Promise<void> {
    return this.#archive.write(this.#name, data, options);
  }
  /**
   * Remove this entry from the archive.
   *
   * Removing a missing entry is a no-op when called through `Archive.remove()`,
   * but this handle can throw if the archive has been closed. Changes are
   * persisted on `save()` or writable `close()`.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('file.txt', 'hello');
   * await (await archive.entry('file.txt'))!.remove();
   * await archive.close();
   * ```
   */
  async remove(): Promise<void> {
    return this.#archive.remove(this.#name);
  }
}
/**
 * Mutable archive reader/writer for zip, tar, and tar.gz files.
 *
 * Archives created with `Archive.create()` are written when `save()` or
 * `close()` is called. Archives opened read-only reject mutating operations.
 * Reading methods throw when an entry is missing; `entry()` is the nullable
 * lookup helper.
 *
 * ```ts no_run
 * import { Archive } from 'fino:archive';
 *
 * const archive = await Archive.create('bundle.zip');
 * await archive.write('README.md', '# Project\n');
 * await archive.close();
 * ```
 */
export class Archive {
  /**
   * Destination path on disk for this archive, as given to the constructor and exposed via the `path` getter.
   *
   * @internal
   */
  #path: string;
  /**
   * Resolved archive format that drives parse and serialize behavior.
   *
   * @internal
   */
  #format: ArchiveFormat;
  /**
   * Whether mutating methods are rejected for this handle.
   *
   * @internal
   */
  #readOnly: boolean;
  /**
   * Set once `close()` runs; open-handle assertions check this flag.
   *
   * @internal
   */
  #closed: boolean;
  /**
   * Tracks unsaved in-memory changes so a writable `close()` knows to save.
   *
   * @internal
   */
  #dirty: boolean;
  /**
   * In-memory entry table keyed by normalized archive path.
   *
   * @internal
   */
  #entries: Map<string, LoadedArchiveEntry>;
  /**
   * Create an archive handle with an explicit format.
   *
   * This constructor does not read or write the archive file. Prefer
   * `Archive.create()` or `Archive.open()` for extension-based format
   * detection and parsing.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = new Archive('bundle.zip', 'zip');
   * await archive.close();
   * ```
   */
  constructor(path: string, format: ArchiveFormat, options: ArchiveOpenOptions = {}) {
    this.#path = String(path);
    this.#format = format;
    this.#readOnly = !!options.readOnly;
    this.#closed = false;
    this.#dirty = false;
    this.#entries = new Map();
  }
  /**
   * Filesystem path backing this archive.
   *
   * Writable `save()` and `close()` serialize to this path. The value is the
   * string provided to the constructor or factory.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * console.log(archive.path);
   * await archive.close();
   * ```
   */
  get path(): string {
    return this.#path;
  }
  /**
   * Archive format in use after extension or option detection.
   *
   * The value is `'zip'`, `'tar'`, or `'tar.gz'`.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.tar.gz');
   * console.log(archive.format);
   * await archive.close();
   * ```
   */
  get format(): ArchiveFormat {
    return this.#format;
  }
  /**
   * Whether the archive handle has been closed.
   *
   * Closed archives reject all operations that require an open handle. Calling
   * `close()` more than once is allowed.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.close();
   * console.log(archive.closed);
   * ```
   */
  get closed(): boolean {
    return this.#closed;
  }
  /**
   * Create a new empty archive handle without reading an existing file.
   *
   * The archive is written when `save()` is called or when a dirty writable
   * handle is closed. Existing files at `path` are replaced on save.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('README.md', 'hello');
   * await archive.close();
   * ```
   */
  static async create(path: string, options: ArchiveOpenOptions = {}): Promise<Archive> {
    const archive = new Archive(path, inferFormat(path, options), { readOnly: false });
    return archive;
  }
  /**
   * Open and parse an existing archive from disk.
   *
   * ZIP file payloads may be loaded lazily; tar payloads are parsed from the
   * archive bytes. Throws when the file cannot be read, the format cannot be
   * inferred, or the archive structure is invalid.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.open('bundle.zip', { readOnly: true });
   * console.log(await archive.entries());
   * await archive.close();
   * ```
   */
  static async open(path: string, options: ArchiveOpenOptions = {}): Promise<Archive> {
    const format = inferFormat(path, options);
    const archive = new Archive(path, format, options);
    const bytes = await readFileBytes(path);
    archive.#load(bytes);
    return archive;
  }
  /**
   * Throws if the handle has already been closed.
   *
   * @internal
   */
  #assertOpen(): void {
    if (this.#closed) throw new Error('Archive is closed');
  }
  /**
   * Throws if the handle is closed or was opened read-only.
   *
   * @internal
   */
  #assertWritable(): void {
    this.#assertOpen();
    if (this.#readOnly) throw new Error('Archive is read-only');
  }
  /**
   * Flags the in-memory entry table as diverged from the file on disk.
   *
   * @internal
   */
  #markDirty(): void {
    this.#dirty = true;
  }
  /**
   * Return metadata for one normalized archive entry.
   *
   * This helper supports entry handles and is not intended as the primary
   * application-facing lookup API; use `entry()` when a missing entry should
   * return `null`. Throws if the archive is closed or the entry is missing.
   *
   * @internal
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('README.md', 'hello');
   * console.log(archive._entryInfo('README.md').size);
   * await archive.close();
   * ```
   */
  _entryInfo(name: string): ArchiveEntryInfo {
    this.#assertOpen();
    const key = normalizedArchivePath(name);
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Archive entry '${name}' not found`);
    return this.#toInfo(entry);
  }
  /**
   * Returns entry names sorted so listing and serialization are deterministic.
   *
   * @internal
   */
  #entryNames(): string[] {
    return Array.from(this.#entries.keys()).sort();
  }
  /**
   * Converts an internal entry record into public `ArchiveEntryInfo` metadata.
   *
   * @internal
   */
  #toInfo(entry: LoadedArchiveEntry): ArchiveEntryInfo {
    return {
      name: entry.name,
      kind: entry.kind,
      size: entry.size ?? 0,
      compressedSize: entry.compressedSize ?? entry.size ?? 0,
      mtime: entry.mtime ?? null,
      mode: entry.mode ?? null,
    };
  }
  /**
   * Inserts or replaces an entry in the table under its normalized name.
   *
   * @internal
   */
  #setEntry(entry: LoadedArchiveEntry): void {
    this.#entries.set(entry.name, entry);
  }
  /**
   * Parses raw archive bytes into the entry table, gunzipping `tar.gz` input first.
   *
   * @internal
   */
  #load(bytes: Uint8Array): void {
    if (this.#format === 'zip') {
      for (const entry of parseZip(bytes)) this.#setEntry(entry);
      return;
    }
    let tarBytes = bytes;
    if (this.#format === 'tar.gz') {
      tarBytes = decompress(bytes, {
        format: 'gzip',
        maxOutputBytes: MAX_DECOMPRESSED_BYTES,
      });
    }
    for (const entry of parseTar(tarBytes)) this.#setEntry(entry);
  }
  /**
   * List archive entries in normalized path order.
   *
   * Returns metadata only; file payloads are not decoded unless already loaded.
   * Throws if the archive is closed.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('README.md', 'hello');
   * console.log((await archive.entries())[0].name);
   * await archive.close();
   * ```
   */
  async entries(): Promise<ArchiveEntryInfo[]> {
    this.#assertOpen();
    return this.#entryNames().map((name: string) => this.#toInfo(this.#entries.get(name)!));
  }
  /**
   * Return a handle for an entry, or `null` if no entry exists at that path.
   *
   * The lookup name is normalized before matching, so `docs/./README.md` and
   * `docs/README.md` refer to the same archive entry. Throws if the archive is
   * closed.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('README.md', 'hello');
   * const entry = await archive.entry('./README.md');
   * console.log(entry?.size);
   * await archive.close();
   * ```
   */
  async entry(name: string): Promise<ArchiveEntryHandle | null> {
    this.#assertOpen();
    const key = normalizedArchivePath(name);
    if (!this.#entries.has(key)) return null;
    return new ArchiveEntryHandle(this, key);
  }
  /**
   * Read one file entry as bytes.
   *
   * Directory entries return an empty byte array. ZIP entries compressed with
   * unsupported methods throw when read. Missing entries and closed archives
   * throw.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('data.bin', new Uint8Array([1, 2, 3]));
   * console.log((await archive.read('data.bin')).byteLength);
   * await archive.close();
   * ```
   */
  async read(name: string): Promise<Uint8Array> {
    this.#assertOpen();
    const key = normalizedArchivePath(name);
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Archive entry '${name}' not found`);
    if (entry.kind === 'directory') return new Uint8Array(0);
    if (entry.data) return new Uint8Array(entry.data);
    if (entry.loader) {
      const loaded = await entry.loader();
      entry.data = loaded;
      entry.size = loaded.byteLength;
      return new Uint8Array(loaded);
    }
    return new Uint8Array(0);
  }
  /**
   * Read one file entry as UTF-8 text.
   *
   * This decodes `read(name)` with `TextDecoder`. Directory entries decode as
   * an empty string. Invalid UTF-8 uses replacement behavior.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('README.md', 'hello');
   * console.log(await archive.readText('README.md'));
   * await archive.close();
   * ```
   */
  async readText(name: string): Promise<string> {
    return decodeUtf8(await this.read(name));
  }
  /**
   * Create or replace one archive entry.
   *
   * Entry names are normalized to archive paths; empty names throw. Data may be
   * a `Uint8Array`, an `ArrayBuffer`, or a string encoded as UTF-8. Writable
   * archives are marked dirty and are persisted by `save()` or `close()`.
   * Read-only and closed archives throw.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('README.md', '# Project\n', { mode: 0o644 });
   * await archive.close();
   * ```
   */
  async write(name: string, data: ArchiveInput, options: ArchiveWriteOptions = {}): Promise<void> {
    this.#assertWritable();
    const key = normalizedArchivePath(name);
    if (!key) throw new Error('Archive entry name cannot be empty');
    const bytes = toU8(data);
    const kind: ArchiveKind =
      options.kind === 'directory' || key.endsWith('/') ? 'directory' : 'file';
    const entry: LoadedArchiveEntry = {
      name: key,
      kind,
      data: bytes,
      size: bytes.byteLength,
      compressedSize: bytes.byteLength,
      mtime:
        options.mtime instanceof Date
          ? options.mtime
          : new Date(typeof options.mtime === 'number' ? options.mtime : Date.now()),
      mode: options.mode ?? (kind === 'directory' ? DEFAULT_DIR_MODE : DEFAULT_MODE),
      method: options.compression === 'store' ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE,
    };
    this.#setEntry(entry);
    this.#markDirty();
  }
  /**
   * Add a host filesystem file to the archive.
   *
   * Reads the entire source file into memory and stores it under `archivePath`
   * or the source basename when `archivePath` is `null`. Source mtime and mode
   * are copied unless overridden. Throws on source read/stat errors, read-only
   * archives, or closed archives.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.addFile('dist/app.js', 'app.js');
   * await archive.close();
   * ```
   */
  async addFile(
    srcPath: string,
    archivePath: string | null = null,
    options: ArchiveWriteOptions = {},
  ): Promise<void> {
    this.#assertWritable();
    const data = await readFileBytes(srcPath);
    const stat = await fs.lstat(srcPath);
    const target = archivePath ?? basename(srcPath);
    await this.write(target, data, {
      ...options,
      mtime: options.mtime ?? new Date(stat.mtimeMs),
      mode: options.mode ?? stat.mode,
    });
  }
  /**
   * Recursively add the contents of a host directory to the archive.
   *
   * Directory contents are walked through the Fino filesystem APIs. Regular
   * files are added; directories are traversed. Symlinks and special files are
   * skipped by the current implementation. Added entries are stored under the
   * `archivePath` prefix when one is provided, otherwise relative to `srcPath`.
   * Throws on directory read failures or when the archive is not writable.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.tar.gz');
   * await archive.addDirectory('dist', 'package');
   * await archive.close();
   * ```
   */
  async addDirectory(srcPath: string, archivePath: string = ''): Promise<void> {
    this.#assertWritable();
    const dir = await fs.dir(srcPath);
    for (const child of await dir.entries()) {
      const target = archivePath
        ? `${normalizedArchivePath(archivePath)}/${child.name}`
        : child.name;
      if (child.isDirectory()) {
        await this.addDirectory(child.path.toString(), target);
      } else if (child.isFile()) {
        await this.addFile(child.path.toString(), target);
      }
    }
  }
  /**
   * Remove an entry if it exists.
   *
   * Missing entries are ignored. Removing an existing entry marks the archive
   * dirty. Read-only and closed archives throw.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('old.txt', 'old');
   * await archive.remove('old.txt');
   * await archive.close();
   * ```
   */
  async remove(name: string): Promise<void> {
    this.#assertWritable();
    const key = normalizedArchivePath(name);
    const existed = this.#entries.delete(key);
    if (existed) this.#markDirty();
  }
  /**
   * Rename an existing entry, failing if the target name already exists.
   *
   * Both names are normalized before lookup. Throws if the source is missing,
   * the target exists, the archive is read-only, or the archive is closed.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('draft.txt', 'hello');
   * await archive.rename('draft.txt', 'README.txt');
   * await archive.close();
   * ```
   */
  async rename(oldName: string, newName: string): Promise<void> {
    this.#assertWritable();
    const sourceKey = normalizedArchivePath(oldName);
    const targetKey = normalizedArchivePath(newName);
    const entry = this.#entries.get(sourceKey);
    if (!entry) throw new Error(`Archive entry '${oldName}' not found`);
    if (this.#entries.has(targetKey)) throw new Error(`Archive entry '${newName}' already exists`);
    this.#entries.delete(sourceKey);
    entry.name = targetKey;
    this.#entries.set(targetKey, entry);
    this.#markDirty();
  }
  /**
   * Extract all entries to `destination`.
   *
   * Extraction rejects absolute archive paths and parent-directory escapes,
   * removes pre-existing symlinks at output file paths, creates directories as
   * needed, and counts only file entries in the result. Existing regular files
   * are overwritten. `ArchiveExtractOptions.maxEntries` and `maxTotalBytes` add
   * opt-in policy limits; exceeding either throws mid-extraction. Whenever
   * extraction throws, previously written files remain on disk.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.open('bundle.zip', { readOnly: true });
   * const result = await archive.extract('unpacked', { maxEntries: 10_000 });
   * console.log(result.entries);
   * await archive.close();
   * ```
   */
  async extract(destination: string, options: ArchiveExtractOptions = {}): Promise<ExtractResult> {
    this.#assertOpen();
    await ensureHostDir(destination);
    let extracted = 0;
    let totalBytes = 0;
    for (const name of this.#entryNames()) {
      const entry = this.#entries.get(name)!;
      if (isUnsafeExtractPath(entry.name)) {
        throw new Error(`Unsafe archive path '${entry.name}'`);
      }
      const outputPath = `${destination}/${entry.name}`;
      if (entry.kind === 'directory') {
        await ensureHostDir(outputPath);
        continue;
      }
      if (options.maxEntries !== undefined && extracted + 1 > options.maxEntries) {
        throw new Error(
          `Archive extraction entry limit exceeded: maxEntries=${options.maxEntries}`,
        );
      }
      const data = await this.read(entry.name);
      if (
        options.maxTotalBytes !== undefined &&
        totalBytes + data.byteLength > options.maxTotalBytes
      ) {
        throw new Error(
          `Archive extraction byte limit exceeded: maxTotalBytes=${options.maxTotalBytes}`,
        );
      }
      await ensureHostDir(hostDirname(outputPath));
      // Guard against a pre-placed symlink at outputPath pointing outside the
      // destination directory. Use lstat (not stat) to detect the symlink itself.
      try {
        const st = await fs.lstat(outputPath);
        if (st.isSymlink()) await fs.unlink(outputPath);
      } catch (_) {}
      await fs.writeFile(outputPath, data);
      extracted++;
      totalBytes += data.byteLength;
    }
    return { entries: extracted };
  }
  /**
   * Serialize the archive to disk atomically through a temporary file.
   *
   * The parent directory is created when needed. The archive is written to a
   * unique temporary path, then renamed into place. Read-only and closed
   * archives throw. Successful saves clear the dirty flag.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('README.md', 'hello');
   * await archive.save();
   * await archive.close();
   * ```
   */
  async save(): Promise<void> {
    this.#assertWritable();
    const bytes = await this.#serialize();
    await ensureHostDir(hostDirname(this.#path));
    const tempPath = await uniqueTempPath(this.#path);
    await fs.writeFile(tempPath, bytes);
    await fs.rename(tempPath, this.#path);
    this.#dirty = false;
  }
  /**
   * Save pending changes when writable, then mark the handle closed.
   *
   * Calling `close()` more than once is allowed. Dirty writable archives are
   * saved automatically; read-only archives are simply closed.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * const archive = await Archive.create('bundle.zip');
   * await archive.write('README.md', 'hello');
   * await archive.close();
   * ```
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (!this.#readOnly && this.#dirty) await this.save();
    this.#closed = true;
  }
  /**
   * Close the archive when disposed with `await using`.
   *
   * Delegates to `close()`, so dirty writable archives are saved before the
   * handle is marked closed.
   *
   * ```ts no_run
   * import { Archive } from 'fino:archive';
   *
   * {
   *   await using archive = await Archive.create('bundle.zip');
   *   await archive.write('README.md', 'hello');
   * }
   * ```
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /**
   * Serializes the entry table to archive bytes in sorted name order.
   *
   * @internal
   */
  async #serialize(): Promise<Uint8Array> {
    const orderedEntries = this.#entryNames().map((name: string) => this.#entries.get(name)!);
    if (this.#format === 'zip') return serializeZip(orderedEntries);
    const tar = await serializeTar(orderedEntries);
    if (this.#format === 'tar.gz') return compress(tar, { format: 'gzip' });
    return tar;
  }
}
function parseZip(bytes: Uint8Array): LoadedArchiveEntry[] {
  const entries: LoadedArchiveEntry[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function ensureRange(offset: number, length: number, label: string): void {
    if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
      throw new Error(`Invalid zip archive: truncated ${label}`);
    }
  }
  const maxComment = Math.max(0, bytes.byteLength - 22 - 65535);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= maxComment; offset--) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIR) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid zip archive: EOCD not found');
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  ensureRange(centralOffset, 0, 'central directory');
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    ensureRange(offset, 46, 'central directory entry');
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_HEADER) {
      throw new Error('Invalid zip archive: central directory entry missing');
    }
    const flags = view.getUint16(offset + 8, true);
    if ((flags & 8) !== 0) {
      throw new Error('Unsupported zip archive: data descriptor entries are not supported');
    }
    const method = view.getUint16(offset + 10, true);
    const dosTime = view.getUint16(offset + 12, true);
    const dosDate = view.getUint16(offset + 14, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttrs = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (compressedSize === 4294967295 || size === 4294967295 || localOffset === 4294967295) {
      throw new Error('Unsupported zip archive: ZIP64 entries are not supported');
    }
    ensureRange(
      offset + 46,
      nameLength + extraLength + commentLength,
      'central directory metadata',
    );
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeUtf8(nameBytes);
    ensureRange(localOffset, 30, 'local file header');
    if (view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error('Invalid zip archive: local file header missing');
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    if ((localFlags & 8) !== 0) {
      throw new Error('Unsupported zip archive: data descriptor entries are not supported');
    }
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    ensureRange(localOffset + 30, localNameLength + localExtraLength, 'local file metadata');
    const localNameBytes = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const matchesName =
      localNameBytes.byteLength === nameBytes.byteLength &&
      localNameBytes.every((byte, index) => byte === nameBytes[index]);
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localCrc !== crc ||
      localCompressedSize !== compressedSize ||
      localSize !== size ||
      !matchesName
    ) {
      throw new Error(`Invalid zip archive: local header mismatch for '${name}'`);
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    ensureRange(dataOffset, compressedSize, `local file data for '${name}'`);
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    const kind: ArchiveKind =
      name.endsWith('/') || ((externalAttrs >>> 16) & 61440) === 16384 ? 'directory' : 'file';
    entries.push({
      name: normalizedArchivePath(name),
      kind,
      size,
      compressedSize,
      mtime: dosToDate(dosDate, dosTime),
      mode:
        (externalAttrs >>> 16) & 65535 || (kind === 'directory' ? DEFAULT_DIR_MODE : DEFAULT_MODE),
      method,
      crc32: crc,
      loader: async () => {
        if (kind === 'directory') return new Uint8Array(0);
        if (method === ZIP_METHOD_STORE) {
          if (size > MAX_DECOMPRESSED_BYTES) {
            throw new Error(
              `Archive entry '${name}' is ${size} bytes, ` +
                `exceeding the ${MAX_DECOMPRESSED_BYTES}-byte limit`,
            );
          }
          if (compressedSize !== size) {
            throw new Error(`Invalid zip archive: size mismatch for '${name}'`);
          }
          if (crc32(compressed) !== crc) {
            throw new Error(`Invalid zip archive: CRC mismatch for '${name}'`);
          }
          return compressed;
        }
        if (method === ZIP_METHOD_DEFLATE) {
          if (size > MAX_DECOMPRESSED_BYTES) {
            throw new Error(
              `Archive entry '${name}' is ${size} bytes, ` +
                `exceeding the ${MAX_DECOMPRESSED_BYTES}-byte limit`,
            );
          }
          let decompressed: Uint8Array;
          try {
            decompressed = decompress(compressed, {
              format: 'deflate-raw',
              maxOutputBytes: MAX_DECOMPRESSED_BYTES,
              expectedOutputBytes: size,
            });
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            throw new Error(`Invalid zip archive: size mismatch for '${name}'`);
          }
          if (crc32(decompressed) !== crc) {
            throw new Error(`Invalid zip archive: CRC mismatch for '${name}'`);
          }
          return decompressed;
        }
        throw new Error(`Unsupported zip compression method ${method}`);
      },
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
async function serializeZip(entries: LoadedArchiveEntry[]): Promise<Uint8Array> {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name =
      entry.kind === 'directory' && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name;
    const nameBytes = textEncoder.encode(name);
    const bytes =
      entry.kind === 'directory'
        ? new Uint8Array(0)
        : entry.data
          ? entry.data
          : await entry.loader!();
    const method =
      entry.kind === 'directory' ? ZIP_METHOD_STORE : (entry.method ?? ZIP_METHOD_DEFLATE);
    const compressed =
      method === ZIP_METHOD_STORE ? bytes : compress(bytes, { format: 'deflate-raw' });
    const crc = crc32(bytes);
    const { dosTime, dosDate } = dateToDos(entry.mtime);
    const mode =
      entry.kind === 'directory' ? (entry.mode ?? DEFAULT_DIR_MODE) : (entry.mode ?? DEFAULT_MODE);
    const local = new Uint8Array(30 + nameBytes.byteLength + compressed.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, ZIP_LOCAL_FILE_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.byteLength, true);
    localView.setUint32(22, bytes.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.byteLength);
    localParts.push(local);
    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, ZIP_CENTRAL_FILE_HEADER, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, bytes.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, ((mode & 65535) << 16) >>> 0, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }
  const centralDirectory = concatBytes(centralParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, ZIP_END_OF_CENTRAL_DIR, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralDirectory.byteLength, true);
  eocdView.setUint32(16, localOffset, true);
  eocdView.setUint16(20, 0, true);
  return concatBytes([...localParts, centralDirectory, eocd]);
}
function parseTar(bytes: Uint8Array): LoadedArchiveEntry[] {
  const entries: LoadedArchiveEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    if (isZeroBlock(bytes, offset)) break;
    const storedChecksum = parseTarOctal(bytes, offset + 148, 8, 'checksum');
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += i >= 148 && i < 156 ? 32 : bytes[offset + i]!;
    }
    if (storedChecksum !== checksum) {
      throw new Error('Invalid tar archive: header checksum mismatch');
    }
    const name = decodeUtf8(bytes.subarray(offset, offset + 100)).replace(/\0.*$/, '');
    const mode = parseTarOctal(bytes, offset + 100, 8, 'mode') || DEFAULT_MODE;
    const size = parseTarOctal(bytes, offset + 124, 12, 'size');
    const mtimeValue = parseTarOctal(bytes, offset + 136, 12, 'mtime');
    const typeFlag = bytes[offset + 156];
    if (typeFlag === 55 || typeFlag === 76 || typeFlag === 103 || typeFlag === 120) {
      throw new Error('Unsupported tar archive: long-name and PAX entries are not supported');
    }
    const prefix = decodeUtf8(bytes.subarray(offset + 345, offset + 500)).replace(/\0.*$/, '');
    const fullName = normalizedArchivePath(prefix ? `${prefix}/${name}` : name);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    // Typeflags: 48='0'/file, 49='1'/hardlink, 50='2'/symlink, 53='5'/dir.
    // Reject symlinks and hardlinks — they can be used to escape the extraction
    // root. Both are skipped silently so the rest of the archive still extracts.
    if (typeFlag === 49 || typeFlag === 50) {
      const padded2 = Math.ceil(size / 512) * 512;
      offset = dataStart + padded2;
      continue;
    }
    const kind: ArchiveKind = typeFlag === 53 || fullName.endsWith('/') ? 'directory' : 'file';
    if (kind === 'file' && size > MAX_DECOMPRESSED_BYTES) {
      throw new Error(
        `Tar entry '${fullName}' is ${size} bytes, exceeding the ${MAX_DECOMPRESSED_BYTES}-byte limit`,
      );
    }
    if (dataEnd > bytes.byteLength) {
      throw new Error(`Invalid tar archive: truncated data for '${fullName}'`);
    }
    const payload = bytes.slice(dataStart, dataEnd);
    entries.push({
      name: kind === 'directory' ? fullName.replace(/\/$/, '') : fullName,
      kind,
      size: payload.byteLength,
      compressedSize: payload.byteLength,
      mtime: mtimeValue > 0 ? new Date(mtimeValue * 1e3) : null,
      mode,
      method: ZIP_METHOD_STORE,
      data: payload,
    });
    const padded = Math.ceil(size / 512) * 512;
    offset = dataStart + padded;
  }
  return entries;
}
async function serializeTar(entries: LoadedArchiveEntry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const bytes =
      entry.kind === 'directory'
        ? new Uint8Array(0)
        : entry.data
          ? entry.data
          : await entry.loader!();
    const rawName =
      entry.kind === 'directory' && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name;
    const name = normalizedArchivePath(rawName);
    const nameBytes = textEncoder.encode(name);
    if (nameBytes.byteLength > 100) throw new Error(`Tar entry name too long: '${name}'`);
    const header = new Uint8Array(512);
    writeAscii(header, 0, nameBytes.byteLength, name);
    writeOctal(
      header,
      100,
      8,
      entry.kind === 'directory' ? (entry.mode ?? DEFAULT_DIR_MODE) : (entry.mode ?? DEFAULT_MODE),
    );
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, bytes.byteLength);
    writeOctal(
      header,
      136,
      12,
      entry.mtime
        ? Math.floor(new Date(entry.mtime).getTime() / 1e3)
        : Math.floor(Date.now() / 1e3),
    );
    for (let i = 148; i < 156; i++) header[i] = 32;
    header[156] = entry.kind === 'directory' ? 53 : 48;
    writeAscii(header, 257, 6, 'ustar');
    writeAscii(header, 263, 2, '00');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i]!;
    writeOctal(header, 148, 8, checksum);
    parts.push(header);
    if (bytes.byteLength > 0) {
      parts.push(bytes);
      const remainder = bytes.byteLength % 512;
      if (remainder !== 0) parts.push(new Uint8Array(512 - remainder));
    }
  }
  parts.push(new Uint8Array(1024));
  return concatBytes(parts);
}
/**
 * Open an existing archive from disk.
 *
 * Convenience wrapper for `Archive.open()`. Pass `{ readOnly: true }` to reject
 * writes. Throws on read, format, or parse failures.
 *
 * ```ts no_run
 * import { openArchive } from 'fino:archive';
 *
 * const archive = await openArchive('bundle.zip', { readOnly: true });
 * console.log(await archive.entries());
 * await archive.close();
 * ```
 */
export async function openArchive(
  path: string,
  options: ArchiveOpenOptions = {},
): Promise<Archive> {
  return Archive.open(path, options);
}
/**
 * Create a new archive handle for `path`.
 *
 * Convenience wrapper for `Archive.create()`. The archive is not written until
 * `save()` or writable `close()`.
 *
 * ```ts no_run
 * import { createArchive } from 'fino:archive';
 *
 * const archive = await createArchive('bundle.tar');
 * await archive.write('README.md', 'hello');
 * await archive.close();
 * ```
 */
export async function createArchive(
  path: string,
  options: ArchiveOpenOptions = {},
): Promise<Archive> {
  return Archive.create(path, options);
}
/**
 * Open an archive, return its entry list, and close it.
 *
 * The archive is opened read-only regardless of `options.readOnly`. Throws on
 * read, parse, or listing failures.
 *
 * ```ts no_run
 * import { listArchive } from 'fino:archive';
 *
 * const entries = await listArchive('bundle.zip');
 * console.log(entries.map((entry) => entry.name));
 * ```
 */
export async function listArchive(
  path: string,
  options: ArchiveOpenOptions = {},
): Promise<ArchiveEntryInfo[]> {
  const archive = await openArchive(path, {
    ...options,
    readOnly: true,
  });
  try {
    return await archive.entries();
  } finally {
    await archive.close();
  }
}
/**
 * Open an archive, extract it to a destination directory, and close it.
 *
 * The archive is opened read-only regardless of `options.readOnly`. Extraction
 * uses the same safety checks as `Archive#extract()`: absolute paths and parent
 * escapes are rejected, and pre-existing symlinks at output paths are removed.
 * `ArchiveExtractOptions.maxEntries` and `maxTotalBytes` are forwarded as
 * extraction limits; exceeding either throws.
 *
 * ```ts no_run
 * import { extractArchive } from 'fino:archive';
 *
 * const result = await extractArchive('bundle.zip', 'unpacked');
 * console.log(result.entries);
 * ```
 */
export async function extractArchive(
  path: string,
  destination: string,
  options: ArchiveExtractOptions = {},
): Promise<ExtractResult> {
  const archive = await openArchive(path, {
    ...options,
    readOnly: true,
  });
  try {
    return await archive.extract(destination, options);
  } finally {
    await archive.close();
  }
}
