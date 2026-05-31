/**
 * fino:archive — zip, tar, and tar.gz archive helpers implemented in JS.
 */

import { DiskFileSystem } from './file/fs.mts';
import { deflateRaw, gzip, gunzip, inflateRaw } from './util/compression.mts';

const fs = new DiskFileSystem();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR = 0x06054b50;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

const DEFAULT_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
// Max decompressed bytes per entry — guards against zip-bomb attacks.
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 MiB

type ArchiveFormat = 'zip' | 'tar' | 'tar.gz';
type ArchiveKind = 'file' | 'directory';
type ZipCompression = 'store' | 'deflate';
type ArchiveInput = string | Uint8Array | ArrayBuffer;
type ArchiveLoader = () => Promise<Uint8Array>;

/** Options for opening or creating an archive. */
export interface ArchiveOpenOptions {
  /** Override format detection from the archive file extension. */
  format?: ArchiveFormat;
  /** Prevent write operations on the opened archive. */
  readOnly?: boolean;
}

/** Metadata used when creating or replacing an archive entry. */
export interface ArchiveWriteOptions {
  /** Whether the entry should be stored as a file or directory. */
  kind?: ArchiveKind;
  /** Zip compression mode. Tar archives ignore this option. */
  compression?: ZipCompression;
  /** Modification timestamp stored in the archive entry. */
  mtime?: Date | number;
  /** POSIX file mode stored in tar/zip metadata. */
  mode?: number;
}

/** Normalized metadata for one archive entry. */
export interface ArchiveEntryInfo {
  name: string;
  kind: ArchiveKind;
  size: number;
  compressedSize: number;
  mtime: Date | null;
  mode: number | null;
}

/** Result returned by extraction helpers. */
export interface ExtractResult {
  /** Number of file entries written to disk. Directory entries are not counted. */
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
    const candidate = `${path}.tmp-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
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
  const dosTime = ((hour & 0x1f) << 11) | ((minute & 0x3f) << 5) | ((Math.floor(second / 2)) & 0x1f);
  const dosDate = (((clampedYear - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

function dosToDate(dosDate: number, dosTime: number): Date {
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const month = ((dosDate >> 5) & 0x0f) - 1;
  const day = dosDate & 0x1f;
  const hour = (dosTime >> 11) & 0x1f;
  const minute = (dosTime >> 5) & 0x3f;
  const second = (dosTime & 0x1f) * 2;
  return new Date(year, Math.max(0, month), Math.max(1, day), hour, minute, second);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: ArchiveInput): number {
  const bytes = toU8(data);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
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
  view[offset + width - 1] = 0x20;
}

function parseTarOctal(bytes: Uint8Array, offset: number, length: number): number {
  let value = '';
  for (let i = offset; i < offset + length; i++) {
    const byte = bytes[i]!;
    if (byte === 0 || byte === 0x20) break;
    value += String.fromCharCode(byte);
  }
  const trimmed = value.trim();
  return trimmed === '' ? 0 : parseInt(trimmed, 8);
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + 512; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

class ArchiveEntryHandle {
  #archive: Archive;
  #name: string;

  constructor(archive: Archive, name: string) {
    this.#archive = archive;
    this.#name = name;
  }

  get name(): string { return this.#name; }
  get kind(): ArchiveKind { return this.#archive._entryInfo(this.#name).kind; }
  get size(): number { return this.#archive._entryInfo(this.#name).size; }
  get compressedSize(): number { return this.#archive._entryInfo(this.#name).compressedSize; }
  get mtime(): Date | null { return this.#archive._entryInfo(this.#name).mtime; }
  get mode(): number | null { return this.#archive._entryInfo(this.#name).mode; }

  async bytes(): Promise<Uint8Array> { return this.#archive.read(this.#name); }
  async text(): Promise<string> { return this.#archive.readText(this.#name); }
  async write(data: ArchiveInput, options?: ArchiveWriteOptions): Promise<void> { return this.#archive.write(this.#name, data, options); }
  async remove(): Promise<void> { return this.#archive.remove(this.#name); }
}

/**
 * Mutable archive reader/writer for zip, tar, and tar.gz files.
 *
 * Archives created with `Archive.create()` are written when `save()` or
 * `close()` is called. Archives opened read-only reject mutating operations.
 *
 * ```ts
 * import { Archive } from 'fino:archive';
 *
 * const archive = await Archive.create('bundle.zip');
 * await archive.write('README.md', '# Project\n');
 * await archive.close();
 * ```
 */
export class Archive {
  #path: string;
  #format: ArchiveFormat;
  #readOnly: boolean;
  #closed: boolean;
  #dirty: boolean;
  #entries: Map<string, LoadedArchiveEntry>;

  constructor(path: string, format: ArchiveFormat, options: ArchiveOpenOptions = {}) {
    this.#path = String(path);
    this.#format = format;
    this.#readOnly = !!options.readOnly;
    this.#closed = false;
    this.#dirty = false;
    this.#entries = new Map();
  }

  /** Filesystem path backing this archive. */
  get path(): string { return this.#path; }
  /** Archive format in use after extension or option detection. */
  get format(): ArchiveFormat { return this.#format; }
  /** Whether the archive handle has been closed. */
  get closed(): boolean { return this.#closed; }

  /** Create a new empty archive handle without reading an existing file. */
  static async create(path: string, options: ArchiveOpenOptions = {}): Promise<Archive> {
    const archive = new Archive(path, inferFormat(path, options), { readOnly: false });
    return archive;
  }

  /** Open and parse an existing archive from disk. */
  static async open(path: string, options: ArchiveOpenOptions = {}): Promise<Archive> {
    const format = inferFormat(path, options);
    const archive = new Archive(path, format, options);
    const bytes = await readFileBytes(path);
    archive.#load(bytes);
    return archive;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Archive is closed');
  }

  #assertWritable(): void {
    this.#assertOpen();
    if (this.#readOnly) throw new Error('Archive is read-only');
  }

  #markDirty(): void {
    this.#dirty = true;
  }

  _entryInfo(name: string): ArchiveEntryInfo {
    this.#assertOpen();
    const key = normalizedArchivePath(name);
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Archive entry '${name}' not found`);
    return this.#toInfo(entry);
  }

  #entryNames(): string[] {
    return Array.from(this.#entries.keys()).sort();
  }

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

  #setEntry(entry: LoadedArchiveEntry): void {
    this.#entries.set(entry.name, entry);
  }

  #load(bytes: Uint8Array): void {
    if (this.#format === 'zip') {
      for (const entry of parseZip(bytes)) this.#setEntry(entry);
      return;
    }
    let tarBytes = bytes;
    if (this.#format === 'tar.gz') tarBytes = gunzip(bytes);
    for (const entry of parseTar(tarBytes)) this.#setEntry(entry);
  }

  /** List archive entries in normalized path order. */
  async entries(): Promise<ArchiveEntryInfo[]> {
    this.#assertOpen();
    return this.#entryNames().map((name: string) => this.#toInfo(this.#entries.get(name)!));
  }

  /** Return a handle for an entry, or `null` if no entry exists at that path. */
  async entry(name: string): Promise<ArchiveEntryHandle | null> {
    this.#assertOpen();
    const key = normalizedArchivePath(name);
    if (!this.#entries.has(key)) return null;
    return new ArchiveEntryHandle(this, key);
  }

  /** Read one file entry as bytes. Directory entries return an empty byte array. */
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

  /** Read one file entry as UTF-8 text. */
  async readText(name: string): Promise<string> {
    return decodeUtf8(await this.read(name));
  }

  /** Create or replace one archive entry. */
  async write(name: string, data: ArchiveInput, options: ArchiveWriteOptions = {}): Promise<void> {
    this.#assertWritable();
    const key = normalizedArchivePath(name);
    if (!key) throw new Error('Archive entry name cannot be empty');
    const bytes = toU8(data);
    const kind: ArchiveKind = options.kind === 'directory' || key.endsWith('/') ? 'directory' : 'file';
    const entry: LoadedArchiveEntry = {
      name: key,
      kind,
      data: bytes,
      size: bytes.byteLength,
      compressedSize: bytes.byteLength,
      mtime: options.mtime instanceof Date ? options.mtime : new Date(typeof options.mtime === 'number' ? options.mtime : Date.now()),
      mode: options.mode ?? (kind === 'directory' ? DEFAULT_DIR_MODE : DEFAULT_MODE),
      method: options.compression === 'store' ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE,
    };
    this.#setEntry(entry);
    this.#markDirty();
  }

  /** Add a host filesystem file to the archive. */
  async addFile(srcPath: string, archivePath: string | null = null, options: ArchiveWriteOptions = {}): Promise<void> {
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

  /** Recursively add the contents of a host directory to the archive. */
  async addDirectory(srcPath: string, archivePath: string = ''): Promise<void> {
    this.#assertWritable();
    const dir = await fs.dir(srcPath);
    for (const child of await dir.entries()) {
      const target = archivePath ? `${normalizedArchivePath(archivePath)}/${child.name}` : child.name;
      if (child.isDirectory()) {
        await this.addDirectory(child.path.toString(), target);
      } else if (child.isFile()) {
        await this.addFile(child.path.toString(), target);
      }
    }
  }

  /** Remove an entry if it exists. */
  async remove(name: string): Promise<void> {
    this.#assertWritable();
    const key = normalizedArchivePath(name);
    const existed = this.#entries.delete(key);
    if (existed) this.#markDirty();
  }

  /** Rename an existing entry, failing if the target name already exists. */
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

  /** Extract all entries to `destination`, rejecting unsafe absolute or parent paths. */
  async extract(destination: string, _options: object = {}): Promise<ExtractResult> {
    this.#assertOpen();
    await ensureHostDir(destination);
    let extracted = 0;
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
      await ensureHostDir(hostDirname(outputPath));
      // Guard against a pre-placed symlink at outputPath pointing outside the
      // destination directory. Use lstat (not stat) to detect the symlink itself.
      try {
        const st = await fs.lstat(outputPath);
        if (st.isSymlink()) await fs.unlink(outputPath);
      } catch (_) {
        // File doesn't exist yet — that's the normal case; continue.
      }
      await fs.writeFile(outputPath, await this.read(entry.name));
      extracted++;
    }
    return { entries: extracted };
  }

  /** Serialize the archive to disk atomically through a temporary file. */
  async save(): Promise<void> {
    this.#assertWritable();
    const bytes = await this.#serialize();
    await ensureHostDir(hostDirname(this.#path));
    const tempPath = await uniqueTempPath(this.#path);
    await fs.writeFile(tempPath, bytes);
    await fs.rename(tempPath, this.#path);
    this.#dirty = false;
  }

  /** Save pending changes when writable, then mark the handle closed. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (!this.#readOnly && this.#dirty) await this.save();
    this.#closed = true;
  }

  async #serialize(): Promise<Uint8Array> {
    const orderedEntries = this.#entryNames().map((name: string) => this.#entries.get(name)!);
    if (this.#format === 'zip') return serializeZip(orderedEntries);
    const tar = await serializeTar(orderedEntries);
    if (this.#format === 'tar.gz') return gzip(tar);
    return tar;
  }
}

function parseZip(bytes: Uint8Array): LoadedArchiveEntry[] {
  const entries: LoadedArchiveEntry[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxComment = Math.max(0, bytes.byteLength - 22 - 0xffff);
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
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_HEADER) {
      throw new Error('Invalid zip archive: central directory entry missing');
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
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeUtf8(nameBytes);

    if (view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error('Invalid zip archive: local file header missing');
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    const kind: ArchiveKind = name.endsWith('/') || ((externalAttrs >>> 16) & 0o170000) === 0o040000 ? 'directory' : 'file';

    entries.push({
      name: normalizedArchivePath(name),
      kind,
      size,
      compressedSize,
      mtime: dosToDate(dosDate, dosTime),
      mode: ((externalAttrs >>> 16) & 0xffff) || (kind === 'directory' ? DEFAULT_DIR_MODE : DEFAULT_MODE),
      method,
      crc32: crc,
      loader: async () => {
        if (kind === 'directory') return new Uint8Array(0);
        if (method === ZIP_METHOD_STORE) return compressed;
        if (method === ZIP_METHOD_DEFLATE) {
          const decompressed = inflateRaw(compressed);
          if (decompressed.byteLength > MAX_DECOMPRESSED_BYTES) {
            throw new Error(
              `Archive entry '${name}' decompressed to ${decompressed.byteLength} bytes, ` +
              `exceeding the ${MAX_DECOMPRESSED_BYTES}-byte limit`,
            );
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
    const name = entry.kind === 'directory' && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name;
    const nameBytes = textEncoder.encode(name);
    const bytes = entry.kind === 'directory' ? new Uint8Array(0) : (entry.data ? entry.data : await entry.loader!());
    const method = entry.kind === 'directory' ? ZIP_METHOD_STORE : (entry.method ?? ZIP_METHOD_DEFLATE);
    const compressed = method === ZIP_METHOD_STORE ? bytes : deflateRaw(bytes);
    const crc = crc32(bytes);
    const { dosTime, dosDate } = dateToDos(entry.mtime);
    const mode = entry.kind === 'directory' ? (entry.mode ?? DEFAULT_DIR_MODE) : (entry.mode ?? DEFAULT_MODE);

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
    centralView.setUint32(38, ((mode & 0xffff) << 16) >>> 0, true);
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
    const name = decodeUtf8(bytes.subarray(offset, offset + 100)).replace(/\0.*$/, '');
    const mode = parseTarOctal(bytes, offset + 100, 8) || DEFAULT_MODE;
    const size = parseTarOctal(bytes, offset + 124, 12);
    const mtimeValue = parseTarOctal(bytes, offset + 136, 12);
    const typeFlag = bytes[offset + 156];
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
    const payload = bytes.slice(dataStart, dataEnd);
    entries.push({
      name: kind === 'directory' ? fullName.replace(/\/$/, '') : fullName,
      kind,
      size: payload.byteLength,
      compressedSize: payload.byteLength,
      mtime: mtimeValue > 0 ? new Date(mtimeValue * 1000) : null,
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
    const bytes = entry.kind === 'directory' ? new Uint8Array(0) : (entry.data ? entry.data : await entry.loader!());
    const rawName = entry.kind === 'directory' && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name;
    const name = normalizedArchivePath(rawName);
    const nameBytes = textEncoder.encode(name);
    if (nameBytes.byteLength > 100) throw new Error(`Tar entry name too long: '${name}'`);
    const header = new Uint8Array(512);
    writeAscii(header, 0, nameBytes.byteLength, name);
    writeOctal(header, 100, 8, entry.kind === 'directory' ? (entry.mode ?? DEFAULT_DIR_MODE) : (entry.mode ?? DEFAULT_MODE));
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, bytes.byteLength);
    writeOctal(header, 136, 12, entry.mtime ? Math.floor(new Date(entry.mtime).getTime() / 1000) : Math.floor(Date.now() / 1000));
    for (let i = 148; i < 156; i++) header[i] = 0x20;
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

/** Open an existing archive from disk. */
export async function openArchive(path: string, options: ArchiveOpenOptions = {}): Promise<Archive> {
  return Archive.open(path, options);
}

/** Create a new archive handle for `path`. */
export async function createArchive(path: string, options: ArchiveOpenOptions = {}): Promise<Archive> {
  return Archive.create(path, options);
}

/** Open an archive, return its entry list, and close it. */
export async function listArchive(path: string, options: ArchiveOpenOptions = {}): Promise<ArchiveEntryInfo[]> {
  const archive = await openArchive(path, { ...options, readOnly: true });
  try {
    return await archive.entries();
  } finally {
    await archive.close();
  }
}

/** Open an archive, extract it to a destination directory, and close it. */
export async function extractArchive(path: string, destination: string, options: ArchiveOpenOptions = {}): Promise<ExtractResult> {
  const archive = await openArchive(path, { ...options, readOnly: true });
  try {
    return await archive.extract(destination, options);
  } finally {
    await archive.close();
  }
}
