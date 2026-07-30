/**
 * fino:model/hub - reproducible model and dataset resolution from a Hugging Face hub.
 *
 * Resolves a revision to a commit, fetches files with resumable ranged requests,
 * verifies sha256 as the bytes arrive, stores them content-addressed, and pins
 * repository → commit → digests in a project `models.lock`. The lockfile is the
 * point of the module: `main` is a moving target, so a script that loads a model
 * by revision can silently load different weights tomorrow. Pinned, a later run
 * resolves from the lock rather than the network and fails loudly if the bytes it
 * gets back are not the bytes that were pinned.
 *
 * Everything runs on Fino's own HTTP stack, and every cache path is derived from
 * the repository, commit, and digest rather than invented, so two processes agree
 * on where a file lives without coordinating and a resumed transfer finds its own
 * partial file after a restart.
 *
 * The same client resolves dataset repositories through the same cache and
 * lockfile discipline; pass `type: 'dataset'`.
 *
 * ```ts no_run
 * import { HubClient } from 'fino:model/hub';
 *
 * const hub = new HubClient({ lockfile: './models.lock' });
 * const file = await hub.download(
 *   { repo: 'bert-base-uncased', revision: 'main' },
 *   'tokenizer.json',
 * );
 * console.log(file.commit, file.sha256, file.path);
 * ```
 */
import { DiskFileSystem } from 'fino:file';
import { cwd, env } from 'fino:process';
import {
  ModelCache,
  defaultCacheRoot,
  digestFile,
  exists,
  type ManifestEntry,
  type RepoType,
} from '../internal/model/hub/cache.ts';
import {
  emptyLockfile,
  lockKey,
  pin,
  readLockfile,
  writeLockfile,
  type LockEntry,
  type Lockfile,
} from '../internal/model/hub/lockfile.ts';
import {
  IntegrityError,
  transfer,
  type FetchLike,
  type TransferProgress,
} from '../internal/model/hub/download.ts';

export type { RepoType, Manifest, ManifestEntry } from '../internal/model/hub/cache.ts';
export type { LockEntry, Lockfile } from '../internal/model/hub/lockfile.ts';
export type { TransferProgress } from '../internal/model/hub/download.ts';
export { IntegrityError } from '../internal/model/hub/download.ts';
export { ModelCache, defaultCacheRoot } from '../internal/model/hub/cache.ts';
export { LOCKFILE_VERSION, readLockfile, writeLockfile } from '../internal/model/hub/lockfile.ts';

const fs = new DiskFileSystem();
const decoder = new TextDecoder();

/** The default public hub. */
export const HUGGING_FACE_ENDPOINT = 'https://huggingface.co';

/** A repository revision to resolve. */
export interface RepoRef {
  /** `owner/name`, or a bare name for a canonical repository. */
  repo: string;
  /** Branch, tag, or commit. Defaults to `main`. */
  revision?: string;
  /** Repository kind. Defaults to `model`. */
  type?: RepoType;
}

/** Client construction options. */
export interface HubClientOptions {
  /** Hub root. Defaults to `https://huggingface.co`. */
  endpoint?: string;
  /** Bearer token. Defaults to `HF_TOKEN`, then `HUGGING_FACE_HUB_TOKEN`. */
  token?: string | null;
  /** Cache root. Defaults to the resolved model cache directory. */
  cacheDir?: string;
  /** Lockfile path, or `null` to run unpinned. Defaults to `./models.lock`. */
  lockfile?: string | null;
  /** Injectable transport, for tests and for self-hosted transports. */
  fetch?: FetchLike;
  /** Attempts per transfer, including the first. Defaults to 3. */
  attempts?: number;
  /** Concurrent transfers in `snapshot`. Defaults to 4. */
  concurrency?: number;
  /** Never touch the network; only serve what is already cached. */
  offline?: boolean;
}

/** Options shared by the fetching methods. */
export interface FetchOptions {
  /**
   * Re-resolve the revision even when the lockfile pins it.
   *
   * This is how a pin is moved forward: without it, a pinned revision never
   * consults the network for a new commit.
   */
  update?: boolean;
  onProgress?: (progress: TransferProgress & { path: string }) => void;
  signal?: AbortSignal;
}

/** Options for fetching a whole revision. */
export interface SnapshotOptions extends FetchOptions {
  /** Only fetch files matching one of these predicates or suffixes. */
  allow?: ReadonlyArray<string | RegExp>;
  /** Skip files matching one of these suffixes or patterns. */
  ignore?: ReadonlyArray<string | RegExp>;
}

/** A file resolved into the cache. */
export interface HubFile {
  type: RepoType;
  repo: string;
  revision: string;
  commit: string;
  /** Repository-relative path. */
  name: string;
  /** Absolute path of the cached blob. */
  path: string;
  sha256: string;
  size: number;
  /** `true` when the bytes were already cached and no transfer ran. */
  cached: boolean;
}

/** A whole revision resolved into the cache. */
export interface HubSnapshot {
  type: RepoType;
  repo: string;
  revision: string;
  commit: string;
  files: HubFile[];
}

/** One entry of a repository listing. */
export interface HubFileInfo {
  /** Repository-relative path. */
  name: string;
  /** Size in bytes, when the hub reported one. */
  size: number | null;
  /** Content sha256, when the file is LFS-tracked and the hub reported one. */
  sha256: string | null;
}

/** The outcome of verifying the cache against the lockfile. */
export interface VerifyReport {
  /** Files whose cached bytes match the pinned digest. */
  ok: string[];
  /** Files pinned but not present in the cache. */
  missing: string[];
  /** Files present with contents that do not match the pin. */
  corrupt: string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A Hugging Face-compatible hub client.
 *
 * One instance owns one cache root and one lockfile. Methods are safe to call
 * concurrently against distinct paths; `snapshot` batches its lockfile write so a
 * multi-file fetch produces one pin rather than a series of partial ones.
 */
export class HubClient {
  #endpoint: string;
  #token: string | null;
  #cache: ModelCache;
  #lockfilePath: string | null;
  #fetch: FetchLike;
  #attempts: number;
  #concurrency: number;
  #offline: boolean;
  /** Serializes read-modify-write cycles on the lockfile. */
  #lockWrites: Promise<unknown> = Promise.resolve();

  constructor(options: HubClientOptions = {}) {
    this.#endpoint = (options.endpoint ?? HUGGING_FACE_ENDPOINT).replace(/\/+$/, '');
    this.#token = options.token !== undefined ? options.token : _tokenFromEnv();
    this.#cache = new ModelCache(options.cacheDir ?? defaultCacheRoot());
    this.#lockfilePath =
      options.lockfile !== undefined ? options.lockfile : `${cwd().replace(/\/$/, '')}/models.lock`;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#attempts = options.attempts ?? 3;
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
    this.#offline = options.offline ?? false;
  }

  /** The cache this client reads and writes. */
  get cache(): ModelCache {
    return this.#cache;
  }

  /** The lockfile path, or `null` when running unpinned. */
  get lockfilePath(): string | null {
    return this.#lockfilePath;
  }

  /** The current lockfile contents. */
  async lockfile(): Promise<Lockfile> {
    if (this.#lockfilePath === null) return emptyLockfile();
    return readLockfile(this.#lockfilePath);
  }

  /** The pinned entry for a revision, or `null` when it is not pinned. */
  async pinned(ref: RepoRef): Promise<LockEntry | null> {
    const { type, repo, revision } = _normalize(ref);
    const lock = await this.lockfile();
    return lock.entries[lockKey(type, repo, revision)] ?? null;
  }

  /**
   * Resolve a revision to a commit.
   *
   * A pinned revision resolves from the lockfile without a request, which is what
   * makes a locked project's resolution reproducible and offline-capable. Pass
   * `update` to consult the hub instead.
   */
  async resolveRevision(ref: RepoRef, options: FetchOptions = {}): Promise<string> {
    const { type, repo, revision } = _normalize(ref);
    if (options.update !== true) {
      const entry = await this.pinned({ type, repo, revision });
      if (entry !== null) return entry.commit;
      // A revision that is already a commit needs no lookup.
      if (SHA256_HEX.test(revision) || /^[0-9a-f]{40}$/.test(revision)) return revision;
    }
    if (this.#offline) {
      throw new Error(`hub: ${repo}@${revision} is not pinned or cached and the client is offline`);
    }
    const info = await this.#revisionInfo(type, repo, revision);
    return info.commit;
  }

  /**
   * List the files of a revision without downloading them.
   *
   * Sizes and digests come from the hub's own metadata, so this is enough to
   * decide what is worth fetching before any bytes move.
   */
  async listFiles(ref: RepoRef, options: FetchOptions = {}): Promise<HubFileInfo[]> {
    const { type, repo, revision } = _normalize(ref);
    if (this.#offline) {
      const commit = await this.resolveRevision({ type, repo, revision }, options);
      const manifest = await this.#cache.readManifest(type, repo, commit);
      if (manifest === null) {
        throw new Error(`hub: no cached listing for ${repo}@${commit} and the client is offline`);
      }
      return Object.entries(manifest.files).map(([name, entry]) => ({
        name,
        size: entry.size,
        sha256: entry.sha256,
      }));
    }
    return (await this.#revisionInfo(type, repo, revision)).files;
  }

  /** Fetch one file, returning where it landed in the cache. */
  async download(ref: RepoRef, name: string, options: FetchOptions = {}): Promise<HubFile> {
    const { type, repo, revision } = _normalize(ref);
    const commit = await this.resolveRevision({ type, repo, revision }, options);
    const file = await this.#fetchOne(type, repo, revision, commit, name, null, options);
    await this.#recordPins(type, repo, revision, commit, {
      [name]: { size: file.size, sha256: file.sha256 },
    });
    return file;
  }

  /** Fetch one file and return its contents. */
  async load(ref: RepoRef, name: string, options?: FetchOptions): Promise<Uint8Array> {
    const file = await this.download(ref, name, options);
    return fs.readFile(file.path);
  }

  /** Fetch one file and return its contents decoded as UTF-8. */
  async loadText(ref: RepoRef, name: string, options?: FetchOptions): Promise<string> {
    return decoder.decode(await this.load(ref, name, options));
  }

  /**
   * Fetch a whole revision.
   *
   * Transfers run concurrently up to the client's limit and the lockfile is
   * written once at the end, so a snapshot either pins the set it fetched or
   * leaves the previous pin alone.
   */
  async snapshot(ref: RepoRef, options: SnapshotOptions = {}): Promise<HubSnapshot> {
    const { type, repo, revision } = _normalize(ref);
    const commit = await this.resolveRevision({ type, repo, revision }, options);
    const listing = await this.listFiles({ type, repo, revision }, options);
    const wanted = listing.filter((info) => _selected(info.name, options));
    const files = await this.#pooled(wanted, (info) =>
      this.#fetchOne(type, repo, revision, commit, info.name, info, options),
    );
    const entries: Record<string, ManifestEntry> = {};
    for (const file of files) entries[file.name] = { size: file.size, sha256: file.sha256 };
    await this.#recordPins(type, repo, revision, commit, entries);
    return { type, repo, revision, commit, files };
  }

  /**
   * Check the cache against the lockfile.
   *
   * Re-hashes every pinned blob rather than trusting its filename, so a blob that
   * was truncated or edited in place is reported as corrupt instead of served.
   */
  async verify(): Promise<VerifyReport> {
    const lock = await this.lockfile();
    const report: VerifyReport = { ok: [], missing: [], corrupt: [] };
    for (const [key, entry] of Object.entries(lock.entries)) {
      for (const [name, pinnedEntry] of Object.entries(entry.files)) {
        const label = `${key}/${name}`;
        const path = this.#cache.blobPath(pinnedEntry.sha256);
        if (!(await exists(path))) {
          report.missing.push(label);
          continue;
        }
        const actual = await digestFile(path);
        if (actual === pinnedEntry.sha256) report.ok.push(label);
        else report.corrupt.push(label);
      }
    }
    return report;
  }

  /** The URL a file resolves to on this hub. */
  fileUrl(type: RepoType, repo: string, commit: string, name: string): string {
    const prefix = type === 'dataset' ? 'datasets/' : '';
    const path = name.split('/').map(encodeURIComponent).join('/');
    return `${this.#endpoint}/${prefix}${repo}/resolve/${commit}/${path}`;
  }

  /** Fetch one file without touching the lockfile. */
  async #fetchOne(
    type: RepoType,
    repo: string,
    revision: string,
    commit: string,
    name: string,
    info: HubFileInfo | null,
    options: FetchOptions,
  ): Promise<HubFile> {
    const base: Omit<HubFile, 'path' | 'sha256' | 'size' | 'cached'> = {
      type,
      repo,
      revision,
      commit,
      name,
    };
    const pinnedSha = await this.#pinnedDigest(type, repo, revision, commit, name);

    // A manifest hit plus a present blob means the bytes are already here, and the
    // digest in the manifest is what they hashed to when they arrived.
    const manifest = await this.#cache.readManifest(type, repo, commit);
    const known = manifest?.files[name];
    if (known !== undefined && (await this.#cache.hasBlob(known.sha256))) {
      if (pinnedSha !== null && pinnedSha !== known.sha256) {
        throw new IntegrityError(`sha256 for ${repo}@${commit}/${name}`, pinnedSha, known.sha256);
      }
      return {
        ...base,
        path: this.#cache.blobPath(known.sha256),
        sha256: known.sha256,
        size: known.size,
        cached: true,
      };
    }

    // A digest known before the transfer — pinned, or advertised by the hub for an
    // LFS-tracked file — can be answered straight from the blob store even under a
    // path this commit has never been fetched at. This is what makes re-pinning a
    // revision that only moved a README free.
    const knownSha = pinnedSha ?? info?.sha256 ?? null;
    if (knownSha !== null && (await this.#cache.hasBlob(knownSha))) {
      const size = info?.size ?? Number((await fs.stat(this.#cache.blobPath(knownSha))).size);
      await this.#cache.updateManifest(type, repo, commit, {
        [name]: { size, sha256: knownSha },
      });
      return {
        ...base,
        path: this.#cache.blobPath(knownSha),
        sha256: knownSha,
        size,
        cached: true,
      };
    }

    if (this.#offline) {
      throw new Error(`hub: ${repo}@${commit}/${name} is not cached and the client is offline`);
    }

    const url = this.fileUrl(type, repo, commit, name);
    const result = await transfer(url, this.#cache.partialPath(type, repo, commit, name), {
      fetch: this.#fetch,
      headers: this.#headers(),
      attempts: this.#attempts,
      expectedSha256: pinnedSha ?? info?.sha256 ?? undefined,
      expectedSize: info?.size ?? undefined,
      signal: options.signal,
      onProgress:
        options.onProgress === undefined
          ? undefined
          : (progress) => options.onProgress!({ ...progress, path: name }),
    });
    const path = await this.#cache.commitBlob(
      this.#cache.partialPath(type, repo, commit, name),
      result.sha256,
    );
    await this.#cache.updateManifest(type, repo, commit, {
      [name]: { size: result.size, sha256: result.sha256 },
    });
    return { ...base, path, sha256: result.sha256, size: result.size, cached: false };
  }

  /** The digest the lockfile pins for this file, if it pins this commit. */
  async #pinnedDigest(
    type: RepoType,
    repo: string,
    revision: string,
    commit: string,
    name: string,
  ): Promise<string | null> {
    const entry = await this.pinned({ type, repo, revision });
    if (entry === null || entry.commit !== commit) return null;
    return entry.files[name]?.sha256 ?? null;
  }

  /** Merge digests into the lockfile, one writer at a time. */
  async #recordPins(
    type: RepoType,
    repo: string,
    revision: string,
    commit: string,
    files: Record<string, ManifestEntry>,
  ): Promise<void> {
    const path = this.#lockfilePath;
    if (path === null || Object.keys(files).length === 0) return;
    const run = this.#lockWrites.then(async () => {
      const lock = await readLockfile(path);
      await writeLockfile(path, pin(lock, type, repo, revision, commit, files));
    });
    // Keep the chain alive even if this write fails, so later writes still run.
    this.#lockWrites = run.catch(() => {});
    await run;
  }

  /** Ask the hub what a revision resolves to and what it contains. */
  async #revisionInfo(
    type: RepoType,
    repo: string,
    revision: string,
  ): Promise<{ commit: string; files: HubFileInfo[] }> {
    const url =
      `${this.#endpoint}/api/${type}s/${repo}/revision/` +
      `${encodeURIComponent(revision)}?blobs=true`;
    const response = await this.#fetch(url, { headers: this.#headers() });
    if (!response.ok) {
      throw new Error(`hub: HTTP ${response.status} resolving ${repo}@${revision}`);
    }
    const body = (await response.json()) as {
      sha?: string;
      siblings?: Array<{
        rfilename?: string;
        size?: number;
        lfs?: { oid?: string; sha256?: string; size?: number };
      }>;
    };
    const commit = body.sha;
    if (typeof commit !== 'string' || commit === '') {
      throw new Error(`hub: ${repo}@${revision} returned no commit sha`);
    }
    const files: HubFileInfo[] = [];
    for (const sibling of body.siblings ?? []) {
      const name = sibling.rfilename;
      if (typeof name !== 'string' || name === '') continue;
      // For LFS-tracked files the hub publishes the content sha256, which lets a
      // transfer be verified against the hub's own record rather than only against
      // its own arithmetic. Plain git blobs carry a sha1 of a different preimage,
      // so there is nothing to check against on the first fetch.
      const oid = sibling.lfs?.sha256 ?? sibling.lfs?.oid;
      files.push({
        name,
        size: sibling.lfs?.size ?? sibling.size ?? null,
        sha256: typeof oid === 'string' && SHA256_HEX.test(oid) ? oid : null,
      });
    }
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { commit, files };
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#token !== null && this.#token !== '') {
      headers.authorization = `Bearer ${this.#token}`;
    }
    return headers;
  }

  /** Run `worker` over `items` with at most `concurrency` in flight. */
  async #pooled<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const runners = new Array(Math.min(this.#concurrency, items.length))
      .fill(null)
      .map(async () => {
        for (;;) {
          const index = next++;
          if (index >= items.length) return;
          out[index] = await worker(items[index]);
        }
      });
    await Promise.all(runners);
    return out;
  }
}

function _tokenFromEnv(): string | null {
  const token = env.HF_TOKEN ?? env.HUGGING_FACE_HUB_TOKEN;
  return typeof token === 'string' && token !== '' ? token : null;
}

function _normalize(ref: RepoRef): { type: RepoType; repo: string; revision: string } {
  if (typeof ref.repo !== 'string' || ref.repo === '') {
    throw new Error('hub: a repository reference needs a repo name');
  }
  return {
    type: ref.type ?? 'model',
    repo: ref.repo.replace(/^\/+|\/+$/g, ''),
    revision: ref.revision ?? 'main',
  };
}

/** Whether a file passes the snapshot's allow and ignore filters. */
function _selected(name: string, options: SnapshotOptions): boolean {
  const matches = (pattern: string | RegExp): boolean =>
    typeof pattern === 'string' ? name === pattern || name.endsWith(pattern) : pattern.test(name);
  if (options.ignore !== undefined && options.ignore.some(matches)) return false;
  if (options.allow !== undefined) return options.allow.some(matches);
  return true;
}
