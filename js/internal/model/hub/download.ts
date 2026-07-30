/**
 * Resumable, verified file transfer.
 *
 * Model weights are large enough that a failed transfer has to resume rather than
 * restart, so a download writes to a deterministically-named partial file and, on
 * a retry, asks for `bytes=<n>-` from where it stopped. The sha256 is computed as
 * the bytes stream past — never by re-reading the finished file — and on resume the
 * bytes already on disk are replayed through the digest first, so the hash covers
 * the whole file even though the transfer did not.
 *
 * A server that ignores `Range` and answers `200` is handled by starting over
 * rather than by appending, which would otherwise corrupt the file silently.
 *
 * @internal
 */
import { DiskFileSystem } from 'fino:file';
import { dirname } from 'fino:file/path';
import { IncrementalDigest } from '../../openssl.ts';
import { ensureDir, sizeOf } from './cache.ts';

const fs = new DiskFileSystem();

/** How many bytes to replay through the digest at a time when resuming. */
const REPLAY_CHUNK = 1 << 20;

/** The fetch implementation to use, injectable for testing. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Progress during a transfer. */
export interface TransferProgress {
  /** Bytes on disk so far, including any resumed from a previous attempt. */
  transferred: number;
  /** Total bytes expected, or `null` when the server did not say. */
  total: number | null;
}

/** Options for one transfer. */
export interface TransferOptions {
  fetch?: FetchLike;
  headers?: Record<string, string>;
  /** Attempts, including the first. Defaults to 3. */
  attempts?: number;
  /** Expected digest; a mismatch fails the transfer. */
  expectedSha256?: string;
  /** Expected size; a mismatch fails the transfer. */
  expectedSize?: number;
  onProgress?: (progress: TransferProgress) => void;
  signal?: AbortSignal;
}

/** The outcome of a transfer. */
export interface TransferResult {
  sha256: string;
  size: number;
  /** `true` when the transfer picked up from an earlier partial file. */
  resumed: boolean;
  /** How many HTTP requests it took. */
  attempts: number;
}

/** Raised when a transfer's bytes do not match what was expected. */
export class IntegrityError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(what: string, expected: string, actual: string) {
    super(`hub: ${what} mismatch — expected ${expected}, got ${actual}`);
    this.name = 'IntegrityError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Fetch `url` into `partialPath`, resuming if a partial file is already there.
 *
 * Returns the digest and size of the completed file, which stays at
 * `partialPath` for the caller to move into place — separating transfer from
 * placement is what lets the cache decide that a blob already exists.
 */
export async function transfer(
  url: string,
  partialPath: string,
  options: TransferOptions = {},
): Promise<TransferResult> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const maxAttempts = Math.max(1, options.attempts ?? 3);
  await ensureDir(dirname(partialPath).toString());

  let attempts = 0;
  let lastError: unknown = null;
  let resumed = false;

  while (attempts < maxAttempts) {
    attempts++;
    const already = (await sizeOf(partialPath)) ?? 0;
    if (already > 0) resumed = true;
    if (options.expectedSize !== undefined && already > options.expectedSize) {
      // A partial longer than the file cannot be a prefix of it.
      await fs.unlink(partialPath);
      continue;
    }
    try {
      const outcome = await _attempt(url, partialPath, already, doFetch, options);
      if (outcome.restart) {
        // The server ignored the range; drop what we have and try from zero.
        await fs.unlink(partialPath);
        resumed = false;
        continue;
      }
      return { ...outcome.result, resumed, attempts };
    } catch (error) {
      lastError = error;
      if (error instanceof IntegrityError) {
        // Bad bytes are not worth resuming from.
        await fs.unlink(partialPath).catch(() => {});
        throw error;
      }
      if (options.signal?.aborted === true) throw error;
    }
  }
  throw new Error(
    `hub: failed to fetch ${url} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ` +
      String(lastError),
  );
}

interface Attempt {
  restart: boolean;
  result: { sha256: string; size: number };
}

async function _attempt(
  url: string,
  partialPath: string,
  already: number,
  doFetch: FetchLike,
  options: TransferOptions,
): Promise<Attempt> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (already > 0) headers.range = `bytes=${already}-`;
  const response = await doFetch(url, { headers, signal: options.signal });

  if (response.status === 416 && already > 0) {
    // The range is past the end of the resource: what is on disk is not a prefix.
    return { restart: true, result: { sha256: '', size: 0 } };
  }
  if (!response.ok) {
    throw new Error(`hub: HTTP ${response.status} fetching ${url}`);
  }
  const partial = response.status === 206;
  if (already > 0 && !partial) {
    // A 200 to a ranged request is the whole file, so appending would duplicate.
    return { restart: true, result: { sha256: '', size: 0 } };
  }
  const start = partial ? already : 0;
  const total = _expectedTotal(response, start, options.expectedSize);

  using digest = new IncrementalDigest('sha-256');
  if (start > 0) await _replay(partialPath, start, digest);

  const handle = await fs.open(partialPath, 'c+');
  let written = start;
  try {
    if (start === 0) await handle.truncate(0);
    for await (const chunk of _chunks(response)) {
      await handle.pwrite(written, chunk);
      digest.update(chunk);
      written += chunk.byteLength;
      options.onProgress?.({ transferred: written, total });
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (total !== null && written !== total) {
    throw new Error(`hub: ${url} ended after ${written} of ${total} bytes`);
  }
  if (options.expectedSize !== undefined && written !== options.expectedSize) {
    throw new IntegrityError('size', String(options.expectedSize), String(written));
  }
  const sha256 = digest.hex();
  if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
    throw new IntegrityError('sha256', options.expectedSha256, sha256);
  }
  return { restart: false, result: { sha256, size: written } };
}

/** The full resource size, from `Content-Range` when present. */
function _expectedTotal(
  response: Response,
  start: number,
  expectedSize: number | undefined,
): number | null {
  const contentRange = response.headers.get('content-range');
  if (contentRange !== null) {
    const match = /\/\s*(\d+)\s*$/.exec(contentRange);
    if (match !== null) return Number(match[1]);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && contentLength !== '') {
    const length = Number(contentLength);
    if (Number.isFinite(length)) return start + length;
  }
  return expectedSize ?? null;
}

/** Feed the bytes already on disk through the digest before continuing. */
async function _replay(path: string, upto: number, digest: IncrementalDigest): Promise<void> {
  const handle = await fs.open(path, 'r');
  try {
    let at = 0;
    while (at < upto) {
      const chunk = await handle.pread(at, Math.min(REPLAY_CHUNK, upto - at));
      if (chunk.byteLength === 0) {
        throw new Error(`hub: ${path} ended at ${at} while replaying ${upto} bytes`);
      }
      digest.update(chunk);
      at += chunk.byteLength;
    }
  } finally {
    await handle.close();
  }
}

/** Iterate a response body as chunks, whatever shape it arrives in. */
async function* _chunks(response: Response): AsyncGenerator<Uint8Array> {
  const body = response.body;
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 0) yield bytes;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
