/**
 * Tests for `fino:model/hub`.
 *
 * These run against a local server that speaks the same shapes the Hugging Face
 * hub does — a revision API and a `resolve` endpoint with byte-range support — so
 * revision resolution, resumption, and digest verification are exercised end to
 * end over real HTTP rather than against a stubbed client.
 *
 * The interesting cases are the awkward ones: a transfer that dies mid-body, a
 * server that ignores `Range`, and a lockfile that disagrees with the remote.
 */
import { after, describe, it } from 'fino:test/test';
import { serveHttp } from 'fino:net/http/server';
import { DiskFileSystem } from 'fino:file';
import { HubClient, IntegrityError, readLockfile } from 'fino:model/hub';
import { ensureDir } from 'internal:model/hub/cache';

const fs = new DiskFileSystem();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Files the simulated hub serves, per commit. */
interface RepoState {
  commit: string;
  files: Map<string, Uint8Array>;
  /** Files to advertise an LFS content sha256 for. */
  lfs: Set<string>;
}

interface HubBehavior {
  /** Cut the response body off after this many bytes, once. */
  truncateAfter: number | null;
  /** Answer a ranged request with the whole file and a 200. */
  ignoreRange: boolean;
  /** Answer any ranged request with 416. */
  rejectRange: boolean;
  /** Fail the next N resolve requests with a 500. */
  failResolves: number;
  /** Serve different bytes than advertised, to force a digest mismatch. */
  corrupt: boolean;
  /** Authorization headers seen, in order. */
  authSeen: string[];
  /** Range headers seen, in order. */
  rangeSeen: string[];
  /** Count of resolve-endpoint requests. */
  fileRequests: number;
  /** Count of revision-API requests. */
  apiRequests: number;
}

interface SimulatedHub {
  endpoint: string;
  state: RepoState;
  behavior: HubBehavior;
  close: () => Promise<void>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Start a server that answers the hub endpoints this client uses. */
async function startHub(files: Record<string, string>): Promise<SimulatedHub> {
  const state: RepoState = {
    commit: 'a'.repeat(40),
    files: new Map(Object.entries(files).map(([name, text]) => [name, encoder.encode(text)])),
    lfs: new Set(),
  };
  const behavior: HubBehavior = {
    truncateAfter: null,
    ignoreRange: false,
    rejectRange: false,
    failResolves: 0,
    corrupt: false,
    authSeen: [],
    rangeSeen: [],
    fileRequests: 0,
    apiRequests: 0,
  };

  const server = serveHttp({ port: 0 }, async (request) => {
    const url = new URL(request.url);
    const auth = request.headers.get('authorization');
    if (auth !== null) behavior.authSeen.push(auth);

    const api = /^\/api\/(models|datasets)\/(.+)\/revision\/([^/?]+)$/.exec(url.pathname);
    if (api !== null) {
      behavior.apiRequests++;
      const siblings = [...state.files.entries()].map(([name, bytes]) => ({
        rfilename: name,
        size: bytes.byteLength,
        ...(state.lfs.has(name)
          ? { lfs: { sha256: _cachedDigest(name), size: bytes.byteLength } }
          : {}),
      }));
      return Response.json({ sha: state.commit, siblings });
    }

    const resolveMatch = /^(?:\/datasets)?\/(.+)\/resolve\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (resolveMatch === null) return new Response('not found', { status: 404 });
    behavior.fileRequests++;
    if (behavior.failResolves > 0) {
      behavior.failResolves--;
      return new Response('nope', { status: 500 });
    }
    const name = decodeURIComponent(resolveMatch[3]);
    const stored = state.files.get(name);
    if (stored === undefined) return new Response('not found', { status: 404 });
    const body = behavior.corrupt ? encoder.encode('tampered') : stored;

    const range = request.headers.get('range');
    if (range !== null) behavior.rangeSeen.push(range);

    if (range !== null && behavior.rejectRange) {
      return new Response('range not satisfiable', { status: 416 });
    }
    if (range !== null && !behavior.ignoreRange) {
      const start = Number(/^bytes=(\d+)-/.exec(range)?.[1] ?? '0');
      if (start >= body.byteLength) {
        return new Response('range not satisfiable', { status: 416 });
      }
      const slice = body.subarray(start);
      return new Response(_maybeTruncate(slice, behavior), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`,
          'content-length': String(slice.byteLength),
        },
      });
    }
    return new Response(_maybeTruncate(body, behavior), {
      status: 200,
      headers: { 'content-length': String(body.byteLength) },
    });
  });

  const digests = new Map<string, string>();
  for (const [name, bytes] of state.files) digests.set(name, await sha256Hex(bytes));
  function _cachedDigest(name: string): string {
    return digests.get(name) ?? '';
  }

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    state,
    behavior,
    close: () => server.close(),
  };
}

/**
 * A body that stops early when the behavior says to.
 *
 * The declared `content-length` still describes the whole file, which is exactly
 * what a connection dropping mid-transfer looks like to the client.
 */
function _maybeTruncate(bytes: Uint8Array, behavior: HubBehavior): BodyInit {
  const limit = behavior.truncateAfter;
  if (limit === null) return bytes;
  behavior.truncateAfter = null;
  const cut = bytes.subarray(0, Math.min(limit, bytes.byteLength));
  return {
    [Symbol.asyncIterator]: async function* () {
      yield cut;
    },
  } as unknown as BodyInit;
}

let counter = 0;
const scratchDirs: string[] = [];

/** A fresh cache root and lockfile path for one test. */
function scratch(): { cacheDir: string; lockfile: string } {
  const dir = `/tmp/fino-hub-test-${counter++}-${Math.floor(Math.random() * 1e9)}`;
  scratchDirs.push(dir);
  return { cacheDir: `${dir}/cache`, lockfile: `${dir}/models.lock` };
}

/** Write a file, creating its directory first. */
async function writeRaw(path: string, text: string): Promise<void> {
  await ensureDir(path.slice(0, path.lastIndexOf('/')));
  await fs.writeFile(path, encoder.encode(text));
}

async function removeTree(path: string): Promise<void> {
  try {
    const entry = await fs.entry(path);
    if (entry.isDirectory()) {
      const dir = await fs.dir(path);
      for (const child of await dir.entries()) await removeTree(child.path.toString());
      await fs.rmdir(path);
      return;
    }
    await fs.unlink(path);
  } catch {
    // Already gone.
  }
}

const FILES = {
  'config.json': '{"hidden_size":768}',
  'tokenizer.json': '{"model":{"type":"BPE","vocab":{},"merges":[]}}',
  'model.safetensors': 'x'.repeat(4096),
  'README.md': '# a model',
};

describe('revision resolution', () => {
  it('resolves a revision to a commit and lists its files', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      t.equal(await client.resolveRevision({ repo: 'acme/bert' }), hub.state.commit);
      const listing = await client.listFiles({ repo: 'acme/bert' });
      t.deepEqual(
        listing.map((file) => file.name),
        ['README.md', 'config.json', 'model.safetensors', 'tokenizer.json'],
        'the listing is sorted, so it is stable across runs',
      );
      t.equal(listing[1].size, FILES['config.json'].length);
      t.equal(listing[1].sha256, null, 'a plain git blob advertises no content digest');
    } finally {
      await hub.close();
    }
  });

  it('reports the hub s content digest for LFS-tracked files', async (t) => {
    const hub = await startHub(FILES);
    hub.state.lfs.add('model.safetensors');
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      const listing = await client.listFiles({ repo: 'acme/bert' });
      const weights = listing.find((file) => file.name === 'model.safetensors')!;
      t.equal(weights.sha256, await sha256Hex(encoder.encode(FILES['model.safetensors'])));
    } finally {
      await hub.close();
    }
  });

  it('takes a commit-shaped revision at face value', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      const commit = 'b'.repeat(40);
      t.equal(await client.resolveRevision({ repo: 'acme/bert', revision: commit }), commit);
      t.equal(hub.behavior.apiRequests, 0, 'no lookup is needed for a commit');
    } finally {
      await hub.close();
    }
  });

  it('sends a bearer token when one is configured', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({
        endpoint: hub.endpoint,
        ...scratch(),
        token: 'hf_secret',
      });
      await client.download({ repo: 'acme/bert' }, 'config.json');
      t.ok(hub.behavior.authSeen.length > 0, 'the token reached the hub');
      t.ok(
        hub.behavior.authSeen.every((value) => value === 'Bearer hf_secret'),
        'every request carries it',
      );
    } finally {
      await hub.close();
    }
  });
});

describe('download and cache', () => {
  it('stores a file content-addressed and verifies its digest', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const client = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      const file = await client.download({ repo: 'acme/bert' }, 'config.json');

      const expected = await sha256Hex(encoder.encode(FILES['config.json']));
      t.equal(file.sha256, expected, 'the digest is computed from the bytes received');
      t.equal(file.size, FILES['config.json'].length);
      t.equal(file.commit, hub.state.commit);
      t.equal(file.cached, false, 'the first fetch transfers');
      t.equal(
        file.path,
        client.cache.blobPath(expected),
        'the blob path is derived from the digest',
      );
      t.equal(decoder.decode(await fs.readFile(file.path)), FILES['config.json']);
    } finally {
      await hub.close();
    }
  });

  it('serves a second request from the cache without a transfer', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const client = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await client.download({ repo: 'acme/bert' }, 'config.json');
      const before = hub.behavior.fileRequests;
      const again = await client.download({ repo: 'acme/bert' }, 'config.json');
      t.equal(again.cached, true);
      t.equal(hub.behavior.fileRequests, before, 'no second request was made');
    } finally {
      await hub.close();
    }
  });

  it('shares one blob between files with identical contents', async (t) => {
    const hub = await startHub({ 'a.json': '{"same":1}', 'b.json': '{"same":1}' });
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      const a = await client.download({ repo: 'acme/bert' }, 'a.json');
      const b = await client.download({ repo: 'acme/bert' }, 'b.json');
      t.equal(a.sha256, b.sha256);
      t.equal(a.path, b.path, 'identical bytes are stored once');
      // A plain git blob advertises no content digest, so the second file's bytes
      // have to arrive before they can be recognized as a duplicate. Dedup happens
      // when the transfer is committed, not before it starts.
      t.equal(b.cached, false, 'the second name still transferred');
      t.equal(
        await client.cache.hasBlob(a.sha256),
        true,
        'and both names resolve to the one stored blob',
      );
    } finally {
      await hub.close();
    }
  });

  it('skips the transfer when the hub advertises a digest already stored', async (t) => {
    const hub = await startHub({ 'a.bin': 'identical', 'b.bin': 'identical' });
    hub.state.lfs.add('a.bin');
    hub.state.lfs.add('b.bin');
    try {
      const client = new HubClient({
        endpoint: hub.endpoint,
        ...scratch(),
        token: null,
        concurrency: 1,
      });
      const snapshot = await client.snapshot({ repo: 'acme/bert' });
      const [first, second] = snapshot.files;
      t.equal(first.sha256, second.sha256);
      t.equal(first.cached, false, 'the first file transferred');
      t.equal(
        second.cached,
        true,
        'the second was answered from the blob store on the advertised digest alone',
      );
      t.equal(hub.behavior.fileRequests, 1, 'only one body was fetched');
    } finally {
      await hub.close();
    }
  });

  it('records a manifest mapping paths to digests', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      await client.download({ repo: 'acme/bert' }, 'config.json');
      const manifest = await client.cache.readManifest('model', 'acme/bert', hub.state.commit);
      t.ok(manifest !== null, 'a manifest was written');
      t.equal(
        manifest!.files['config.json'].sha256,
        await sha256Hex(encoder.encode(FILES['config.json'])),
      );
      t.equal(manifest!.commit, hub.state.commit);
    } finally {
      await hub.close();
    }
  });

  it('loads file contents directly', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      t.equal(await client.loadText({ repo: 'acme/bert' }, 'config.json'), FILES['config.json']);
      const bytes = await client.load({ repo: 'acme/bert' }, 'config.json');
      t.equal(bytes.byteLength, FILES['config.json'].length);
    } finally {
      await hub.close();
    }
  });

  it('keeps dataset repositories in their own cache and URL space', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      const file = await client.download({ repo: 'acme/squad', type: 'dataset' }, 'config.json');
      t.equal(file.type, 'dataset');
      const manifest = await client.cache.readManifest('dataset', 'acme/squad', hub.state.commit);
      t.ok(manifest !== null, 'a dataset manifest is written under the dataset namespace');
      t.equal(
        await client.cache.readManifest('model', 'acme/squad', hub.state.commit),
        null,
        'the model namespace is untouched',
      );
      t.ok(
        client.fileUrl('dataset', 'acme/squad', 'abc', 'x').includes('/datasets/'),
        'dataset URLs carry the datasets prefix',
      );
    } finally {
      await hub.close();
    }
  });
});

describe('resumable transfer', () => {
  it('resumes from a partial file with a ranged request', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      // The first response body stops after 1000 of 4096 bytes; the retry must
      // ask for the rest rather than starting over.
      hub.behavior.truncateAfter = 1000;
      const file = await client.download({ repo: 'acme/bert' }, 'model.safetensors');
      t.equal(file.size, 4096, 'the whole file landed');
      t.equal(
        file.sha256,
        await sha256Hex(encoder.encode(FILES['model.safetensors'])),
        'the digest covers the resumed bytes as well as the new ones',
      );
      t.deepEqual(hub.behavior.rangeSeen, ['bytes=1000-'], 'the retry resumed at the cut point');
    } finally {
      await hub.close();
    }
  });

  it('starts over when the server ignores the range', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({
        endpoint: hub.endpoint,
        ...scratch(),
        token: null,
        attempts: 4,
      });
      hub.behavior.truncateAfter = 1000;
      hub.behavior.ignoreRange = true;
      const file = await client.download({ repo: 'acme/bert' }, 'model.safetensors');
      t.equal(file.size, 4096);
      t.equal(file.sha256, await sha256Hex(encoder.encode(FILES['model.safetensors'])));
      t.ok(hub.behavior.rangeSeen.length > 0, 'a range was attempted');
    } finally {
      await hub.close();
    }
  });

  it('starts over when the server rejects the range as unsatisfiable', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({
        endpoint: hub.endpoint,
        ...scratch(),
        token: null,
        attempts: 4,
      });
      hub.behavior.truncateAfter = 1000;
      hub.behavior.rejectRange = true;
      const file = await client.download({ repo: 'acme/bert' }, 'model.safetensors');
      t.equal(file.size, 4096);
      t.equal(file.sha256, await sha256Hex(encoder.encode(FILES['model.safetensors'])));
    } finally {
      await hub.close();
    }
  });

  it('retries a transient server failure', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({
        endpoint: hub.endpoint,
        ...scratch(),
        token: null,
        attempts: 3,
      });
      hub.behavior.failResolves = 2;
      const file = await client.download({ repo: 'acme/bert' }, 'config.json');
      t.equal(file.size, FILES['config.json'].length);
    } finally {
      await hub.close();
    }
  });

  it('gives up after the configured number of attempts', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({
        endpoint: hub.endpoint,
        ...scratch(),
        token: null,
        attempts: 2,
      });
      hub.behavior.failResolves = 5;
      await t.rejects(
        () => client.download({ repo: 'acme/bert' }, 'config.json'),
        /after 2 attempts/,
      );
    } finally {
      await hub.close();
    }
  });

  it('reports progress as bytes arrive', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      const seen: number[] = [];
      await client.download({ repo: 'acme/bert' }, 'model.safetensors', {
        onProgress: (progress) => {
          t.equal(progress.path, 'model.safetensors');
          seen.push(progress.transferred);
        },
      });
      t.ok(seen.length > 0, 'progress was reported');
      t.equal(seen[seen.length - 1], 4096, 'the last report is the full size');
    } finally {
      await hub.close();
    }
  });
});

describe('models.lock', () => {
  it('pins repo, commit, and digests', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const client = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await client.download({ repo: 'acme/bert' }, 'config.json');

      const lock = await readLockfile(paths.lockfile);
      t.equal(lock.version, 1);
      const entry = lock.entries['model:acme/bert@main'];
      t.ok(entry !== undefined, 'the revision is pinned under type:repo@revision');
      t.equal(entry.commit, hub.state.commit);
      t.equal(entry.revision, 'main');
      t.equal(
        entry.files['config.json'].sha256,
        await sha256Hex(encoder.encode(FILES['config.json'])),
      );
    } finally {
      await hub.close();
    }
  });

  it('resolves a pinned revision without asking the hub', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const first = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await first.download({ repo: 'acme/bert' }, 'config.json');

      // The hub moves `main` to a new commit. A pinned project must not follow it.
      hub.state.commit = 'c'.repeat(40);
      const second = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      const before = hub.behavior.apiRequests;
      const commit = await second.resolveRevision({ repo: 'acme/bert' });
      t.equal(commit, 'a'.repeat(40), 'resolution came from the lockfile');
      t.equal(hub.behavior.apiRequests, before, 'and cost no request');
    } finally {
      await hub.close();
    }
  });

  it('follows the hub again when asked to update the pin', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const client = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await client.download({ repo: 'acme/bert' }, 'config.json');
      hub.state.commit = 'c'.repeat(40);

      const moved = await client.download({ repo: 'acme/bert' }, 'config.json', { update: true });
      t.equal(moved.commit, 'c'.repeat(40), 'the new commit was resolved');
      const lock = await readLockfile(paths.lockfile);
      t.equal(lock.entries['model:acme/bert@main'].commit, 'c'.repeat(40), 'the pin moved');
    } finally {
      await hub.close();
    }
  });

  it('rejects bytes that disagree with the pinned digest', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const client = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await client.download({ repo: 'acme/bert' }, 'config.json');

      // Wipe the cache so the pinned file has to be fetched again, and have the
      // hub serve different bytes under the same commit.
      await removeTree(paths.cacheDir);
      hub.behavior.corrupt = true;
      const fresh = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await t.rejects(
        () => fresh.download({ repo: 'acme/bert' }, 'config.json'),
        /sha256 mismatch/i,
      );
    } finally {
      await hub.close();
    }
  });

  it('surfaces a digest mismatch as an IntegrityError', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const client = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await client.download({ repo: 'acme/bert' }, 'config.json');
      await removeTree(paths.cacheDir);
      hub.behavior.corrupt = true;
      const fresh = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      let caught: unknown = null;
      try {
        await fresh.download({ repo: 'acme/bert' }, 'config.json');
      } catch (error) {
        caught = error;
      }
      t.ok(caught instanceof IntegrityError, 'the error is typed');
      t.equal((caught as IntegrityError).name, 'IntegrityError');
      t.ok((caught as IntegrityError).expected.length === 64, 'it carries the expected digest');
    } finally {
      await hub.close();
    }
  });

  it('writes a byte-stable lockfile with sorted keys', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const client = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await client.snapshot({ repo: 'acme/bert' });
      const first = decoder.decode(await fs.readFile(paths.lockfile));

      const again = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await again.snapshot({ repo: 'acme/bert' });
      const second = decoder.decode(await fs.readFile(paths.lockfile));

      t.equal(second, first, 'a repeated snapshot rewrites the same bytes');
      const names = Object.keys(
        JSON.parse(first).entries['model:acme/bert@main'].files as Record<string, unknown>,
      );
      t.deepEqual(names, [...names].sort(), 'file keys are sorted');
      t.ok(first.endsWith('\n'), 'the file ends with a newline');
    } finally {
      await hub.close();
    }
  });

  it('runs unpinned when the lockfile is disabled', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({
        endpoint: hub.endpoint,
        cacheDir: scratch().cacheDir,
        lockfile: null,
        token: null,
      });
      await client.download({ repo: 'acme/bert' }, 'config.json');
      t.equal(client.lockfilePath, null);
      t.deepEqual((await client.lockfile()).entries, {}, 'nothing is pinned');
    } finally {
      await hub.close();
    }
  });

  it('refuses a lockfile from a newer format version', async (t) => {
    const paths = scratch();
    await writeRaw(paths.lockfile, JSON.stringify({ version: 99, entries: {} }));
    await t.rejects(() => readLockfile(paths.lockfile), /newer version/i);
  });

  it('refuses a lockfile that is not valid JSON', async (t) => {
    const paths = scratch();
    await writeRaw(paths.lockfile, '{not json');
    await t.rejects(() => readLockfile(paths.lockfile), /not valid JSON/i);
  });

  it('treats a missing lockfile as nothing pinned', async (t) => {
    const paths = scratch();
    const lock = await readLockfile(paths.lockfile);
    t.equal(lock.version, 1);
    t.deepEqual(lock.entries, {});
  });
});

describe('snapshot', () => {
  it('fetches a whole revision and pins it in one write', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const client = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      const snapshot = await client.snapshot({ repo: 'acme/bert' });
      t.equal(snapshot.files.length, 4);
      t.equal(snapshot.commit, hub.state.commit);
      const lock = await readLockfile(paths.lockfile);
      t.deepEqual(Object.keys(lock.entries['model:acme/bert@main'].files), [
        'README.md',
        'config.json',
        'model.safetensors',
        'tokenizer.json',
      ]);
    } finally {
      await hub.close();
    }
  });

  it('honors allow and ignore filters', async (t) => {
    const hub = await startHub(FILES);
    try {
      const client = new HubClient({ endpoint: hub.endpoint, ...scratch(), token: null });
      const allowed = await client.snapshot({ repo: 'acme/bert' }, { allow: ['.json'] });
      t.deepEqual(
        allowed.files.map((file) => file.name),
        ['config.json', 'tokenizer.json'],
      );

      const ignored = await client.snapshot(
        { repo: 'acme/bert' },
        { ignore: ['.safetensors', /^README/] },
      );
      t.deepEqual(
        ignored.files.map((file) => file.name),
        ['config.json', 'tokenizer.json'],
      );
    } finally {
      await hub.close();
    }
  });

  it('fetches concurrently without corrupting the lockfile', async (t) => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 12; i++) many[`shard-${i}.bin`] = `payload ${i} ${'y'.repeat(i * 64)}`;
    const hub = await startHub(many);
    try {
      const paths = scratch();
      const client = new HubClient({
        endpoint: hub.endpoint,
        ...paths,
        token: null,
        concurrency: 6,
      });
      const snapshot = await client.snapshot({ repo: 'acme/bert' });
      t.equal(snapshot.files.length, 12);
      const lock = await readLockfile(paths.lockfile);
      const files = lock.entries['model:acme/bert@main'].files;
      t.equal(Object.keys(files).length, 12, 'every shard is pinned');
      for (const [name, entry] of Object.entries(files)) {
        t.equal(
          entry.sha256,
          await sha256Hex(encoder.encode(many[name])),
          `${name} digest matches`,
        );
      }
    } finally {
      await hub.close();
    }
  });
});

describe('offline and verification', () => {
  it('serves a cached file offline and refuses an uncached one', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const online = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await online.download({ repo: 'acme/bert' }, 'config.json');
      await hub.close();

      const offline = new HubClient({
        endpoint: hub.endpoint,
        ...paths,
        token: null,
        offline: true,
      });
      const file = await offline.download({ repo: 'acme/bert' }, 'config.json');
      t.equal(file.cached, true, 'the pinned, cached file is served with no network');
      await t.rejects(
        () => offline.download({ repo: 'acme/bert' }, 'README.md'),
        /not cached and the client is offline/i,
      );
    } finally {
      await hub.close().catch(() => {});
    }
  });

  it('refuses to resolve an unpinned revision offline', async (t) => {
    const client = new HubClient({
      endpoint: 'http://127.0.0.1:1',
      ...scratch(),
      token: null,
      offline: true,
    });
    await t.rejects(
      () => client.resolveRevision({ repo: 'acme/bert' }),
      /not pinned or cached and the client is offline/i,
    );
  });

  it('re-hashes pinned blobs and reports corruption', async (t) => {
    const hub = await startHub(FILES);
    try {
      const paths = scratch();
      const client = new HubClient({ endpoint: hub.endpoint, ...paths, token: null });
      await client.snapshot({ repo: 'acme/bert' });

      const clean = await client.verify();
      t.equal(clean.ok.length, 4);
      t.deepEqual(clean.missing, []);
      t.deepEqual(clean.corrupt, []);

      // Edit a blob in place; the filename still claims the old digest.
      const config = await client.download({ repo: 'acme/bert' }, 'config.json');
      await fs.writeFile(config.path, encoder.encode('tampered'));
      const dirty = await client.verify();
      t.equal(dirty.corrupt.length, 1, 'the edited blob is reported');
      t.ok(dirty.corrupt[0].includes('config.json'));

      await fs.unlink(config.path);
      const gone = await client.verify();
      t.ok(
        gone.missing.some((label) => label.includes('config.json')),
        'a deleted blob is reported missing',
      );
    } finally {
      await hub.close();
    }
  });
});

describe('cache layout', () => {
  // This is the last group, so its teardown clears every scratch directory the
  // suite created.
  after(async () => {
    for (const dir of scratchDirs) await removeTree(dir);
  });

  it('derives every path from the repository, commit, and digest', async (t) => {
    const client = new HubClient({ cacheDir: '/tmp/fino-hub-layout', lockfile: null, token: null });
    const digest = 'f'.repeat(64);
    t.equal(
      client.cache.blobPath(digest),
      `/tmp/fino-hub-layout/blobs/sha256/ff/ff/${digest}`,
      'blobs fan out by digest prefix',
    );
    t.equal(
      client.cache.manifestPath('model', 'acme/bert', 'abc'),
      '/tmp/fino-hub-layout/manifests/models/acme--bert/abc.json',
      'the repository slug is a single path segment',
    );
    t.equal(
      client.cache.manifestPath('dataset', 'acme/bert', 'abc'),
      '/tmp/fino-hub-layout/manifests/datasets/acme--bert/abc.json',
      'types do not collide',
    );
    const partial = client.cache.partialPath('model', 'acme/bert', 'abc', 'a/b.bin');
    t.equal(
      partial,
      client.cache.partialPath('model', 'acme/bert', 'abc', 'a/b.bin'),
      'partial paths are stable, so a restarted process finds its own transfer',
    );
    t.ok(partial.endsWith('.partial'));
    t.equal(
      client.cache.partialPath('model', 'acme/bert', 'abc', 'a/b.bin') ===
        client.cache.partialPath('model', 'acme/bert', 'def', 'a/b.bin'),
      false,
      'a different commit is a different transfer',
    );
  });
});
