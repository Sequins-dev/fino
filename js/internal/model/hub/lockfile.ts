/**
 * `models.lock` — the project-level pin from a revision to exact bytes.
 *
 * A revision like `main` is a moving target, so resolving it twice can produce
 * two different models with no record that anything changed. The lockfile records
 * the commit a revision resolved to and the sha256 of every file fetched from it;
 * later runs resolve through the lock instead of the network, and verify what they
 * download against it. This is the part of the client that makes a model load
 * reproducible, which is something the Python ecosystem does not give by default.
 *
 * The file is JSON with sorted keys and a trailing newline, so it diffs cleanly
 * and can be committed.
 *
 * @internal
 */
import { DiskFileSystem } from 'fino:file';
import { dirname } from 'fino:file/path';
import { ensureDir, exists, sortedFiles, type ManifestEntry, type RepoType } from './cache.ts';

const fs = new DiskFileSystem();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The format version written into the file. */
export const LOCKFILE_VERSION = 1;

/** One pinned repository revision. */
export interface LockEntry {
  type: RepoType;
  repo: string;
  /** The revision that was asked for, such as `main` or a tag. */
  revision: string;
  /** The commit it resolved to. */
  commit: string;
  /** Digests for the files fetched from this commit. */
  files: Record<string, ManifestEntry>;
}

/** The whole lockfile. */
export interface Lockfile {
  version: number;
  entries: Record<string, LockEntry>;
}

/** An empty lockfile. */
export function emptyLockfile(): Lockfile {
  return { version: LOCKFILE_VERSION, entries: {} };
}

/** The key one repository revision is pinned under. */
export function lockKey(type: RepoType, repo: string, revision: string): string {
  return `${type}:${repo}@${revision}`;
}

/**
 * Read a lockfile.
 *
 * A missing file is an empty lock, not an error — the first run of a project has
 * nothing pinned yet. A file that exists but cannot be parsed *is* an error,
 * because silently discarding pins would defeat the point.
 */
export async function readLockfile(path: string): Promise<Lockfile> {
  if (!(await exists(path))) return emptyLockfile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(await fs.readFile(path)));
  } catch (error) {
    throw new Error(`hub: ${path} is not valid JSON: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`hub: ${path} is not a lockfile object`);
  }
  const lock = parsed as Partial<Lockfile>;
  if (typeof lock.version !== 'number') {
    throw new Error(`hub: ${path} has no version field`);
  }
  if (lock.version > LOCKFILE_VERSION) {
    throw new Error(
      `hub: ${path} was written by a newer version (${lock.version} > ${LOCKFILE_VERSION})`,
    );
  }
  return { version: lock.version, entries: lock.entries ?? {} };
}

/** Write a lockfile with sorted keys. */
export async function writeLockfile(path: string, lock: Lockfile): Promise<void> {
  const entries: Record<string, LockEntry> = {};
  for (const key of Object.keys(lock.entries).sort()) {
    const entry = lock.entries[key];
    entries[key] = {
      type: entry.type,
      repo: entry.repo,
      revision: entry.revision,
      commit: entry.commit,
      files: sortedFiles(entry.files),
    };
  }
  const serialized = JSON.stringify({ version: LOCKFILE_VERSION, entries }, null, 2) + '\n';
  await ensureDir(dirname(path).toString());
  await fs.writeFile(path, encoder.encode(serialized));
}

/**
 * Record a commit and its file digests against a revision.
 *
 * A digest that disagrees with what is already pinned is a conflict, not an
 * update: the same commit cannot have produced two different files, so this
 * means either the lock or the download is wrong and the caller has to say which.
 */
export function pin(
  lock: Lockfile,
  type: RepoType,
  repo: string,
  revision: string,
  commit: string,
  files: Record<string, ManifestEntry>,
): Lockfile {
  const key = lockKey(type, repo, revision);
  const existing = lock.entries[key];
  const sameCommit = existing !== undefined && existing.commit === commit;
  if (sameCommit) {
    for (const [path, entry] of Object.entries(files)) {
      const pinned = existing.files[path];
      if (pinned !== undefined && pinned.sha256 !== entry.sha256) {
        throw new Error(
          `hub: ${repo}@${commit}/${path} hashes to ${entry.sha256} but ${key} pins ` +
            `${pinned.sha256}; the lockfile and the remote disagree`,
        );
      }
    }
  }
  const merged = sameCommit ? { ...existing.files, ...files } : { ...files };
  return {
    version: LOCKFILE_VERSION,
    entries: {
      ...lock.entries,
      [key]: { type, repo, revision, commit, files: sortedFiles(merged) },
    },
  };
}
