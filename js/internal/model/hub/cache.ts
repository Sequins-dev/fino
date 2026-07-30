/**
 * The content-addressed model cache.
 *
 * A file's identity in this cache is its sha256, not its path in a repository:
 * two revisions that share a `config.json` share one blob, and a re-download that
 * produces the same bytes is a no-op. Per-repo manifests map the human-facing
 * `repo@commit/path` back onto the blobs, which keeps the blob store free of
 * naming decisions and makes it safe to prune by digest.
 *
 * Every path is derived, never invented, so two processes on the same machine
 * agree on where a file lives without coordinating.
 *
 * @internal
 */
import { DiskFileSystem } from 'fino:file';
import { dirname } from 'fino:file/path';
import { env } from 'fino:process';
import { IncrementalDigest } from '../../openssl.ts';

const fs = new DiskFileSystem();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Which kind of repository a reference names. */
export type RepoType = 'model' | 'dataset';

/** What the cache knows about one file of one commit. */
export interface ManifestEntry {
  /** Size in bytes. */
  size: number;
  /** Lowercase hex sha256 of the contents. */
  sha256: string;
}

/** The recorded contents of one repository commit. */
export interface Manifest {
  type: RepoType;
  repo: string;
  commit: string;
  /** Repository-relative path to digest, in sorted key order. */
  files: Record<string, ManifestEntry>;
}

/** `true` when the path exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Create a directory and any missing parents. */
export async function ensureDir(path: string): Promise<void> {
  if (path === '' || path === '/') return;
  if (await exists(path)) return;
  const parent = dirname(path).toString();
  if (parent !== '' && parent !== path) await ensureDir(parent);
  if (!(await exists(path))) {
    try {
      await fs.mkdir(path);
    } catch (error) {
      // A concurrent writer may have created it between the check and the call.
      if (!(await exists(path))) throw error;
    }
  }
}

/** Size in bytes, or `null` when the path does not exist. */
export async function sizeOf(path: string): Promise<number | null> {
  try {
    return Number((await fs.stat(path)).size);
  } catch {
    return null;
  }
}

/**
 * Resolve the cache root.
 *
 * `FINO_MODEL_CACHE` wins so a project can pin its own location; `HF_HOME` is
 * honored next because a machine that already caches Hugging Face artifacts
 * should not need a second copy of the setting.
 */
export function defaultCacheRoot(): string {
  const explicit = env.FINO_MODEL_CACHE;
  if (typeof explicit === 'string' && explicit !== '') return _stripSlash(explicit);
  const hfHome = env.HF_HOME;
  if (typeof hfHome === 'string' && hfHome !== '') return `${_stripSlash(hfHome)}/fino`;
  const xdg = env.XDG_CACHE_HOME;
  if (typeof xdg === 'string' && xdg !== '') return `${_stripSlash(xdg)}/fino/models`;
  const home = env.HOME;
  if (typeof home === 'string' && home !== '') return `${_stripSlash(home)}/.cache/fino/models`;
  return '/tmp/fino-models';
}

function _stripSlash(path: string): string {
  return path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
}

/**
 * A repository identifier that is safe as one path segment.
 *
 * `owner/name` becomes `owner--name`. The separator cannot appear in a Hugging
 * Face namespace or repository name, so the mapping is unambiguous.
 */
export function repoSlug(repo: string): string {
  return repo.split('/').join('--');
}

/** Deterministic key for a single file of a single commit. */
export function fileKey(type: RepoType, repo: string, commit: string, path: string): string {
  return `${type}:${repo}@${commit}/${path}`;
}

/** Lowercase hex sha256 of a string, used to name partial downloads. */
export function hashKey(key: string): string {
  using digest = new IncrementalDigest('sha-256');
  digest.update(encoder.encode(key));
  return digest.hex();
}

/** Lowercase hex sha256 of a buffer. */
export function digestBytes(bytes: Uint8Array): string {
  using digest = new IncrementalDigest('sha-256');
  digest.update(bytes);
  return digest.hex();
}

/** How much of a file to hash per read when verifying it. */
const DIGEST_CHUNK = 1 << 20;

/**
 * Lowercase hex sha256 of a file, read in chunks.
 *
 * Verifying a blob must not depend on it fitting in memory — model weights are
 * the whole reason this cache exists.
 */
export async function digestFile(path: string): Promise<string> {
  using digest = new IncrementalDigest('sha-256');
  const handle = await fs.open(path, 'r');
  try {
    const total = Number(await handle.size());
    let at = 0;
    while (at < total) {
      const chunk = await handle.pread(at, Math.min(DIGEST_CHUNK, total - at));
      if (chunk.byteLength === 0) break;
      digest.update(chunk);
      at += chunk.byteLength;
    }
  } finally {
    await handle.close();
  }
  return digest.hex();
}

/** The cache's on-disk layout. */
export class ModelCache {
  /** Cache root directory. */
  readonly root: string;

  constructor(root: string = defaultCacheRoot()) {
    this.root = _stripSlash(root);
  }

  /** Where a blob with this digest lives. */
  blobPath(sha256: string): string {
    // Two leading levels keep any one directory from collecting every blob.
    return `${this.root}/blobs/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  }

  /** Where the manifest for one commit lives. */
  manifestPath(type: RepoType, repo: string, commit: string): string {
    return `${this.root}/manifests/${type}s/${repoSlug(repo)}/${commit}.json`;
  }

  /** Where an in-progress download for one file lives. */
  partialPath(type: RepoType, repo: string, commit: string, path: string): string {
    return `${this.root}/partials/${hashKey(fileKey(type, repo, commit, path))}.partial`;
  }

  /** `true` when a blob with this digest is already stored. */
  async hasBlob(sha256: string): Promise<boolean> {
    return exists(this.blobPath(sha256));
  }

  /** Read a stored blob. */
  async readBlob(sha256: string): Promise<Uint8Array> {
    return fs.readFile(this.blobPath(sha256));
  }

  /**
   * Move a completed file into the blob store.
   *
   * A blob that is already present wins: identical contents make the incoming
   * copy redundant, and keeping the existing one avoids replacing a file another
   * process may be reading.
   */
  async commitBlob(from: string, sha256: string): Promise<string> {
    const target = this.blobPath(sha256);
    if (await exists(target)) {
      await fs.unlink(from);
      return target;
    }
    await ensureDir(dirname(target).toString());
    await fs.rename(from, target);
    return target;
  }

  /** Store a buffer as a blob, returning its digest. */
  async writeBlob(bytes: Uint8Array): Promise<{ sha256: string; path: string }> {
    const sha256 = digestBytes(bytes);
    const target = this.blobPath(sha256);
    if (!(await exists(target))) {
      await ensureDir(dirname(target).toString());
      await fs.writeFile(target, bytes);
    }
    return { sha256, path: target };
  }

  /** Read a stored manifest, or `null` when the commit has not been fetched. */
  async readManifest(type: RepoType, repo: string, commit: string): Promise<Manifest | null> {
    const path = this.manifestPath(type, repo, commit);
    if (!(await exists(path))) return null;
    try {
      return JSON.parse(decoder.decode(await fs.readFile(path))) as Manifest;
    } catch {
      return null;
    }
  }

  /**
   * Merge entries into a commit's manifest.
   *
   * Manifests accumulate: fetching one file at a time and fetching a whole
   * snapshot converge on the same record, and keys are written sorted so the
   * file is byte-stable across runs.
   */
  async updateManifest(
    type: RepoType,
    repo: string,
    commit: string,
    files: Record<string, ManifestEntry>,
  ): Promise<Manifest> {
    const existing = await this.readManifest(type, repo, commit);
    const merged: Record<string, ManifestEntry> = { ...(existing?.files ?? {}), ...files };
    const manifest: Manifest = {
      type,
      repo,
      commit,
      files: sortedFiles(merged),
    };
    const path = this.manifestPath(type, repo, commit);
    await ensureDir(dirname(path).toString());
    await fs.writeFile(path, encoder.encode(JSON.stringify(manifest, null, 2) + '\n'));
    return manifest;
  }
}

/** A file map with keys in sorted order, so serialization is stable. */
export function sortedFiles(files: Record<string, ManifestEntry>): Record<string, ManifestEntry> {
  const out: Record<string, ManifestEntry> = {};
  for (const key of Object.keys(files).sort()) out[key] = files[key];
  return out;
}
