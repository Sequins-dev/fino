/**
 * internal:cluster/cask — the content-addressed deployment artifact.
 *
 * A cask is one tar.gz holding an application's source tree plus a
 * `cask.json` manifest, identified by the sha-256 of the archive bytes. The
 * hash is the deployment's identity everywhere: upload dedup, node cache
 * paths, rollback targets. Two builds with identical bytes are the same
 * deployment; nothing else about a cask is trusted until the hash verifies.
 *
 * Unpacking is idempotent and crash-safe: extraction happens into a staging
 * directory that is renamed into the content-addressed slot only after a
 * completeness marker is written, so a partially unpacked cask is never
 * spawnable and re-unpacking an existing hash is a no-op.
 *
 * @internal
 */
import { openArchive, createArchive } from 'fino:archive';
import { DiskFileSystem } from 'fino:file';

/** Manifest stored as `cask.json` inside every cask. */
export interface CaskManifest {
  /** Manifest schema version. */
  format: 1;
  /** Application name; used for display and grouping, never identity. */
  name: string;
  /** Application version string; informational, never identity. */
  version: string;
  /** Entry module path, relative to the cask root. */
  entry: string;
  /**
   * Desired active-active replica count; deployments default to one. The
   * controller keeps this many running, spread across distinct nodes when
   * membership allows.
   */
  replicas?: number;
  /**
   * Milliseconds a replica must run without exiting before it counts as
   * ready. Readiness gates rolling replacement: an old replica is only
   * terminated once its successor has been up this long. Defaults to 2000.
   */
  readyAfterMs?: number;
  /**
   * Minimum ready replicas (old and new generations combined) that must
   * survive every rollout step. Defaults to the replica count minus one,
   * never below one.
   */
  minHealthy?: number;
  /** Millisecond timestamp of packing. */
  createdAt: number;
}

/** A packed cask on disk. */
export interface PackedCask {
  path: string;
  /** Lowercase hex sha-256 of the archive bytes — the cask's identity. */
  hash: string;
  manifest: CaskManifest;
}

/** An unpacked cask in a node's cache. */
export interface UnpackedCask {
  /** Content-addressed directory holding the extracted tree. */
  dir: string;
  hash: string;
  manifest: CaskManifest;
  /** Absolute path of the manifest's entry module. */
  entryPath: string;
}

const MANIFEST_NAME = 'cask.json';
/** Written into an unpacked slot last; its presence means the slot is whole. */
const COMPLETE_MARKER = '.cask-complete';

const fs = new DiskFileSystem();

/** Join transfer chunks into one buffer. @internal */
export function concatCaskChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Lowercase-hex sha-256 — the cask identity function. @internal */
export async function caskSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseManifest(bytes: Uint8Array): CaskManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('cask: cask.json is not valid JSON');
  }
  const manifest = value as Partial<CaskManifest>;
  if (manifest.format !== 1) throw new Error('cask: unsupported manifest format');
  for (const key of ['name', 'version', 'entry'] as const) {
    if (typeof manifest[key] !== 'string' || manifest[key] === '') {
      throw new Error(`cask: manifest ${key} must be a non-empty string`);
    }
  }
  if (manifest.entry!.startsWith('/') || manifest.entry!.split('/').includes('..')) {
    throw new Error('cask: manifest entry must be a relative path inside the cask');
  }
  if (typeof manifest.createdAt !== 'number') {
    throw new Error('cask: manifest createdAt must be a number');
  }
  if (manifest.replicas !== undefined && (!Number.isInteger(manifest.replicas) || manifest.replicas < 1)) {
    throw new Error('cask: manifest replicas must be a positive integer');
  }
  if (
    manifest.readyAfterMs !== undefined &&
    (!Number.isInteger(manifest.readyAfterMs) || manifest.readyAfterMs < 0)
  ) {
    throw new Error('cask: manifest readyAfterMs must be a non-negative integer');
  }
  if (
    manifest.minHealthy !== undefined &&
    (!Number.isInteger(manifest.minHealthy) || manifest.minHealthy < 0)
  ) {
    throw new Error('cask: manifest minHealthy must be a non-negative integer');
  }
  return manifest as CaskManifest;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Archive `sourceDir` into a cask at `outputPath`.
 *
 * The manifest's `entry` must exist inside `sourceDir` — a cask that cannot
 * spawn is refused at pack time, not discovered at deploy time.
 */
export async function packCask(
  sourceDir: string,
  outputPath: string,
  options: {
    name: string;
    version: string;
    entry: string;
    replicas?: number;
    readyAfterMs?: number;
    minHealthy?: number;
  },
): Promise<PackedCask> {
  const entryFile = `${sourceDir}/${options.entry}`;
  if (options.entry.startsWith('/') || options.entry.split('/').includes('..')) {
    throw new Error('cask: entry must be a relative path inside the source directory');
  }
  if (!(await exists(entryFile))) {
    throw new Error(`cask: entry ${options.entry} does not exist under ${sourceDir}`);
  }
  if (options.replicas !== undefined && (!Number.isInteger(options.replicas) || options.replicas < 1)) {
    throw new Error('cask: replicas must be a positive integer');
  }
  if (
    options.readyAfterMs !== undefined &&
    (!Number.isInteger(options.readyAfterMs) || options.readyAfterMs < 0)
  ) {
    throw new Error('cask: readyAfterMs must be a non-negative integer');
  }
  if (
    options.minHealthy !== undefined &&
    (!Number.isInteger(options.minHealthy) || options.minHealthy < 0)
  ) {
    throw new Error('cask: minHealthy must be a non-negative integer');
  }
  const manifest: CaskManifest = {
    format: 1,
    name: options.name,
    version: options.version,
    entry: options.entry,
    ...(options.replicas === undefined ? {} : { replicas: options.replicas }),
    ...(options.readyAfterMs === undefined ? {} : { readyAfterMs: options.readyAfterMs }),
    ...(options.minHealthy === undefined ? {} : { minHealthy: options.minHealthy }),
    createdAt: Date.now(),
  };
  const archive = await createArchive(outputPath, { format: 'tar.gz' });
  try {
    await archive.addDirectory(sourceDir);
    await archive.write(MANIFEST_NAME, JSON.stringify(manifest));
  } finally {
    await archive.close();
  }
  const hash = await caskSha256Hex(await fs.readFile(outputPath));
  return { path: outputPath, hash, manifest };
}

/** Read and validate a cask's manifest and hash without unpacking it. */
export async function inspectCask(path: string): Promise<{ hash: string; manifest: CaskManifest }> {
  const hash = await caskSha256Hex(await fs.readFile(path));
  const archive = await openArchive(path, { format: 'tar.gz', readOnly: true });
  try {
    const manifest = parseManifest(await archive.read(MANIFEST_NAME));
    return { hash, manifest };
  } finally {
    await archive.close();
  }
}

/**
 * Unpack a cask into `cacheDir/sha256-<hash>` and return the spawnable slot.
 *
 * When `expectedHash` is given, bytes that do not match are refused before
 * anything touches the cache — a corrupted or substituted artifact cannot
 * poison the slot its sender claimed. Re-unpacking an already complete hash
 * returns the existing slot untouched.
 */
export async function unpackCask(
  path: string,
  cacheDir: string,
  options: { expectedHash?: string } = {},
): Promise<UnpackedCask> {
  const bytes = await fs.readFile(path);
  const hash = await caskSha256Hex(bytes);
  if (options.expectedHash !== undefined && options.expectedHash !== hash) {
    throw new Error(`cask: hash mismatch: expected ${options.expectedHash}, got ${hash}`);
  }
  const slot = `${cacheDir}/sha256-${hash}`;
  const finish = async (): Promise<UnpackedCask> => {
    const manifest = parseManifest(await fs.readFile(`${slot}/${MANIFEST_NAME}`));
    return { dir: slot, hash, manifest, entryPath: `${slot}/${manifest.entry}` };
  };
  if (await exists(`${slot}/${COMPLETE_MARKER}`)) return finish();

  if (!(await exists(cacheDir))) await fs.mkdir(cacheDir);
  const staging = `${cacheDir}/.staging-${hash}-${Math.random().toString(36).slice(2, 8)}`;
  const archive = await openArchive(path, { format: 'tar.gz', readOnly: true });
  try {
    await archive.extract(staging);
  } finally {
    await archive.close();
  }
  const manifest = parseManifest(await fs.readFile(`${staging}/${MANIFEST_NAME}`));
  if (!(await exists(`${staging}/${manifest.entry}`))) {
    await removeTree(staging);
    throw new Error(`cask: entry ${manifest.entry} missing from archive`);
  }
  await fs.writeFile(`${staging}/${COMPLETE_MARKER}`, new Uint8Array(0));
  try {
    await fs.rename(staging, slot);
  } catch {
    // A concurrent unpack of the same hash won the rename; both slots hold
    // identical bytes, so losing is success.
    await removeTree(staging);
    if (!(await exists(`${slot}/${COMPLETE_MARKER}`))) {
      throw new Error(`cask: slot ${slot} exists but is incomplete`);
    }
  }
  return finish();
}

/**
 * Delete cached casks whose hash is not in `keep`. Returns removed hashes.
 * Incomplete staging leftovers from crashed unpacks are always removed.
 */
export async function gcCasks(cacheDir: string, keep: ReadonlySet<string>): Promise<string[]> {
  if (!(await exists(cacheDir))) return [];
  const removed: string[] = [];
  for await (const entry of await fs.dir(cacheDir)) {
    const name = entry.name;
    if (name.startsWith('.staging-')) {
      await removeTree(`${cacheDir}/${name}`);
      continue;
    }
    if (!name.startsWith('sha256-')) continue;
    const hash = name.slice('sha256-'.length);
    if (keep.has(hash)) continue;
    await removeTree(`${cacheDir}/${name}`);
    removed.push(hash);
  }
  return removed;
}

/**
 * Delete stored cask artifacts (`<hash>.cask` files) whose hash is not in
 * `keep` and whose file is older than `graceMs`. The grace window protects
 * artifacts uploaded moments ago whose deployment record has not landed yet.
 * Returns removed hashes.
 */
export async function gcCaskStore(
  storeDir: string,
  keep: ReadonlySet<string>,
  graceMs: number,
  now = Date.now(),
): Promise<string[]> {
  if (!(await exists(storeDir))) return [];
  const removed: string[] = [];
  for await (const entry of await fs.dir(storeDir)) {
    const name = entry.name;
    if (!name.endsWith('.cask')) continue;
    const hash = name.slice(0, -'.cask'.length);
    if (!/^[0-9a-f]{64}$/.test(hash) || keep.has(hash)) continue;
    const stat = await fs.stat(`${storeDir}/${name}`).catch(() => null);
    if (stat === null || now - stat.mtimeMs < graceMs) continue;
    await fs.unlink(`${storeDir}/${name}`);
    removed.push(hash);
  }
  return removed;
}

async function removeTree(path: string): Promise<void> {
  const stat = await fs.lstat(path).catch(() => null);
  if (stat === null) return;
  if (stat.isDirectory()) {
    for await (const entry of await fs.dir(path)) {
      await removeTree(`${path}/${entry.name}`);
    }
    await fs.rmdir(path);
  } else {
    await fs.unlink(path);
  }
}
