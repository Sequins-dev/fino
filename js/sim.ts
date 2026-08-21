/**
 * fino:sim - deterministic simulation containers.
 *
 * A simulation runs code in a realm whose entire contact with the outside world
 * is a set of facades you supply. Inside, the clock is virtual, every random
 * source is seeded, and timers fire in deadline order, so two runs of the same
 * simulation execute identically — the same values, the same interleaving, the
 * same sequence of calls out.
 *
 * That single property serves three purposes. It makes tests that involve time,
 * randomness, or I/O reproducible instead of flaky. It makes a failure
 * replayable from a recording rather than a story about what probably happened.
 * And because I/O crosses the facade boundary, the journal records every call
 * to the simulated world — which is what you want when the code is not yours.
 *
 * ```ts no_run
 * import { simulate } from 'fino:sim';
 *
 * const report = await simulate({
 *   entry: './worker.ts',
 *   seed: 42,
 *   world: {
 *     'app:kv': { get: async (key: unknown) => `value-for-${String(key)}` },
 *   },
 * });
 *
 * console.log(report.journal.calls('app:kv', 'get').length);
 * ```
 *
 * A guest that is granted nothing cannot reach the network even through ambient
 * globals such as `fetch`: simulated globals use only facades selected by the
 * realm's import map.
 */
import { DiskFileSystem } from 'fino:file';
import { MemoryFileSystem } from 'fino:file/memory';
import { Facade, ImportMap, Realm, type ImportRule } from 'fino:realm';
import { resolveSimConfig, type SimConfig } from 'internal:sim/config';
import { createSeededRandom } from 'internal:sim/random';
import { EnvelopeKind } from 'internal:realm/envelope';
import { digest } from 'internal:openssl';
import {
  SimJournal,
  decodeFrame,
  equalValue,
  isFacadeFrameKind,
  type Cassette,
  type CassetteFrame,
  type CassetteManifest,
  type SimCall,
  type SimCallKind,
} from 'internal:sim/journal';
export type { Cassette, SimCall, SimCallKind, SimConfig };
export { SimJournal };
/**
 * An implementation the guest reaches through a module specifier.
 *
 * Either a `Facade` you built yourself, or a plain object whose methods become
 * the facade's exports. Async generator methods become read streams.
 */
export type SimProvider = Facade | Record<string, unknown>;
/**
 * Something that supplies one or more of a simulation's world entries.
 *
 * `FakeFs` and `FakeNet` implement this. Spreading `world()` is what installs
 * them, and a mock is free to claim several specifiers at once — which is why
 * the method returns a map rather than a single provider.
 *
 * ```ts no_run
 * import { FakeFs, FakeNet, simulate } from 'fino:sim';
 *
 * const fs = new FakeFs({ '/etc/app.conf': 'debug=true' });
 * const net = new FakeNet({ 'https://api.example.com/v1': { body: '{}' } });
 *
 * await simulate({ entry: './worker.ts', world: { ...fs.world(), ...net.world() } });
 * ```
 */
export interface SimMock {
  /** The world entries this mock installs, by specifier. */
  world(): Record<string, SimProvider>;
}
/**
 * Options for `simulate()`.
 */
export interface SimulateOptions {
  /** Entry module for the guest realm. */
  entry: string;
  /** Seed for every random source. Equal seeds replay equally. Defaults to 0. */
  seed?: number | string;
  /** Wall-clock milliseconds the simulation starts at. */
  startTime?: number;
  /** Modules the guest may import, by specifier. */
  world?: Record<string, SimProvider>;
  /**
   * Real modules to let through untouched, by specifier.
   *
   * Use sparingly: anything granted here is outside the journal, and anything
   * that reaches real I/O is outside the simulation's determinism guarantee.
   */
  grant?: string[];
  /**
   * Extra import rules appended after the world's. Last match wins, so these
   * can override world entries.
   */
  overrides?: ImportRule[];
  /** Arguments passed to the entry module's default export. */
  args?: unknown[];
  /** Record to, or replay from, a cassette. */
  cassette?: SimCassetteOptions;
  /** Leave the clock real while keeping randomness seeded. Defaults to false. */
  realTime?: boolean;
  /** Make facade calls fail on a seeded schedule. */
  faults?: SimFaultOptions;
}
/**
 * Seeded failure injection.
 *
 * Failures are drawn from a generator seeded by the run's seed and consulted in
 * call order, so a given seed always fails the same calls. That is what makes a
 * failing run worth reporting: the seed alone reproduces it.
 */
export interface SimFaultOptions {
  /**
   * Probability in [0, 1] that any one facade call fails instead of running.
   */
  errorRate?: number;
  /**
   * Message for injected failures. Defaults to a description naming the call.
   */
  message?: string;
  /**
   * Specifiers to inject failures into. Defaults to every provider in `world`.
   */
  only?: string[];
  /**
   * Inclusive `[min, max]` range of virtual milliseconds to delay each facade
   * response by.
   *
   * The delay is applied inside the guest realm against its virtual clock, so a
   * simulated 500ms round trip costs nothing in real time — and because a
   * response can now land after a timer that was scheduled before it, this is
   * what exposes ordering bugs that instant replies hide.
   *
   * Drawn from a generator seeded separately from the guest's own randomness,
   * so adding latency does not shift the values the guest draws. Read-stream
   * chunks each draw their own delay, delivered in order. Ignored when
   * `realTime` is set.
   */
  latency?: [number, number];
}
/**
 * Cassette settings for a run.
 */
export interface SimCassetteOptions {
  /**
   * `record` captures every answer, `replay` serves them back and fails on any
   * divergence, and `auto` records when `data` is absent and replays when it is
   * present.
   */
  mode: 'record' | 'replay' | 'auto';
  /** A previously recorded cassette, for replay. */
  data?: Cassette;
}
/**
 * The outcome of a simulation run.
 */
export interface SimReport {
  /** Whatever the entry module's default export returned. */
  result: unknown;
  /** Every call the guest made across the facade boundary. */
  journal: SimJournal;
  /** The seed this run used, so a failure can be reproduced. */
  seed: number | string;
  /** The virtual instant the run started at. */
  startTime: number;
  /** The recording, when the run was recording one. */
  cassette?: Cassette;
}

function buildManifest(
  entry: string,
  rules: ImportRule[],
  config: ReturnType<typeof resolveSimConfig>,
): CassetteManifest {
  return {
    entry,
    imports: rules.map((rule) => ({
      ...(rule.from === undefined ? {} : { from: rule.from }),
      pattern: rule.pattern,
      directive:
        rule.directive instanceof Facade
          ? rule.directive.toDirective()
          : typeof rule.directive === 'string'
            ? { type: rule.directive }
            : rule.directive,
    })),
    seed: config.seed,
    startTime: config.startTime,
    virtualTime: config.virtualTime,
    latency: config.latency,
    runtime: navigator.userAgent,
    modules: [],
  };
}

async function hashModules(paths: readonly string[]): Promise<CassetteManifest['modules']> {
  const fs = new DiskFileSystem();
  return Promise.all(
    [...new Set(paths)].sort().map(async (path) => {
      try {
        return { path, sha256: hex(digest('sha-256', await fs.readFile(path))) };
      } catch {
        return { path };
      }
    }),
  );
}

function hex(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return value;
}
function facadeFromObject(specifier: string, provider: Record<string, unknown>): Facade {
  const scalars: Array<[string, (...args: unknown[]) => unknown]> = [];
  const streams: Array<[string, (...args: unknown[]) => AsyncIterable<unknown>]> = [];
  for (const [name, value] of Object.entries(provider)) {
    if (typeof value !== 'function') continue;
    if (isAsyncGenerator(value)) {
      streams.push([name, value as (...args: unknown[]) => AsyncIterable<unknown>]);
    } else {
      scalars.push([name, value as (...args: unknown[]) => unknown]);
    }
  }
  // Scalar export names come from the constructor — `handle()` registers an
  // implementation but does not declare the export, so the guest's import would
  // otherwise fail to link.
  const facade = new Facade(
    specifier,
    scalars.map(([name]) => name),
  );
  for (const [name, fn] of scalars) {
    facade.handle(name, async (...args: unknown[]) => fn(...args));
  }
  for (const [name, fn] of streams) facade.stream(name, fn);
  return facade;
}
function isAsyncGenerator(value: unknown): boolean {
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name === 'AsyncGeneratorFunction';
}
function beforeBind(
  facade: Facade,
  hook: (port: Parameters<Facade['_bind']>[0]) => unknown,
): Facade {
  const bind = facade._bind.bind(facade);
  const ports = new WeakSet<object>();
  facade._bind = (port) => {
    if (!ports.has(port)) {
      ports.add(port);
      hook(port);
    }
    bind(port);
  };
  return facade;
}
/**
 * One reply in a `FakeNet` route table.
 */
export interface FakeResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}
/**
 * A route handler: return a reply, or `undefined` to fall through.
 */
export type FakeRoute =
  | FakeResponse
  | ((request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: Uint8Array | null;
    }) => FakeResponse | undefined | Promise<FakeResponse | undefined>);
/**
 * An in-memory internet, served to the guest's ambient `fetch`.
 *
 * Routes are keyed by `METHOD url` or by url alone, which matches any method.
 * A request that matches nothing gets a 502, so a guest reaching somewhere the
 * simulation did not describe fails loudly instead of silently succeeding.
 *
 * ```ts no_run
 * import { FakeNet, simulate } from 'fino:sim';
 *
 * const net = new FakeNet({
 *   'https://api.example.com/health': { status: 200, body: '{"ok":true}' },
 * });
 *
 * await simulate({ entry: './worker.ts', world: { ...net.world() } });
 * ```
 */
export class FakeNet implements SimMock {
  /** Specifier a fetch provider must be installed at to serve ambient `fetch`. */
  static readonly specifier = 'fino:net/fetch';
  #routes: Map<string, FakeRoute>;
  constructor(routes: Record<string, FakeRoute> = {}) {
    this.#routes = new Map(Object.entries(routes));
  }
  /**
   * Add or replace a route.
   */
  route(pattern: string, handler: FakeRoute): this {
    this.#routes.set(pattern, handler);
    return this;
  }
  /**
   * The world entries this fake installs: a fetch provider at `FakeNet.specifier`.
   */
  world(): Record<string, SimProvider> {
    return { [FakeNet.specifier]: this.provider() };
  }
  /**
   * The provider object on its own, for installing at a different specifier.
   *
   * Prefer `world()`, which places it where ambient `fetch` looks for it.
   */
  provider(): Record<string, unknown> {
    const routes = this.#routes;
    return {
      handleRequest: async (request: unknown) => {
        const { method, url, headers, body } = request as {
          method: string;
          url: string;
          headers: Array<[string, string]>;
          body: Uint8Array | null;
        };
        const headerMap: Record<string, string> = {};
        for (const [name, value] of headers) headerMap[name] = value;
        const handler = routes.get(`${method} ${url}`) ?? routes.get(url);
        let reply: FakeResponse | undefined;
        if (typeof handler === 'function') {
          reply = await handler({ method, url, headers: headerMap, body });
        } else if (handler !== undefined) {
          reply = handler;
        }
        if (reply === undefined) {
          return {
            status: 502,
            statusText: 'No simulated route',
            headers: [['content-type', 'text/plain']],
            body: new TextEncoder().encode(`fino:sim — no route for ${method} ${url}`),
          };
        }
        return {
          status: reply.status ?? 200,
          statusText: reply.statusText ?? '',
          headers: Object.entries(reply.headers ?? {}),
          body:
            reply.body === undefined
              ? null
              : typeof reply.body === 'string'
                ? new TextEncoder().encode(reply.body)
                : reply.body,
        };
      },
    };
  }
}
/**
 * Child-side shape of the `fino:file` facade.
 *
 * The real value of a shape-aware facade is that this adapter travels in the
 * import rule; it is not another builtin module with its own provider lookup.
 * Existing file value types are reused, leaving only the genuinely remote
 * filesystem and buffered-handle behavior here.
 */
const FAKE_FILE_MODULE = String.raw`
import { FileSystem } from 'internal:file/provider';
import { Stat } from 'internal:file/stat';
import { Entry, FileEntry, DirEntry } from 'internal:file/entry';
import { Glob } from 'internal:file/glob';
import { call as callParent } from 'internal:parent-rpc';
import {
  F_OK, R_OK, W_OK, X_OK,
  O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFSOCK, S_IFIFO, S_IFBLK, S_IFCHR,
  SEEK_SET, SEEK_CUR, SEEK_END,
  DT_UNKNOWN, DT_FIFO, DT_CHR, DT_DIR, DT_BLK, DT_REG, DT_LNK, DT_SOCK,
} from 'internal:file/bindings';
export {
  FileSystem, Stat, Entry, FileEntry, DirEntry, Glob,
  F_OK, R_OK, W_OK, X_OK,
  O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFSOCK, S_IFIFO, S_IFBLK, S_IFCHR,
  SEEK_SET, SEEK_CUR, SEEK_END,
  DT_UNKNOWN, DT_FIFO, DT_CHR, DT_DIR, DT_BLK, DT_REG, DT_LNK, DT_SOCK,
};
const call = (method, args) => callParent(import.meta.url, method, args);
const pathOf = (path) => String(path);
function errno(code, detail) {
  return Object.assign(new Error(code + ': ' + detail), { code });
}
function rethrow(error, path) {
  const message = error instanceof Error ? error.message : String(error);
  const match = /:\s*(E[A-Z0-9]+)\s*$/.exec(message) || /\b(E[A-Z]+)\b/.exec(message);
  const wrapped = new Error(message.includes(path) ? message : message + ': ' + path);
  if (match) wrapped.code = match[1];
  throw wrapped;
}
function statOf(info) {
  const type = info.kind === 'dir' ? S_IFDIR : info.kind === 'link' ? S_IFLNK : S_IFREG;
  return new Stat(
    0, 0, type | (info.kind === 'dir' ? 0o755 : info.kind === 'link' ? 0o777 : 0o644),
    1, 0, 0, 0, info.size, 4096, Math.ceil(info.size / 512),
    info.mtimeMs, info.mtimeMs, info.mtimeMs, info.mtimeMs,
  );
}
function bytesOf(data) {
  return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
}
function concat(left, right) {
  const bytes = new Uint8Array(left.length + right.length);
  bytes.set(left);
  bytes.set(right, left.length);
  return bytes;
}
export class File {
  #path;
  #bytes;
  #writable;
  #dirty;
  #closed = false;
  constructor(path, bytes, writable, dirty = false) {
    this.#path = path;
    this.#bytes = bytes;
    this.#writable = writable;
    this.#dirty = dirty;
  }
  #open() {
    if (this.#closed) throw errno('EBADF', 'file is closed: ' + this.#path);
  }
  #writeable() {
    this.#open();
    if (!this.#writable) throw errno('EBADF', 'file is read-only: ' + this.#path);
  }
  async stat() {
    this.#open();
    const info = await call('stat', [this.#path]).catch((error) => rethrow(error, this.#path));
    return statOf({ ...info, kind: 'file', size: this.#bytes.length });
  }
  reader() {
    this.#open();
    const bytes = this.#bytes;
    return (async function* () { if (bytes.length > 0) yield bytes; })();
  }
  writer() {
    this.#writeable();
    return {
      write: (data) => {
        this.#writeable();
        this.#bytes = concat(this.#bytes, bytesOf(data));
        this.#dirty = true;
      },
      flush: () => this.sync(),
      close: async () => {},
    };
  }
  async bytes() { this.#open(); return this.#bytes; }
  async text() { return new TextDecoder().decode(await this.bytes()); }
  async pread(pos, len) { this.#open(); return this.#bytes.slice(Number(pos), Number(pos) + len); }
  async pwrite(pos, data) {
    this.#writeable();
    const start = Number(pos);
    const end = start + data.length;
    if (end > this.#bytes.length) {
      const grown = new Uint8Array(end);
      grown.set(this.#bytes);
      this.#bytes = grown;
    }
    this.#bytes.set(data, start);
    this.#dirty = true;
    return data.length;
  }
  async truncate(len) {
    this.#writeable();
    const size = Number(len);
    const resized = new Uint8Array(size);
    resized.set(this.#bytes.subarray(0, size));
    this.#bytes = resized;
    this.#dirty = true;
  }
  async size() { this.#open(); return BigInt(this.#bytes.length); }
  async sync() {
    this.#open();
    if (!this.#dirty) return;
    await call('writeFile', [this.#path, this.#bytes]).catch((error) => rethrow(error, this.#path));
    this.#dirty = false;
  }
  async close() {
    if (this.#closed) return;
    if (this.#dirty) await this.sync();
    this.#closed = true;
  }
}
export class DiskFileSystem extends FileSystem {
  async #stat(method, path) {
    const value = pathOf(path);
    const info = await call(method, [value]).catch((error) => rethrow(error, value));
    if (info === null) throw errno('ENOENT', 'no such file or directory: ' + value);
    return statOf(info);
  }
  stat(path) { return this.#stat('stat', path); }
  lstat(path) { return this.#stat('lstat', path); }
  async open(path, mode = 'r') {
    const value = pathOf(path);
    const exists = await call('exists', [value]).catch((error) => rethrow(error, value));
    if (mode.includes('x') && exists) throw errno('EEXIST', 'file exists: ' + value);
    if (!exists && mode.startsWith('r')) throw errno('ENOENT', 'no such file: ' + value);
    const writable = mode !== 'r';
    const truncate = mode.startsWith('w');
    if (!exists) await call('writeFile', [value, new Uint8Array()]).catch((e) => rethrow(e, value));
    const bytes = exists && !truncate
      ? await call('readFile', [value]).catch((error) => rethrow(error, value))
      : new Uint8Array();
    return new File(value, bytes, writable, truncate);
  }
  async readdir(path) {
    const value = pathOf(path);
    const listed = await call('readdir', [value]).catch((error) => rethrow(error, value));
    return listed.map(({ name, kind }) => {
      const child = value === '/' ? '/' + name : value + '/' + name;
      if (kind === 'dir') return new DirEntry(name, child, this, DT_DIR);
      if (kind === 'link') return new Entry(name, child, this, DT_LNK);
      return new FileEntry(name, child, this, DT_REG);
    });
  }
  async dir(path) {
    const value = pathOf(path);
    const stat = await this.stat(value);
    if (!stat.isDirectory()) throw errno('ENOTDIR', 'not a directory: ' + value);
    return new DirEntry(value === '/' ? '/' : value.slice(value.lastIndexOf('/') + 1), value, this, DT_DIR);
  }
  async entry(path) {
    const value = pathOf(path);
    const stat = await this.lstat(value);
    const name = value === '/' ? '/' : value.slice(value.lastIndexOf('/') + 1);
    if (stat.isDirectory()) return new DirEntry(name, value, this, DT_DIR);
    if (stat.isSymlink()) return new Entry(name, value, this, DT_LNK);
    return new FileEntry(name, value, this, DT_REG);
  }
  mkdir(path, mode) { return call('mkdir', [pathOf(path), mode]).then(() => undefined); }
  rmdir(path) { return call('rmdir', [pathOf(path)]).then(() => undefined); }
  unlink(path) { return call('unlink', [pathOf(path)]).then(() => undefined); }
  rename(from, to) { return call('rename', [pathOf(from), pathOf(to)]).then(() => undefined); }
  readlink(path) { return call('readlink', [pathOf(path)]); }
  symlink(target, link) { return call('symlink', [pathOf(target), pathOf(link)]).then(() => undefined); }
  realpath(path) { return call('realpath', [pathOf(path)]); }
  async access(path) {
    const value = pathOf(path);
    if (!await call('exists', [value])) throw errno('ENOENT', 'no such file: ' + value);
  }
  readFile(path) {
    const value = pathOf(path);
    return call('readFile', [value]).catch((error) => rethrow(error, value));
  }
  writeFile(path, data) {
    const value = pathOf(path);
    return call('writeFile', [value, bytesOf(data)]).then(() => undefined).catch((error) => rethrow(error, value));
  }
}
`;
/**
 * An in-memory filesystem the guest reaches through a facade.
 *
 * Storage is an ordinary `MemoryFileSystem` from `fino:file/memory`, which the
 * guest reaches across the facade boundary — so every operation is journaled
 * and replayable, and the parent can seed the tree before a run and assert on
 * it afterwards.
 *
 * Installed through `world()`, it transparently serves guests written against
 * `fino:file`: their `import { DiskFileSystem } from 'fino:file'` resolves to a
 * compatible facade module backed by this fake. Reach for `provider()` only
 * when composing import rules yourself.
 *
 * Timestamps count mutations rather than wall time, so equal seeds report
 * equal `mtimeMs` values run after run.
 *
 * ```ts no_run
 * import { FakeFs, simulate } from 'fino:sim';
 *
 * const fs = new FakeFs({ '/etc/config': 'debug=true' });
 * const report = await simulate({ entry: './worker.ts', world: { ...fs.world() } });
 * console.log(fs.snapshot(), report.journal.calls(FakeFs.specifier).length);
 * ```
 */
export class FakeFs implements SimMock {
  /** Specifier replaced by this facade. */
  static readonly specifier = 'fino:file';
  #tick = 0;
  #fs: MemoryFileSystem;
  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.#fs = new MemoryFileSystem({ files, now: () => ++this.#tick });
  }
  /**
   * The tree itself, for setup the constructor cannot express — symlinks,
   * permissions, or an empty directory.
   *
   * ```ts no_run
   * import { FakeFs } from 'fino:sim';
   *
   * const fs = new FakeFs({ '/real/a.txt': 'hi' });
   * await fs.filesystem.symlink('/real', '/link');
   * ```
   */
  get filesystem(): MemoryFileSystem {
    return this.#fs;
  }
  /**
   * Current contents, for asserting on what the guest wrote.
   */
  snapshot(): Record<string, string> {
    return this.#fs.snapshot();
  }
  /**
   * The world entry that installs this facade at `fino:file`.
   */
  world(): Record<string, SimProvider> {
    return { [FakeFs.specifier]: this.provider() };
  }
  /**
   * The shape-aware facade on its own.
   *
   * Prefer `world()`, which installs the facade at `fino:file`.
   */
  provider(): Facade {
    const fs = this.#fs;
    const bytesOf = (data: unknown): Uint8Array =>
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data as Uint8Array);
    const handlers = {
      readFile: async (path: unknown) => fs.readFile(String(path)),
      readTextFile: async (path: unknown) =>
        new TextDecoder().decode(await fs.readFile(String(path))),
      writeFile: async (path: unknown, contents: unknown) => {
        await fs.writeFile(String(path), bytesOf(contents));
        return null;
      },
      exists: async (path: unknown) => {
        try {
          await fs.stat(String(path));
          return true;
        } catch {
          return false;
        }
      },
      remove: async (path: unknown) => {
        try {
          await fs.unlink(String(path));
          return true;
        } catch {
          return false;
        }
      },
      list: async () => Object.keys(fs.snapshot()).sort(),
      // The guest shim treats a null stat as "not there", so a missing path is
      // an answer rather than a facade error it would have to decode.
      stat: async (path: unknown) => describe(() => fs.stat(String(path))),
      lstat: async (path: unknown) => describe(() => fs.lstat(String(path))),
      symlink: async (target: unknown, linkpath: unknown) => {
        await fs.symlink(String(target), String(linkpath));
        return null;
      },
      readlink: async (path: unknown) => fs.readlink(String(path)),
      readdir: async (path: unknown) =>
        (await fs.readdir(String(path))).map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : entry.isSymlink() ? 'link' : 'file',
        })),
      mkdir: async (path: unknown) => {
        await fs.mkdir(String(path));
        return null;
      },
      rmdir: async (path: unknown) => {
        await fs.rmdir(String(path));
        return null;
      },
      unlink: async (path: unknown) => {
        await fs.unlink(String(path));
        return null;
      },
      rename: async (oldPath: unknown, newPath: unknown) => {
        await fs.rename(String(oldPath), String(newPath));
        return null;
      },
      realpath: async (path: unknown) => fs.realpath(String(path)),
    };
    return Facade.from(handlers, { specifier: FakeFs.specifier }).module(FAKE_FILE_MODULE);
  }
}
/**
 * Reduce a `Stat` to the three fields that cross the facade, or `null` when the
 * path is not there.
 */
async function describe(
  read: () => Promise<{
    isDirectory(): boolean;
    isSymlink(): boolean;
    size: number;
    mtimeMs: number;
  }>,
): Promise<{ kind: 'file' | 'dir' | 'link'; size: number; mtimeMs: number } | null> {
  let info;
  try {
    info = await read();
  } catch {
    return null;
  }
  return {
    kind: info.isDirectory() ? 'dir' : info.isSymlink() ? 'link' : 'file',
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}
/**
 * Run `options.entry` as a deterministic simulation.
 *
 * The guest starts from a deny-all import map: it can reach the specifiers in
 * `world` and `grant`, and nothing else. Ambient I/O is replaced with the
 * simulation boundary before the guest entry loads.
 *
 * ```ts no_run
 * import { simulate } from 'fino:sim';
 *
 * const report = await simulate({ entry: './worker.ts', seed: 7 });
 * console.log(report.seed);
 * ```
 */
export async function simulate(options: SimulateOptions): Promise<SimReport> {
  const seed = options.seed ?? 0;
  const config = resolveSimConfig({
    seed,
    ...(options.startTime !== undefined ? { startTime: options.startTime } : {}),
    virtualTime: options.realTime !== true,
    ...(options.faults?.latency !== undefined ? { latency: options.faults.latency } : {}),
  });
  const world = options.world ?? {};
  const cassetteMode = options.cassette?.mode;
  const replaying =
    cassetteMode === 'replay' || (cassetteMode === 'auto' && options.cassette?.data !== undefined);
  const journal = new SimJournal();
  const replay = replaying ? new CassettePeer(options.cassette!.data!) : null;
  const rules: ImportRule[] = [
    // The loop is infrastructure: without it the realm cannot run its event loop.
    { pattern: 'internal:runtime/loop', directive: 'inherit' },
  ];
  for (const specifier of options.grant ?? []) {
    rules.push({ pattern: specifier, directive: 'inherit' });
  }
  // Faults are drawn parent-side from a generator seeded by the run seed and
  // consulted in call order, so the same seed fails the same calls.
  const faultRandom =
    options.faults?.errorRate !== undefined && !replaying
      ? createSeededRandom(`${String(config.seed)}:faults`)
      : null;
  for (const [specifier, provider] of Object.entries(world)) {
    const injectHere =
      faultRandom !== null &&
      (options.faults?.only === undefined || options.faults.only.includes(specifier));
    const facade =
      replay === null
        ? provider instanceof Facade
          ? provider
          : facadeFromObject(specifier, provider)
        : replayFacade(specifier, provider, replay);
    rules.push({
      pattern: specifier,
      directive: injectHere
        ? injectFaults(facade, specifier, faultRandom!, options.faults!)
        : facade,
    });
  }
  rules.push(...(options.overrides ?? []));
  const importMap = ImportMap.deny(rules);
  const manifest = buildManifest(options.entry, importMap.toRules(), config);
  if (replay !== null) replay.verifyManifest(manifest);
  const recording = cassetteMode === 'record' || (cassetteMode === 'auto' && !replaying);
  const realm = new Realm<(...args: unknown[]) => unknown>({
    entry: options.entry,
    overrides: importMap,
    observe: journal._observer(recording || replaying),
    sim: {
      seed: config.seed,
      startTime: config.startTime,
      virtualTime: config.virtualTime,
      ...(config.latency !== null ? { latency: config.latency } : {}),
    },
  });
  const result = await realm.call(...(options.args ?? []));
  manifest.modules = await hashModules(journal.modulePaths());
  replay?.verifyModules(manifest.modules);
  replay?.assertComplete();
  replay?.verifyFrames(journal.frames);
  const report: SimReport = {
    result,
    journal,
    seed: config.seed,
    startTime: config.startTime,
  };
  if (recording) report.cassette = journal.toCassette(manifest);
  return report;
}
/**
 * Serves recorded answers over a realm's ordinary RPC channel.
 */
class CassettePeer {
  #cassette: Cassette;
  #frames: CassetteFrame[];
  #position = 0;
  #ports = new WeakSet<object>();
  #correlations = new Map<number, { live: number; send(kind: number, value: unknown): void }>();
  #failure: Error | null = null;
  constructor(cassette: Cassette) {
    if (cassette.version !== 2 || !Array.isArray(cassette.frames)) {
      throw new Error('fino:sim — cassette version 2 is required');
    }
    this.#cassette = cassette;
    this.#frames = cassette.frames.filter((frame) => isFacadeFrameKind(frame.kind));
  }

  /** Verify deterministic inputs before starting the guest. */
  verifyManifest(manifest: CassetteManifest): void {
    if (!equalValue({ ...this.#cassette.manifest, modules: [] }, { ...manifest, modules: [] })) {
      throw new Error('fino:sim — cassette manifest differs from this simulation');
    }
  }

  /** Verify the module graph after the guest has loaded it. */
  verifyModules(modules: CassetteManifest['modules']): void {
    if (!equalValue(this.#cassette.manifest.modules, modules)) {
      throw new Error('fino:sim — loaded module graph differs from the cassette');
    }
  }

  /** Compare every regenerated boundary frame, including diagnostics and lifecycle. */
  verifyFrames(frames: readonly CassetteFrame[]): void {
    if (frames.length !== this.#cassette.frames.length) {
      throw new Error(
        `fino:sim — session frame count differs from the cassette (${frames.length} != ${this.#cassette.frames.length})`,
      );
    }
    for (let index = 0; index < frames.length; index++) {
      const actual = frames[index]!;
      const expected = this.#cassette.frames[index]!;
      if (
        actual.direction !== expected.direction ||
        actual.kind !== expected.kind ||
        actual.correlation !== expected.correlation ||
        !equalValue(decodeFrame(actual), decodeFrame(expected))
      ) {
        throw new Error(`fino:sim — session traffic differs at frame ${index}`);
      }
    }
  }

  /** Install one replay dispatcher before the port's live Facade dispatcher. */
  bind(port: {
    _addControlHandler?(
      handler: (envelope: { kind: number; correlation: number }, value: unknown) => boolean,
    ): () => void;
    _postControl?(kind: number, correlation: number, value: unknown): void;
  }): void {
    if (this.#ports.has(port)) return;
    if (typeof port._addControlHandler !== 'function' || typeof port._postControl !== 'function') {
      throw new TypeError('Cassette replay requires a session-backed realm port');
    }
    this.#ports.add(port);
    port._addControlHandler((envelope, value) => {
      if (!isFacadeFrameKind(envelope.kind)) return false;
      try {
        this.#acceptInbound(envelope.kind, envelope.correlation, value, (kind, payload) =>
          port._postControl!(kind, envelope.correlation, payload),
        );
      } catch (error) {
        this.#failure = error instanceof Error ? error : new Error(String(error));
        port._postControl!(
          envelope.kind === EnvelopeKind.RpcStreamRequest
            ? EnvelopeKind.RpcError
            : EnvelopeKind.RpcResponse,
          envelope.correlation,
          { error: this.#failure.message },
        );
      }
      return true;
    });
  }

  /** Fail when the guest returned without making every recorded call. */
  assertComplete(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#position === this.#frames.length) return;
    const frame = this.#frames[this.#position]!;
    const value = decodeFrame(frame) as { specifier?: unknown; method?: unknown };
    throw new Error(
      `fino:sim — divergence after frame ${this.#position}: the guest did not send ${String(value?.specifier ?? 'recorded traffic')}.${String(value?.method ?? '')}`,
    );
  }

  #acceptInbound(
    kind: number,
    correlation: number,
    value: unknown,
    send: (kind: number, value: unknown) => void,
  ): void {
    const frame = this.#frames[this.#position];
    if (frame === undefined) {
      throw new Error(`fino:sim — cassette ended after ${this.#position} facade frames`);
    }
    if (frame.direction !== 'inbound' || frame.kind !== kind) {
      throw new Error(
        `fino:sim — divergence at frame ${this.#position}: expected kind ${frame.kind} ${frame.direction}, received kind ${kind} inbound`,
      );
    }
    const expected = decodeFrame(frame);
    if (!equalValue(expected, value)) {
      const request = (value ?? {}) as { specifier?: unknown; method?: unknown };
      throw new Error(
        `fino:sim — arguments to ${String(request.specifier ?? 'facade')}.${String(request.method ?? 'frame')} differ from the cassette`,
      );
    }
    const existing = this.#correlations.get(frame.correlation);
    if (existing !== undefined && existing.live !== correlation) {
      throw new Error(`fino:sim — correlation diverged at frame ${this.#position}`);
    }
    if (existing === undefined)
      this.#correlations.set(frame.correlation, { live: correlation, send });
    this.#position++;
    this.#drainOutbound();
  }

  #drainOutbound(): void {
    while (this.#position < this.#frames.length) {
      const frame = this.#frames[this.#position]!;
      if (frame.direction !== 'outbound') return;
      const target = this.#correlations.get(frame.correlation);
      if (target === undefined) {
        throw new Error(
          `fino:sim — cassette response at frame ${this.#position} has no matching request`,
        );
      }
      target.send(frame.kind, decodeFrame(frame));
      this.#position++;
      if (
        frame.kind === EnvelopeKind.RpcResponse ||
        frame.kind === EnvelopeKind.RpcEnd ||
        frame.kind === EnvelopeKind.RpcError
      ) {
        this.#correlations.delete(frame.correlation);
      }
    }
  }
}
function replayFacade(specifier: string, provider: SimProvider, replay: CassettePeer): Facade {
  const shape = provider instanceof Facade ? provider : facadeFromObject(specifier, provider);
  return beforeBind(shape, (port) => replay.bind(port));
}
/**
 * Wrap a facade so a seeded share of its calls fail before reaching the handler.
 *
 * Recording observes the resulting channel frames, so injected failures are
 * journaled exactly as the guest receives them.
 */
function injectFaults(
  facade: Facade,
  specifier: string,
  random: ReturnType<typeof createSeededRandom>,
  faults: SimFaultOptions,
): Facade {
  const rate = faults.errorRate ?? 0;
  return beforeBind(facade, (port) => {
    const channel = port as unknown as {
      _addControlHandler?(
        handler: (envelope: { kind: number; correlation: number }, value: unknown) => boolean,
      ): () => void;
      _postControl?(kind: number, correlation: number, value: unknown): void;
    };
    channel._addControlHandler?.((envelope, value) => {
      if (
        envelope.kind !== EnvelopeKind.RpcRequest &&
        envelope.kind !== EnvelopeKind.RpcStreamRequest &&
        envelope.kind !== EnvelopeKind.SinkStart
      ) {
        return false;
      }
      const request = (value ?? {}) as { specifier?: unknown; method?: unknown };
      if (request.specifier !== specifier || random.nextFloat() >= rate) return false;
      const error =
        faults.message ?? `fino:sim — injected fault in ${specifier}.${String(request.method)}`;
      channel._postControl?.(
        envelope.kind === EnvelopeKind.RpcStreamRequest
          ? EnvelopeKind.RpcError
          : EnvelopeKind.RpcResponse,
        envelope.correlation,
        { error },
      );
      return true;
    });
  });
}
/**
 * One seed's outcome in a sweep.
 */
export interface SweepOutcome {
  seed: number | string;
  /** The report, when the run completed. */
  report?: SimReport;
  /** The failure, when it did not. */
  error?: unknown;
}
/**
 * Run the same simulation across many seeds and collect what happened.
 *
 * Where one run answers "does this work", a sweep answers "for which schedules
 * does this work" — the question that actually matters for concurrent code. A
 * failing seed is a complete reproduction: pass it back to `simulate()` to get
 * the same failure again.
 *
 * Runs are sequential so that a failure's seed is the only thing needed to
 * reproduce it, with no dependence on how many ran alongside it.
 *
 * ```ts no_run
 * import { sweep } from 'fino:sim';
 *
 * const outcomes = await sweep({ entry: './worker.ts' }, 50);
 * const failed = outcomes.filter((outcome) => outcome.error !== undefined);
 * console.log(failed.map((outcome) => outcome.seed));
 * ```
 */
export async function sweep(
  options: Omit<SimulateOptions, 'seed'>,
  seeds: number | Array<number | string>,
): Promise<SweepOutcome[]> {
  const list = typeof seeds === 'number' ? Array.from({ length: seeds }, (_, i) => i) : seeds;
  const outcomes: SweepOutcome[] = [];
  for (const seed of list) {
    try {
      outcomes.push({ seed, report: await simulate({ ...options, seed }) });
    } catch (error) {
      outcomes.push({ seed, error });
    }
  }
  return outcomes;
}
