/**
* Integration tests for `fino doc`.
*/
import { after, before, describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { chdir, cwd, execPath, Process } from 'fino:process';
import { Database, sqliteAvailable } from 'fino:database/sqlite';
import rootCommand from 'internal:commands/root';
const TEST_DIR = '/tmp/fino-doc-test-' + Math.floor(Math.random() * 1e6);
const REPO_DIR = cwd();
interface DocJsonMember {
  name: string;
  id?: string;
  kind?: string;
  signatures?: string[];
  doc?: {
    text: string;
    blocks?: Array<{
      kind: string;
      [key: string]: unknown;
    }>;
  };
  reExport?: {
    mode: string;
    sourceModule: string;
    sourceName: string;
    sourceId?: string;
  };
}
interface DocJsonExport extends DocJsonMember {
  signature?: string;
  members: DocJsonMember[];
}
interface DocJsonModule {
  name: string;
  id?: string;
  sourceModule?: string;
  doc: {
    text: string;
    blocks?: Array<{
      kind: string;
      [key: string]: unknown;
    }>;
  };
  exports: DocJsonExport[];
}
interface DocJsonGuide {
  title: string;
  path: string;
  href: string;
  summary: string;
  text: string;
  weight?: number;
}
interface DocJsonOutput {
  modules: DocJsonModule[];
  guides?: DocJsonGuide[];
}
function decodeUtf8(b: ArrayBuffer | ArrayBufferView): string {
  return new TextDecoder().decode(b);
}
async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  return decodeUtf8(chunks.reduce((acc: Uint8Array, c: Uint8Array) => {
    const merged = new Uint8Array(acc.byteLength + c.byteLength);
    merged.set(acc);
    merged.set(c, acc.byteLength);
    return merged;
  }, new Uint8Array(0)));
}
async function exists(fs: DiskFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (_) {
    return false;
  }
}
async function ensureDir(fs: DiskFileSystem, path: string): Promise<void> {
  if (path === '.' || path === '/' || path.length === 0) return;
  if (await exists(fs, path)) return;
  const idx = path.lastIndexOf('/');
  const parent = idx <= 0 ? '.' : path.slice(0, idx);
  await ensureDir(fs, parent);
  await fs.mkdir(path);
}
async function removeTree(fs: DiskFileSystem, path: string): Promise<void> {
  if (!await exists(fs, path)) return;
  const entry = await fs.entry(path);
  if (entry.isDirectory()) {
    const dir = await fs.dir(path);
    for (const child of await dir.entries()) await removeTree(fs, child.path.toString());
    await fs.rmdir(path);
    return;
  }
  await fs.unlink(path);
}
async function runCli(args: string[], nextCwd: string): Promise<{
  stdout: string;
  stderr: string;
  result: {
    code: number;
    signal: number | null;
  };
}> {
  const previousCwd = cwd();
  try {
    chdir(nextCwd);
    const result = await rootCommand.parse(args);
    return {
      stdout: typeof result === 'string' ? result : '',
      stderr: '',
      result: {
        code: 0,
        signal: null
      }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: message + '\n',
      result: {
        code: 1,
        signal: null
      }
    };
  } finally {
    chdir(previousCwd);
  }
}
async function runCliProcess(args: string[], cwd: string): Promise<{
  stdout: string;
  stderr: string;
  result: Awaited<ReturnType<Process['wait']>>;
}> {
  const proc = new Process(execPath, args, { cwd });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait()
  ]);
  return {
    stdout,
    stderr,
    result
  };
}
describe('fino doc', () => {
  let fs: DiskFileSystem;
  let appDir: string;
  before(async () => {
    fs = new DiskFileSystem();
    const rawReadFile = fs.readFile.bind(fs);
    const rawWriteFile = fs.writeFile.bind(fs);
    fs.readFile = (async (path: string) => new TextDecoder().decode(await rawReadFile(path))) as never;
    fs.writeFile = (async (path: string, data: string | Uint8Array | ArrayBuffer | ArrayBufferView) => {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      await rawWriteFile(path, bytes);
    }) as never;
    await ensureDir(fs, TEST_DIR);
    appDir = TEST_DIR + '/app';
    await ensureDir(fs, appDir);
    await fs.writeFile(appDir + '/README.md', `# Fixture API

This README becomes the documentation home page.

![Fixture logo](./logo.svg)

[Project guide](./guides/start.md)

- It should render Markdown lists.
- It should leave the module index to the sidebar.
`);
    await fs.writeFile(appDir + '/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Fixture logo</title></svg>\n');
    await fs.writeFile(appDir + '/package.json', JSON.stringify({
      name: 'fixture-project',
      version: '1.0.0'
    }, null, 2) + '\n');
    await ensureDir(fs, appDir + '/guides');
    await fs.writeFile(appDir + '/guides/start.md', `---
weight: 10
---
# Getting Started

Start with the [advanced guide](./advanced.md), then open the [advanced API](../advanced.ts#open).

This guide explains first steps for fixture users.

## Usage

\`\`\`ts
import { open } from '../advanced.ts';

const value = open('primary');
\`\`\`
`);
    await fs.writeFile(appDir + '/guides/advanced.md', `---
weight: 20
---
# Advanced Guide

Advanced workflows use [ResourceBox](../advanced.ts#ResourceBox) and return to [getting started](./start.md).

Use this guide when examples need more intent than API references.
`);
    await fs.writeFile(appDir + '/guides/virtual.md', `---
path: docs/concepts/virtual.md
weight: 15
---
# Virtual Guide

This guide keeps its source file in guides but appears under docs concepts.
`);
    await fs.writeFile(appDir + '/api.ts', `/**
 * Example API module.
 *
 * This module demonstrates generated API docs.
 */

/**
 * Add two numbers together.
 */
export function add(a: number, b: number): number {
  return a + b;
}

/**
 * Build a runtime configuration object.
 */
export function buildRuntimeConfig(options: { name: string; file?: { path: string; format?: 'json' | 'toml' }; env?: { prefix: string; required?: boolean }; defaults?: Record<string, string | number | boolean> }, overrides?: { debug?: boolean; tags?: string[] }): Promise<{ ok: boolean; source: ConfigSource }> {
  return Promise.resolve({ ok: true, source: { inline: { name: options.name, enabled: true } } });
}

/**
 * Response shape returned by the service.
 */
export interface ApiResponse<T> {
  /**
   * Indicates whether the request succeeded.
   */
  ok: boolean;

  /**
   * Parsed payload when available.
   */
  data?: T;

  /**
   * Internal response trace ID.
   *
   * @internal
   */
  traceId?: string;
}

/**
 * Class with both public and private state.
 */
export class SecretBox {
  /**
   * Publicly visible identifier.
   */
  id: string;

  /**
   * Private token should stay out of docs.
   */
  #token: string;

  constructor(id: string, token: string) {
    this.id = id;
    this.#token = token;
  }

  /**
   * Return the public identifier.
   */
  value(): string {
    return this.id;
  }

  /**
   * Internal debug helper should stay out of default docs.
   *
   * @internal
   */
  debugToken(): string {
    return this.#token;
  }

  /**
   * Private helper should stay out of docs.
   */
  #peek(): string {
    return this.#token;
  }
}

/**
 * Current API version string.
 */
export const VERSION: string = '1.0.0';

/**
 * Configuration source accepted by the runtime.
 */
export type ConfigSource =
  | {
      inline?: {
        name: string;
        /* internal marker */
        enabled: boolean;
        tags?: string[];
      };
    }
  | {
      file?: {
        path: string;
        format: 'json' | 'yaml' | 'toml';
        watch?: boolean;
      };
    }
  | {
      env?: {
        prefix: string;
        required?: boolean;
      };
    };
`);
    await fs.writeFile(appDir + '/advanced.ts', `/**
 * Advanced module docs.
 *
 * Use **advanced** resources with the \`ResourceBox\` helper.
 * Read the [advanced guide](./guides/advanced.md).
 *
 * # Overview
 *
 * See [ResourceBox][box], [the name getter](#ResourceBox.name), and https://example.test/docs.
 * [box]: ./advanced.ts#ResourceBox
 */

/**
 * Open a named resource.
 *
 * Supports [resource names](https://example.test/resources) and **flags**.
 *
 * # Usage
 *
 * \`\`\`ts
 * const value = open("primary");
 * if (value !== "resource:primary") {
 *   throw new Error(value);
 * }
 * \`\`\`
 */
export function open(name: string): string;
export function open(name: string, flags: number): string;
export function open(name: string, flags?: number): string {
  return flags === undefined ? 'resource:' + name : 'resource:' + name + ':' + flags;
}

/**
 * Resource container.
 */
export class ResourceBox {
  /**
   * Create a box.
   */
  constructor(readonly id: string) {}

  /**
   * Resource display name.
   *
   * # Details
   */
  get name(): string {
    return this.id;
  }

  /**
   * Resource display name.
   */
  set name(value: string) {
    this.id = value;
  }

  /**
   * Create a box from a name.
   */
  static from(name: string): ResourceBox {
    return new ResourceBox(name);
  }

  /**
   * Shut down the box.
   */
  close(): void {}

  /**
   * Internal debug trace should stay out of default docs.
   *
   * @internal
   */
  trace(): string {
    return this.id;
  }

  /**
   * Hidden implementation detail.
   */
  private internalOnly(): void {}
}

/**
 * Convert a timestamp into a date.
 */
export function fromDate(value: Date): Date {
  return value;
}

/**
 * Return a binary view unchanged.
 */
export function passthroughView(value: ArrayBufferView): ArrayBufferView {
  return value;
}

/**
 * Return iterable values as an array.
 */
export function collectValues(values: Iterable<string>): string[] {
  return Array.from(values);
}

/**
 * Return the passed async iterator unchanged.
 */
export function keepAsyncIterator(values: AsyncIterator<string>): AsyncIterator<string> {
  return values;
}

/**
 * Return the passed iterator result unchanged.
 */
export function keepIteratorResult(value: IteratorResult<string>): IteratorResult<string> {
  return value;
}

/**
 * Return a partial resource value unchanged.
 */
export function patchResource(value: Partial<ResourceBox>): Partial<ResourceBox> {
  return value;
}
`);
    await fs.writeFile(appDir + '/private-stubs.ts', `/**
 * Public module that includes implementation-detail comments.
 */
export class PublicBox {
  /**
   * Public value.
   */
  value = 'public';

  /**
   * #secret private field on PublicBox.
   *
   * Stores internal runtime state only. Callers should not depend on this private slot.
   */
  #secret = 'hidden';

  /**
   * #peek private method on PublicBox.
   *
   * Stores internal runtime state only. Callers should not depend on this private slot.
   */
  #peek(): string {
    return this.#secret;
  }
}
`);
    await fs.writeFile(appDir + '/examples.ts', `/**
 * Example helper.
 *
 * \`\`\`ts
 * # const hidden = 41;
 * if (hidden + 1 !== 42) throw new Error('bad math');
 * \`\`\`
 *
 * \`\`\`ts
 * import { helper } from './examples.ts';
 *
 * if (helper() !== 42) throw new Error('bad helper');
 * \`\`\`
 *
 * \`\`\`ts ignore
 * throw new Error('ignored');
 * \`\`\`
 *
 * \`\`\`ts throws
 * throw new Error('expected');
 * \`\`\`
 *
 * \`\`\`ts throws
 * import { helper } from './examples.ts';
 *
 * if (helper() !== 42) throw new Error('bad helper');
 * throw new Error('expected static import failure');
 * \`\`\`
 */
export function helper(): number {
  return 42;
}
`);
    await ensureDir(fs, appDir + '/pkg');
    await fs.writeFile(appDir + '/pkg/index.ts', `/**
 * Package index docs.
 */

/**
 * Package entrypoint value.
 */
export const pkgName: string = 'pkg';
`);
    await ensureDir(fs, appDir + '/alpha');
    await ensureDir(fs, appDir + '/beta');
    await fs.writeFile(appDir + '/alpha/client.ts', `/**
 * Alpha client docs.
 */
export interface Client {
  /**
   * Alpha client name.
   */
  name: string;
}
`);
    await fs.writeFile(appDir + '/alpha/guide.md', `# Alpha Guide

Use this guide before opening the [client API](./client.ts#Client).
`);
    await fs.writeFile(appDir + '/beta/client.ts', `/**
 * Beta client docs.
 *
 * See [AlphaClient](../alpha/client.ts#Client).
 */
export interface Client {
  /**
   * Beta client identifier.
   */
  id: string;
}
`);
    await fs.writeFile(appDir + '/internal-only.ts', `/**
 * Internal-only module docs.
 *
 * @internal
 */
export function hiddenApi(): string {
  return 'hidden';
}
`);
    await fs.writeFile(appDir + '/hidden-source.ts', `/**
 * Hidden re-export source.
 *
 * @internal
 */

/**
 * Hidden class docs copied into public facades.
 */
export class HiddenThing {
  /**
   * Hidden value docs copied with the class.
   */
  value(): string {
    return 'hidden';
  }
}

/**
 * Hidden options docs copied into public facades.
 */
export interface HiddenOptions {
  /**
   * Hidden option flag.
   */
  enabled: boolean;
}

/**
 * Internal-only symbol should not leak through star exports.
 *
 * @internal
 */
export function privateHelper(): string {
  return 'private';
}
`);
    await fs.writeFile(appDir + '/public-source.ts', `/**
 * Public re-export source.
 */

/**
 * Public target docs stay canonical in the source module.
 */
export function publicTarget(input: string): string {
  return input;
}
`);
    await fs.writeFile(appDir + '/hidden-star.ts', `/**
 * Hidden star source.
 *
 * @internal
 */

/**
 * Hidden star docs copied into public facades.
 */
export interface StarThing {
  /**
   * Star value docs.
   */
  value: string;
}

/**
 * Internal star helper should not leak.
 *
 * @internal
 */
export function privateStar(): string {
  return 'private';
}
`);
    await fs.writeFile(appDir + '/public-star.ts', `/**
 * Public star source.
 */

/**
 * Public star docs stay canonical in the source module.
 */
export interface PublicStar {
  /**
   * Public star id.
   */
  id: string;
}
`);
    await fs.writeFile(appDir + '/facade.ts', `/**
 * Public facade docs.
 */

export { HiddenThing as PublicThing, type HiddenOptions } from './hidden-source.ts';
export { publicTarget as linkedTarget } from './public-source.ts';
export * from './hidden-star.ts';
export * from './public-star.ts';
`);
    await fs.writeFile(appDir + '/surface.ts', `/**
 * Public surface module.
 *
 * Available calls:
 *
 * - surface.run(input)
 * - surface.nested.ping(name)
 */

const nested = {
  /**
   * Ping a named target.
   */
  ping(name: string): string {
    return 'pong:' + name;
  },

  /**
   * Nested readiness flag.
   */
  ready: true,
};

function localHelper(): string {
  return 'hidden';
}

export const surface = {
  /**
   * Run with a string input.
   */
  run(input: string): string {
    return localHelper() + ':' + input;
  },

  /**
   * Configure the surface.
   */
  configure(options: { enabled: boolean }): { enabled: boolean } {
    return options;
  },

  /**
   * Current surface version.
   */
  version: '1.0.0',

  nested,
};

/**
 * Available modes.
 */
export enum Mode {
  Fast = 'fast',
  /**
   * Internal enum member docs should not be copied into the signature.
   */
  Safe = 'safe',
  Balanced = 'balanced',
  Thorough = 'thorough',
  Experimental = 'experimental',
}

/**
 * Utility exported after an enum.
 */
export function afterEnum(): string {
  return Mode.Fast;
}
`);
  });
  after(async () => {
    await removeTree(fs, TEST_DIR);
  });
  it('writes markdown and json docs for exported declarations', async (t) => {
    const outDir = appDir + '/docs';
    const jsonPath = outDir + '/api.json';
    await removeTree(fs, outDir);
    const run = await runCli(['doc', './api.ts'], appDir);
    t.equal(run.result.code, 0, 'doc exits successfully');
    t.equal(run.stderr, '', 'doc writes no stderr');
    t.ok(run.stdout.includes('Wrote'), 'doc reports generated files');
    const markdown = await fs.readFile(outDir + '/api.md');
    t.ok(markdown.includes('# api'), 'markdown includes module heading');
    t.ok(markdown.includes('Example API module.'), 'markdown includes module prelude');
    t.ok(markdown.includes('## add'), 'markdown includes function section');
    t.ok(markdown.includes('```ts\nfunction add(a: number, b: number): number\n```'), 'markdown includes typed function signature without export prefix');
    t.ok(!markdown.includes('```ts\nexport '), 'markdown omits redundant export prefixes');
    t.ok(!markdown.includes('@param'), 'markdown omits directive tags');
    t.ok(!markdown.includes('@returns'), 'markdown omits return directive tags');
    t.ok(markdown.includes('## ApiResponse'), 'markdown includes interface section');
    t.ok(markdown.includes('### ok'), 'markdown includes interface member section');
    t.ok(markdown.includes('```ts\nok: boolean\n```'), 'markdown includes member signature');
    t.ok(!markdown.includes('traceId'), 'markdown excludes @internal interface member by default');
    t.ok(markdown.includes('## SecretBox'), 'markdown includes class section');
    t.ok(markdown.includes('### id'), 'markdown includes public class property');
    t.ok(markdown.includes('### value'), 'markdown includes public class method');
    t.ok(!markdown.includes('debugToken'), 'markdown excludes @internal class member by default');
    t.ok(!markdown.includes('### #token'), 'markdown excludes private class property');
    t.ok(!markdown.includes('### #peek'), 'markdown excludes private class method');
    t.ok(markdown.includes('## VERSION'), 'markdown includes const section');
    t.ok(markdown.includes('## ConfigSource'), 'markdown includes long type alias section');
    t.ok(markdown.includes('type ConfigSource = {\n'), 'markdown formats long type alias across lines');
    t.ok(markdown.includes('format: \'json\' | \'yaml\' | \'toml\';'), 'markdown preserves nested literal union in formatted signature');
    t.equal(markdown.includes('internal marker'), false, 'markdown strips comments from formatted signatures');
    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const firstModule = json.modules[0]!;
    const firstExport = firstModule.exports[0]!;
    t.equal(json.modules.length, 1, 'json includes one module');
    t.equal(firstModule.name, 'api', 'json records module name');
    t.equal(firstModule.doc.text.includes('Example API module.'), true, 'json records module prelude');
    t.equal(firstModule.exports.length, 6, 'json includes exported declarations');
    t.equal(firstExport.name, 'add', 'json records function export');
    t.equal(firstExport.signature, 'function add(a: number, b: number): number', 'json records function signature without export prefix');
    const buildRuntimeConfig = firstModule.exports.find((item: DocJsonExport) => item.name === 'buildRuntimeConfig');
    t.ok(buildRuntimeConfig, 'json includes long function export');
    t.ok(buildRuntimeConfig!.signature.includes('\n'), 'json records formatted multiline function signature');
    const configSource = firstModule.exports.find((item: DocJsonExport) => item.name === 'ConfigSource');
    t.ok(configSource, 'json includes type alias export');
    t.ok(configSource!.signature.includes('\n'), 'json records formatted multiline type signature');
    t.equal(configSource!.signature.includes('internal marker'), false, 'json strips comments from formatted signatures');
    const secretBox = firstModule.exports.find((item: DocJsonExport) => item.name === 'SecretBox');
    t.ok(secretBox, 'json includes class export');
    const response = firstModule.exports.find((item: DocJsonExport) => item.name === 'ApiResponse');
    t.ok(response, 'json includes interface export');
    t.equal(response!.members.some((item: DocJsonMember) => item.name === 'traceId'), false, 'json excludes @internal interface member');
    t.equal(secretBox!.members.some((item: DocJsonMember) => item.name === 'debugToken'), false, 'json excludes @internal class member');
    t.equal(secretBox!.members.some((item: DocJsonMember) => item.name === '#token'), false, 'json excludes private class property');
    t.equal(secretBox!.members.some((item: DocJsonMember) => item.name === '#peek'), false, 'json excludes private class method');
  });
  it('does not load stale cache json for unrelated inputs', async (t) => {
    if (!sqliteAvailable) {
      t.ok(true, 'skipped: sqlite unavailable');
      return;
    }
    const staleDir = appDir + '/stale-cache';
    const docsDir = staleDir + '/docs';
    await removeTree(fs, staleDir);
    await ensureDir(fs, docsDir);
    await fs.writeFile(staleDir + '/current.ts', `/**
 * Current module.
 */
export function current(): number {
  return 1;
}
`);
    const db = await Database.open(docsDir + '/docs.db');
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS doc_files (path TEXT NOT NULL, kind TEXT NOT NULL, include_private INTEGER NOT NULL, mtime_ms REAL NOT NULL, size INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (path, kind, include_private))');
      const staleJson = JSON.stringify({ modules: [{
        path: 'target/stale.ts',
        name: 'stale',
        doc: { text: 'stale'.repeat(1024) },
        exports: []
      }] });
      const stmt = db.prepare('INSERT OR REPLACE INTO doc_files VALUES (?, ?, ?, ?, ?, ?)');
      try {
        for (let index = 0; index < 128; index++) {
          await stmt.run(`target/stale-${index}.ts`, 'source', 0, 1, staleJson.length, staleJson);
        }
      } finally {
        stmt.finalize();
      }
    } finally {
      await db.close();
    }
    const run = await runCli([
      'doc',
      'build',
      './current.ts',
      '--format',
      'markdown'
    ], staleDir);
    t.equal(run.result.code, 0, 'doc build exits successfully with stale cache rows');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const markdown = await fs.readFile(docsDir + '/current.md');
    t.ok(markdown.includes('## current'), 'doc build writes current module output');
    const checkDb = await Database.open(docsDir + '/docs.db');
    try {
      const stmt = checkDb.prepare('SELECT count(*) AS count FROM doc_files WHERE path LIKE ?');
      let rows: Array<Record<string, unknown>> = [];
      try {
        rows = await stmt.all('target/%');
      } finally {
        stmt.finalize();
      }
      t.equal(Number(rows[0]!.count), 0, 'doc build prunes stale target cache rows');
    } finally {
      await checkDb.close();
    }
  });
  it('includes private and internal members only with --include-private', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      './api.ts',
      '--format',
      'both',
      '--include-private',
      '--title',
      'Private API'
    ], appDir);
    t.equal(run.result.code, 0, 'private doc build exits successfully');
    t.equal(run.stderr, '', 'private doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/api.html');
    t.ok(html.includes('traceId'), 'include-private html includes @internal interface member');
    t.ok(html.includes('debugToken'), 'include-private html includes @internal class member');
    t.ok(html.includes('#token'), 'include-private html includes private class field');
    t.ok(html.includes('#peek'), 'include-private html includes private class method');
    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const api = json.modules.find((moduleDoc) => moduleDoc.name === 'api')!;
    const response = api.exports.find((item) => item.name === 'ApiResponse')!;
    const secretBox = api.exports.find((item) => item.name === 'SecretBox')!;
    t.equal(response.members.some((member) => member.name === 'traceId'), true, 'include-private json includes @internal interface member');
    t.equal(secretBox.members.some((member) => member.name === 'debugToken'), true, 'include-private json includes @internal class member');
    t.equal(secretBox.members.some((member) => member.name === '#token'), true, 'include-private json includes private class property');
    t.equal(secretBox.members.some((member) => member.name === '#peek'), true, 'include-private json includes private class method');
  });
  it('keeps generated public module docs free of private-member stubs by default', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      './private-stubs.ts',
      '--format',
      'both',
      '--title',
      'SDK Public Docs'
    ], appDir);
    t.equal(run.result.code, 0, 'public module doc build exits successfully');
    t.equal(run.stderr, '', 'public module doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/private-stubs.html');
    const markdown = await fs.readFile(docsDir + '/private-stubs.md');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const moduleDoc = json.modules.find((item) => item.name === 'private-stubs')!;
    t.equal(html.includes('private field on'), false, 'html excludes generated private-field stub text');
    t.equal(html.includes('private member'), false, 'html excludes private-member language');
    t.equal(html.includes('#secret'), false, 'html excludes private field anchors');
    t.equal(markdown.includes('private field on'), false, 'markdown excludes generated private-field stub text');
    t.equal(markdown.includes('#secret'), false, 'markdown excludes private field anchors');
    t.equal(moduleDoc.exports.some((item) => item.name.startsWith('#')), false, 'json excludes private exported names');
    t.equal(moduleDoc.exports.some((item) => item.members.some((member) => member.name.startsWith('#'))), false, 'json excludes private member names');
  });
  it('builds v2 json, html, and sqlite search artifacts', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    const dbPath = docsDir + '/docs.db';
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      './advanced.ts',
      '--format',
      'both',
      '--title',
      'Advanced API'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/advanced.md'), 'doc build reports markdown');
    t.ok(run.stdout.includes('/docs/advanced.html'), 'doc build reports html');
    t.ok(run.stdout.includes('/docs/docs.db'), 'doc build reports sqlite index');
    const html = await fs.readFile(docsDir + '/advanced.html');
    const docsCss = await fs.readFile(docsDir + '/docs.css');
    t.ok(html.includes('<title>Advanced API - advanced</title>'), 'html includes title');
    t.ok(html.includes('<p class="muted">advanced.ts</p>'), 'html shows module path relative to project root');
    t.ok(!html.includes(appDir), 'html does not include absolute project paths');
    t.ok(html.includes('id="advanced.open"'), 'html includes symbol anchors');
    t.ok(html.includes('<main'), 'html uses the shared docs template layout');
    t.ok(docsCss.includes('.docs-layout{display:grid;grid-template-columns:280px minmax(0,1fr);height:100vh'), 'shared layout uses fixed viewport height');
    t.ok(docsCss.includes('.docs-layout-api{grid-template-columns:280px minmax(0,1fr) 240px}'), 'api layout reserves a right page index column');
    t.ok(docsCss.includes('main{display:block;max-width:980px;width:100%;height:100vh;overflow:auto'), 'content area scrolls independently');
    t.ok(docsCss.includes('main{display:block;max-width:980px;width:100%;height:100vh;overflow:auto;padding:40px 48px 72px;grid-column:2;grid-row:1}'), 'content stays in the first desktop grid row');
    t.ok(docsCss.includes('.docs-page-index{border-left:1px solid var(--border);padding:40px 18px 72px;overflow:auto;position:sticky;top:0;height:100vh'), 'page index is independently scrollable and sticky');
    t.ok(docsCss.includes('.docs-page-index{border-left:1px solid var(--border);padding:40px 18px 72px;overflow:auto;position:sticky;top:0;height:100vh;grid-column:3;grid-row:1}'), 'page index stays in the first desktop grid row');
    t.ok(docsCss.includes('.docs-sidebar{grid-column:1;grid-row:1;'), 'left sidebar stays in the first desktop grid row');
    t.ok(docsCss.includes('@media(max-width:760px){body{overflow:auto}.docs-layout,.docs-layout-api{display:block;height:auto}'), 'mobile layout collapses API pages to a single column');
    t.ok(docsCss.includes('.docs-symbol{margin:0 0 72px}'), 'template separates symbols with enough whitespace after descriptions and examples');
    t.ok(docsCss.includes('.docs-symbol>h3+p,.member>h5+p{margin-top:0}'), 'template keeps descriptions close to their signatures');
    t.ok(docsCss.includes('color-scheme:light dark'), 'template advertises light and dark color schemes');
    t.ok(docsCss.includes('@media(prefers-color-scheme:dark)'), 'template automatically follows dark mode preference');
    t.ok(docsCss.includes('--bg:#0d1117'), 'template defines dark background color');
    t.ok(html.includes('<h2>Overview</h2>'), 'module markdown headings are offset below module title');
    t.ok(html.includes('<h2>Functions</h2>'), 'html groups exports by kind');
    t.ok(html.includes('<h3><code><span class="tok-keyword">function</span> open(name: <span class="tok-keyword">string</span>): <span class="tok-keyword">string</span></code></h3>'), 'html uses highlighted signatures as item headings without export prefix');
    t.ok(!html.includes('<span class="tok-keyword">export</span>'), 'html omits redundant export prefixes');
    t.ok(html.includes('<h4>Usage</h4>'), 'export markdown headings are offset below export title');
    t.ok(html.includes('<h4>Getters</h4>'), 'html groups members by kind');
    t.ok(html.includes('<h5><code><span class="tok-keyword">get</span> name(): <span class="tok-keyword">string</span></code></h5>'), 'html uses highlighted member signatures as headings');
    t.ok(html.includes('<h6>Details</h6>'), 'member markdown headings are offset below member title');
    t.ok(html.includes('<nav class="docs-page-index" aria-label="Page symbol index">'), 'api pages include a page-local symbol index');
    t.ok(html.includes('<a href="#advanced.open">open</a>'), 'page index links exported symbols by concise name');
    t.ok(html.includes('<a href="#advanced.ResourceBox">ResourceBox</a>'), 'page index links class exports by concise name');
    t.ok(html.includes('<a href="#advanced.ResourceBox.name">name</a>'), 'page index links class members by concise name');
    t.ok(html.includes('<a href="#advanced.ResourceBox.from">from</a>'), 'page index links static members by concise name');
    t.equal(html.includes('<a href="#advanced.ResourceBox.name">get name()'), false, 'page index does not use full member signatures');
    t.ok(html.indexOf('<a href="#advanced.ResourceBox">ResourceBox</a>') < html.indexOf('<a href="#advanced.ResourceBox.name">name</a>'), 'page index nests members after their parent export');
    t.ok(!html.includes('<p class="muted">function</p>'), 'html does not repeat per-symbol kind labels');
    t.ok(html.includes('Use <strong>advanced</strong> resources with the <code>ResourceBox</code> helper.'), 'html renders module markdown');
    t.ok(html.includes('<a href="../guides/advanced.md">advanced guide</a>'), 'html rewrites source-relative module markdown links for generated output');
    t.ok(html.includes('Supports <a href="https://example.test/resources">resource names</a> and <strong>flags</strong>.'), 'html renders description markdown');
    t.ok(!html.includes('@returns'), 'html does not render directive tags');
    t.ok(!html.includes('@param'), 'html does not render param directive tags');
    t.ok(html.includes('<h5><code><span class="tok-keyword">static</span> from(name: <span class="tok-keyword">string</span>): <a class="tok-type" href="advanced.html#advanced.ResourceBox">ResourceBox</a></code></h5>'), 'html links local symbols inside signatures');
    t.ok(html.includes('href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date">Date</a>'), 'html links Date signatures to MDN');
    t.ok(html.includes('href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Typed_arrays">ArrayBufferView</a>'), 'html links ArrayBufferView signatures to MDN');
    t.ok(html.includes('href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols">Iterable</a>'), 'html links Iterable signatures to MDN');
    t.ok(html.includes('href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncIterator">AsyncIterator</a>'), 'html links AsyncIterator signatures to MDN');
    t.ok(html.includes('href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols">IteratorResult</a>'), 'html links IteratorResult signatures to MDN');
    t.ok(html.includes('href="https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype">Partial</a>'), 'html links Partial signatures to TypeScript docs');
    t.ok(html.includes('<a href="advanced.html#advanced.ResourceBox">ResourceBox</a>'), 'html resolves reference links to generated symbol anchors');
    t.ok(html.includes('<a href="advanced.html#advanced.ResourceBox.name">the name getter</a>'), 'html resolves same-module symbol links');
    t.ok(html.includes('<a href="https://example.test/docs">https://example.test/docs</a>.'), 'html linkifies bare URLs');
    t.ok(html.includes(') {\n  <span class="tok-keyword">throw</span> <span class="tok-keyword">new</span> Error(value);'), 'html preserves fenced code indentation');
    t.equal(html.includes('trace()'), false, 'html excludes @internal class members by default');
    t.equal(html.includes('internalOnly'), false, 'html excludes TypeScript private class members by default');
    t.equal(html.includes('Hidden implementation detail.'), false, 'html excludes private member docs by default');
    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const moduleDoc = json.modules[0]!;
    const open = moduleDoc.exports.find((item: DocJsonExport) => item.name === 'open')!;
    const box = moduleDoc.exports.find((item: DocJsonExport) => item.name === 'ResourceBox')!;
    t.equal(moduleDoc.id, 'module:advanced', 'module has stable id');
    t.equal(moduleDoc.sourceModule, 'advanced', 'module has source specifier metadata');
    t.equal(open.id, 'advanced.open', 'export has stable id');
    t.equal(open.signatures!.length, 2, 'overloads are grouped as signatures');
    t.equal(open.doc!.blocks!.some((block) => block.kind === 'example'), false, 'legacy example blocks are not emitted');
    t.equal(open.doc!.blocks!.some((block) => block.kind === 'code' && block.lang === 'ts'), true, 'fenced examples are structured code blocks');
    t.equal(open.doc!.blocks!.some((block) => block.kind === 'param'), false, 'directive params are not emitted as structured blocks');
    t.equal(box.members.some((member) => member.kind === 'constructor'), true, 'constructor is classified');
    t.equal(box.members.some((member) => member.kind === 'getter' && member.name === 'name'), true, 'getter is classified');
    t.equal(box.members.some((member) => member.kind === 'setter' && member.name === 'name'), true, 'setter is classified');
    t.equal(box.members.some((member) => member.kind === 'static-method' && member.name === 'from'), true, 'static method is classified');
    t.equal(box.members.some((member) => member.name === 'trace'), false, 'internal members are excluded from json by default');
    t.equal(box.members.some((member) => member.name === 'internalOnly'), false, 'internal members are excluded by default');
    const found = await runCli([
      'doc',
      'search',
      'display',
      'name'
    ], appDir);
    t.equal(found.result.code, 0, 'doc search uses the generated sqlite index');
    t.ok(found.stdout.includes('advanced.ResourceBox.name'), 'sqlite search finds member docs');
    const hidden = await runCli([
      'doc',
      'search',
      'internalOnly'
    ], appDir);
    t.equal(hidden.result.code, 0, 'doc search exits successfully for private member query');
    t.equal(hidden.stdout.includes('advanced.ResourceBox.internalOnly'), false, 'sqlite search excludes private members by default');
  });
  it('links archive helper types from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/archive.ts', await fs.readFile(REPO_DIR + '/js/archive.ts'));
    const run = await runCli([
      'doc',
      'build',
      './archive.ts',
      '--format',
      'both',
      '--title',
      'Archive API'
    ], appDir);
    t.equal(run.result.code, 0, 'archive doc build exits successfully');
    t.equal(run.stderr, '', 'archive doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/archive.html');
    for (const name of [
      'ArchiveFormat',
      'ArchiveKind',
      'ZipCompression',
      'ArchiveEntryHandle',
      'ArchiveInput'
    ]) {
      t.ok(html.includes(`id="archive.${name}"`), `html includes ${name} export`);
      t.ok(html.includes(`href="#archive.${name}">${name}</a>`), `html links ${name} from signatures`);
    }
  });
  it('links compression option types from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/compress.ts', await fs.readFile(REPO_DIR + '/js/compress.ts'));
    await ensureDir(fs, appDir + '/internal/compress');
    await fs.writeFile(appDir + '/internal/compress/common.ts', await fs.readFile(REPO_DIR + '/js/internal/compress/common.ts'));
    const run = await runCli([
      'doc',
      'build',
      './compress.ts',
      './internal/compress/common.ts',
      '--format',
      'both',
      '--title',
      'Compress API'
    ], appDir);
    t.equal(run.result.code, 0, 'compress doc build exits successfully');
    t.equal(run.stderr, '', 'compress doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/compress.html');
    for (const name of [
      'ByteInput',
      'CompressionFormat',
      'CompressOptions',
      'DecompressOptions',
      'CompressionTransform'
    ]) {
      t.ok(html.includes(`id="compress.${name}"`), `html includes ${name} export`);
      t.ok(html.includes(`href="#compress.${name}">${name}</a>`), `html links ${name} from signatures`);
    }
    t.equal(html.includes('InternalCompressOptions'), false, 'html does not expose internal compress option aliases');
  });
  it('links jobs record types from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/internal/jobs');
    await fs.writeFile(appDir + '/jobs.ts', await fs.readFile(REPO_DIR + '/js/jobs.ts'));
    await fs.writeFile(appDir + '/internal/jobs/store.ts', await fs.readFile(REPO_DIR + '/js/internal/jobs/store.ts'));
    const run = await runCli([
      'doc',
      'build',
      './jobs.ts',
      './internal/jobs/store.ts',
      '--format',
      'both',
      '--title',
      'Jobs API'
    ], appDir);
    t.equal(run.result.code, 0, 'jobs doc build exits successfully');
    t.equal(run.stderr, '', 'jobs doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/jobs.html');
    for (const name of [
      'JobRecord',
      'ScheduleRecord',
      'QueueStats'
    ]) {
      t.ok(html.includes(`id="jobs.${name}"`), `html includes ${name} export`);
      t.ok(html.includes(`href="#jobs.${name}">${name}</a>`), `html links ${name} from signatures`);
    }
  });
  it('links DNS server family from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/net');
    await fs.writeFile(appDir + '/net/dns.ts', await fs.readFile(REPO_DIR + '/js/net/dns.ts'));
    const run = await runCli([
      'doc',
      'build',
      './net/dns.ts',
      '--format',
      'both',
      '--title',
      'DNS API'
    ], appDir);
    t.equal(run.result.code, 0, 'dns doc build exits successfully');
    t.equal(run.stderr, '', 'dns doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/net/dns.html');
    t.ok(html.includes('id="dns.DnsServerFamily"'), 'html includes DnsServerFamily export');
    t.ok(html.includes('href="#dns.DnsServerFamily">DnsServerFamily</a>'), 'html links DnsServerFamily from DnsServer signature');
    for (const name of [
      '_encodeName',
      '_buildQuery',
      '_decodeName',
      '_parseResponse',
      '_parseResolvConf',
      '_randomQueryId',
      '_reverseIP'
    ]) {
      t.equal(html.includes(`id="dns.${name}"`), false, `html does not include internal ${name} helper`);
    }
    for (const name of [
      'DsRecord',
      'DnskeyRecord',
      'RrsigRecord',
      'NsecRecord',
      'Nsec3Record',
      'Nsec3ParamRecord',
      'DnsEdnsMetadata'
    ]) {
      t.ok(html.includes(`id="dns.${name}"`), `html includes ${name} export`);
    }
    t.ok(html.includes('href="#dns.DnsEdnsMetadata">DnsEdnsMetadata</a>'), 'html links DnsEdnsMetadata from DnsResponse signature');
  });
  it('links HTTP arena from serialize signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/http-wire.ts', `/**
 * HTTP wire fixture.
 */
export class Arena {
  /**
   * Allocate bytes.
   */
  alloc(n: number): Uint8Array {
    return new Uint8Array(n);
  }
}

/**
 * Serialize a request.
 */
export function serializeRequest(req: Request, arena?: Arena): AsyncIterable<Uint8Array> {
  return [] as Uint8Array[];
}

/**
 * Serialize a response.
 */
export function serializeResponse(res: Response, arena?: Arena): AsyncIterable<Uint8Array> {
  return [] as Uint8Array[];
}
`);
    const run = await runCli([
      'doc',
      'build',
      './http-wire.ts',
      '--format',
      'both',
      '--title',
      'HTTP Wire API'
    ], appDir);
    t.equal(run.result.code, 0, 'http wire doc build exits successfully');
    t.equal(run.stderr, '', 'http wire doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/http-wire.html');
    t.ok(html.includes('id="http-wire.Arena"'), 'html includes Arena export');
    t.ok(html.includes('id="http-wire.serializeRequest"'), 'html includes serializeRequest export');
    t.ok(html.includes('id="http-wire.serializeResponse"'), 'html includes serializeResponse export');
    t.ok(html.includes('href="#http-wire.Arena">Arena</a>'), 'html links Arena from serialize signatures');
  });
  it('documents HTTP app context and OpenAPI metadata types', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/net/http');
    await fs.writeFile(appDir + '/net/http/app.ts', await fs.readFile(REPO_DIR + '/js/net/http/app.ts'));
    const run = await runCli([
      'doc',
      'build',
      './net/http/app.ts',
      '--format',
      'both',
      '--title',
      'HTTP App API'
    ], appDir);
    t.equal(run.result.code, 0, 'http app doc build exits successfully');
    t.equal(run.stderr, '', 'http app doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/net/http/app.html');
    for (const name of [
      'SseContext',
      'SseHandler',
      'OpenApiParameter',
      'OpenApiRequestBody',
      'OpenApiResponse'
    ]) {
      t.ok(html.includes(`id="app.${name}"`), `html includes ${name} export`);
    }
    t.ok(html.includes('href="#app.SseContext">SseContext</a>'), 'html links SseContext from SseHandler signature');
    t.ok(html.includes('href="#app.OpenApiParameter">OpenApiParameter</a>'), 'html links OpenApiParameter from OperationMeta');
    t.ok(html.includes('href="#app.OpenApiRequestBody">OpenApiRequestBody</a>'), 'html links OpenApiRequestBody from OperationMeta');
    t.ok(html.includes('href="#app.OpenApiResponse">OpenApiResponse</a>'), 'html links OpenApiResponse from OperationMeta');
  });
  it('documents HTTP server incoming base types', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/net/http');
    await fs.writeFile(appDir + '/net/http/server.ts', await fs.readFile(REPO_DIR + '/js/net/http/server.ts'));
    const run = await runCli([
      'doc',
      'build',
      './net/http/server.ts',
      '--format',
      'both',
      '--title',
      'HTTP Server API'
    ], appDir);
    t.equal(run.result.code, 0, 'http server doc build exits successfully');
    t.equal(run.stderr, '', 'http server doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const serverModule = json.modules.find((moduleDoc) => moduleDoc.path === 'net/http/server.ts');
    t.ok(serverModule, 'server module is documented');
    t.ok(serverModule!.exports.some((item) => item.name === 'IncomingBase'), 'server module exports IncomingBase');
    const markdown = await fs.readFile(docsDir + '/net/http/server.md');
    t.ok(markdown.includes('## IncomingBase'), 'server markdown includes IncomingBase');
  });
  it('documents CookieJar from the security cookie module', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/security');
    await fs.writeFile(appDir + '/security/cookie.ts', await fs.readFile(REPO_DIR + '/js/security/cookie.ts'));
    const run = await runCli([
      'doc',
      'build',
      './security/cookie.ts',
      '--format',
      'both',
      '--title',
      'Cookie API'
    ], appDir);
    t.equal(run.result.code, 0, 'security cookie doc build exits successfully');
    t.equal(run.stderr, '', 'security cookie doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/security/cookie.html');
    t.ok(html.includes('id="cookie.CookieJar"'), 'html includes CookieJar export from security cookie module');
    t.ok(html.includes('id="cookie.CookieOptions"'), 'html includes CookieOptions export from security cookie module');
  });
  it('links fetch init from the fetch globals module', async (t) => {
    const repoRoot = cwd();
    const docsDir = repoRoot + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      'js/globals/fetch.ts',
      'js/test/mock.ts',
      '--format',
      'both',
      '--title',
      'Fetch API'
    ], repoRoot);
    t.equal(run.result.code, 0, 'fetch doc build exits successfully');
    t.equal(run.stderr, '', 'fetch doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const fetchModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/fetch.ts');
    const mockModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/test/mock.ts');
    t.ok(fetchModule, 'fetch globals module is documented');
    t.ok(mockModule, 'mock module is documented');
    t.ok(fetchModule!.exports.some((item) => item.name === 'FetchInit'), 'fetch module exports FetchInit');
    t.equal(fetchModule!.exports.some((item) => item.name === 'fetchLater'), false, 'fetch module does not export fetchLater');
    t.equal(fetchModule!.exports.some((item) => item.name === 'FetchLaterResult'), false, 'fetch module does not export FetchLaterResult');
    t.equal(mockModule!.exports.some((item) => item.name === 'FetchInit'), false, 'mock module does not export FetchInit');
    t.ok(mockModule!.exports.some((item) => item.name === 'MockFetchInit'), 'mock module exports MockFetchInit');
    const html = await fs.readFile(docsDir + '/js/globals/fetch.html');
    t.ok(html.includes('id="fetch.FetchInit"'), 'fetch html includes FetchInit export');
    t.ok(html.includes('href="#fetch.FetchInit">FetchInit</a>'), 'fetch signature links its local FetchInit');
    t.equal(html.includes('mock.FetchInit'), false, 'fetch html does not link init options to mock.FetchInit');
    t.equal(html.includes('fetchLater'), false, 'fetch html omits fetchLater');
    await removeTree(fs, docsDir);
  });
  it('links FormData entry value from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/formdata.ts', await fs.readFile(REPO_DIR + '/js/globals/formdata.ts'));
    const run = await runCli([
      'doc',
      'build',
      './formdata.ts',
      '--format',
      'both',
      '--title',
      'FormData API'
    ], appDir);
    t.equal(run.result.code, 0, 'formdata doc build exits successfully');
    t.equal(run.stderr, '', 'formdata doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/formdata.html');
    t.ok(html.includes('id="formdata.FormDataEntryValue"'), 'html includes FormDataEntryValue export');
    t.ok(html.includes('href="formdata.html#formdata.FormDataEntryValue">FormDataEntryValue</a>'), 'html links FormDataEntryValue from signatures');
    t.equal(html.includes('_createMultipartBoundary'), false, 'html hides multipart boundary helper');
  });
  it('links config value type from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/config.ts', await fs.readFile(REPO_DIR + '/js/config.ts'));
    const run = await runCli([
      'doc',
      'build',
      './config.ts',
      '--format',
      'both',
      '--title',
      'Config API'
    ], appDir);
    t.equal(run.result.code, 0, 'config doc build exits successfully');
    t.equal(run.stderr, '', 'config doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/config.html');
    t.ok(html.includes('id="config.ConfigValue"'), 'html includes ConfigValue export');
    t.ok(html.includes('href="#config.ConfigValue">ConfigValue</a>'), 'html links ConfigValue from signatures');
  });
  it('links Arrow base type from public type signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/arrow-type.ts', await fs.readFile(REPO_DIR + '/js/data/arrow/type.ts'));
    await fs.writeFile(appDir + '/arrow.ts', `/**
 * Public Arrow facade.
 */
export * from './arrow-type.ts';
`);
    const run = await runCli([
      'doc',
      'build',
      './arrow.ts',
      './arrow-type.ts',
      '--format',
      'both',
      '--title',
      'Arrow Type API'
    ], appDir);
    t.equal(run.result.code, 0, 'Arrow type doc build exits successfully');
    t.equal(run.stderr, '', 'Arrow type doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/arrow.html');
    t.ok(html.includes('id="arrow.BaseType"'), 'html includes BaseType export');
    t.ok(html.includes('href="#arrow.BaseType">BaseType</a>'), 'html links BaseType from concrete type signatures');
  });
  it('links FileSystem from the public file module', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/file');
    await ensureDir(fs, appDir + '/internal/file');
    await fs.writeFile(appDir + '/file/fs.ts', await fs.readFile(REPO_DIR + '/js/file/fs.ts'));
    await fs.writeFile(appDir + '/internal/file/provider.ts', await fs.readFile(REPO_DIR + '/js/internal/file/provider.ts'));
    await fs.writeFile(appDir + '/internal/file/stat.ts', await fs.readFile(REPO_DIR + '/js/internal/file/stat.ts'));
    await fs.writeFile(appDir + '/internal/file/handle.ts', await fs.readFile(REPO_DIR + '/js/internal/file/handle.ts'));
    await fs.writeFile(appDir + '/internal/file/entry.ts', await fs.readFile(REPO_DIR + '/js/internal/file/entry.ts'));
    await fs.writeFile(appDir + '/internal/file/glob.ts', await fs.readFile(REPO_DIR + '/js/internal/file/glob.ts'));
    const run = await runCli([
      'doc',
      'build',
      './file/fs.ts',
      './internal/file/provider.ts',
      './internal/file/stat.ts',
      './internal/file/handle.ts',
      './internal/file/entry.ts',
      './internal/file/glob.ts',
      '--format',
      'both',
      '--title',
      'File API'
    ], appDir);
    t.equal(run.result.code, 0, 'file doc build exits successfully');
    t.equal(run.stderr, '', 'file doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/file/fs.html');
    t.ok(html.includes('id="fs.FileSystem"'), 'html includes FileSystem export');
    t.ok(html.includes('href="#fs.FileSystem">FileSystem</a>'), 'html links FileSystem from DiskFileSystem signature');
    for (const name of [
      'Stat',
      'File',
      'Entry',
      'FileEntry',
      'DirEntry'
    ]) {
      t.ok(html.includes(`id="fs.${name}"`), `html includes ${name} export`);
    }
    t.equal(await exists(fs, docsDir + '/internal/file/provider.html'), false, 'internal provider module remains hidden');
  });
  it('documents public stream reader and writer re-exports', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/js/internal');
    await fs.writeFile(appDir + '/js/stream.ts', await fs.readFile(REPO_DIR + '/js/stream.ts'));
    await fs.writeFile(appDir + '/js/internal/stream.ts', await fs.readFile(REPO_DIR + '/js/internal/stream.ts'));
    const run = await runCli([
      'doc',
      'build',
      './js/stream.ts',
      './js/internal/stream.ts',
      '--format',
      'both',
      '--title',
      'Stream API'
    ], appDir);
    t.equal(run.result.code, 0, 'stream doc build exits successfully');
    t.equal(run.stderr, '', 'stream doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const streamModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/stream.ts');
    t.ok(streamModule, 'public stream module is documented');
    for (const name of [
      'ReaderCloseCallback',
      'BytesReadOptions',
      'Reader',
      'BytesReader',
      'BufferedBytesReader',
      'Writer',
      'BytesWriter',
      'BufferedBytesWriter'
    ]) {
      t.ok(streamModule!.exports.some((item) => item.name === name), `stream module exports ${name}`);
    }
    const markdown = await fs.readFile(docsDir + '/js/stream.md');
    for (const name of [
      'ReaderCloseCallback',
      'BytesReadOptions',
      'Reader',
      'BytesReader',
      'BufferedBytesReader',
      'Writer',
      'BytesWriter',
      'BufferedBytesWriter'
    ]) {
      t.ok(markdown.includes(`## ${name}`), `stream markdown includes ${name}`);
    }
    t.equal(await exists(fs, docsDir + '/js/internal/stream.md'), false, 'internal stream module remains hidden by default');
  });
  it('assigns unique doc ids to same-name type and value exports', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/same-name.ts', `/**
 * Same-name export fixture.
 */

/**
 * Runtime widget shape.
 */
export interface Widget {
  readonly id: string;
}

/**
 * Runtime widget constructor.
 */
export const Widget = class WidgetImpl {
  id = 'fixture';
};
`);
    const run = await runCli([
      'doc',
      'build',
      './same-name.ts',
      '--format',
      'both',
      '--title',
      'Same Name API'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/docs.db'), 'doc build reports sqlite index');
    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const moduleDoc = json.modules.find((item) => item.name === 'same-name')!;
    const widgets = moduleDoc.exports.filter((item) => item.name === 'Widget');
    const ids = widgets.map((item) => item.id);
    t.equal(widgets.length, 2, 'json keeps both same-name exports');
    t.equal(new Set(ids).size, ids.length, 'same-name exports have distinct symbol ids');
    t.ok(ids.includes('same-name.Widget'), 'first same-name export keeps the canonical symbol id');
    t.ok(ids.includes('same-name.Widget:const'), 'second same-name export is disambiguated by kind');
  });
  it('documents ambient declaration modules as separate API modules', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/runtime-builtins.d.ts', `/**
 * fino:ffi — Rust-backed native library loading.
 *
 * Use this module when a Fino script needs direct access to a system dynamic
 * library. Declarations in this fixture model Rust-provided synthetic modules
 * that do not have JavaScript source files.
 */
declare module 'fino:ffi' {
  /**
   * Native symbol call signature.
   */
  export interface NativeSymbolSpec {
    /**
     * Positional native parameter descriptors.
     */
    parameters?: readonly unknown[];
  }

  /**
   * Open a dynamic library and bind selected symbols.
   */
  export function dlopen(path: string | null, symbols: Record<string, NativeSymbolSpec>): unknown;
}

/**
 * internal:process — Rust-backed process state.
 *
 * @internal
 */
declare module 'internal:process' {
  /**
   * Operating system identifier.
   */
  export const os: string;
}

declare global {
  var ambientFixtureFlag: boolean | undefined;
}
`);
    const run = await runCli([
      'doc',
      'build',
      './runtime-builtins.d.ts',
      '--format',
      'both',
      '--title',
      'Runtime Builtins'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/ffi.md'), 'doc build reports ambient public markdown output');
    t.equal(run.stdout.includes('/docs/fino/ffi.md'), false, 'doc build does not nest public fino declarations under a fino directory');
    t.equal(await exists(fs, docsDir + '/runtime-builtins.d.ts.md'), false, 'doc build does not emit a single declaration-file page');
    t.equal(await exists(fs, docsDir + '/global.md'), false, 'doc build does not emit declare global as an API module');
    t.equal(await exists(fs, docsDir + '/internal/process.md'), false, 'public doc build omits internal ambient modules');
    const markdown = await fs.readFile(docsDir + '/ffi.md');
    t.ok(markdown.includes('# ffi'), 'markdown uses the canonical public module title');
    t.ok(markdown.includes('Rust-backed native library loading.'), 'markdown includes the ambient module comment');
    t.ok(markdown.includes('## dlopen'), 'markdown includes exported ambient functions');
    t.ok(markdown.includes('## NativeSymbolSpec'), 'markdown includes exported ambient interfaces');
    t.ok(markdown.includes('### parameters'), 'markdown includes ambient interface members');
    const html = await fs.readFile(docsDir + '/ffi.html');
    t.ok(html.includes('API Reference'), 'html sidebar includes the API reference root');
    t.equal(html.includes('docs-sidebar-directory">fino</div>'), false, 'html sidebar does not group public fino declarations under a fino heading');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const ffi = json.modules.find((moduleDoc) => moduleDoc.name === 'ffi');
    t.ok(ffi, 'json includes public ambient module by canonical name');
    t.equal(ffi!.path, 'runtime-builtins.d.ts', 'json preserves the declaration file as the source path');
    t.equal(ffi!.sourceModule, 'fino:ffi', 'json records the ambient source module specifier');
    t.ok(ffi!.exports.some((item) => item.name === 'dlopen'), 'json includes ambient function export');
    t.equal(json.modules.some((moduleDoc) => moduleDoc.name === 'internal:process'), false, 'json excludes internal ambient modules by default');
    const found = await runCli([
      'doc',
      'search',
      'dlopen'
    ], appDir);
    t.equal(found.result.code, 0, 'doc search exits successfully');
    t.ok(found.stdout.includes('ffi.dlopen'), 'sqlite search indexes ambient module symbols by canonical id');
    await removeTree(fs, docsDir);
    const privateRun = await runCli([
      'doc',
      'build',
      './runtime-builtins.d.ts',
      '--format',
      'markdown',
      '--include-private',
      '--title',
      'Runtime Builtins'
    ], appDir);
    t.equal(privateRun.result.code, 0, 'private doc build exits successfully');
    t.equal(privateRun.stderr, '', 'private doc build writes no stderr');
    t.equal(await exists(fs, docsDir + '/internal/process.md'), true, 'include-private emits internal ambient modules');
  });
  it('merges declaration files into js tree docs when --types is provided', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/js');
    await fs.writeFile(appDir + '/js/public.ts', `/**
 * Public JS module.
 */

/**
 * Public JS value.
 */
export const value = 1;
`);
    await fs.writeFile(appDir + '/runtime-builtins.d.ts', `/**
 * fino:ffi — Rust-backed native library loading.
 */
declare module 'fino:ffi' {
  /**
   * Open a dynamic library.
   */
  export function dlopen(path: string | null, symbols: Record<string, unknown>): unknown;
}
`);
    const withoutTypes = await runCli([
      'doc',
      'build',
      '--format',
      'both',
      'js'
    ], appDir);
    t.equal(withoutTypes.result.code, 0, 'doc build without --types exits successfully');
    t.equal(withoutTypes.stderr, '', 'doc build without --types writes no stderr');
    t.ok(withoutTypes.stdout.includes('/docs/public.md'), 'doc build reports docs for files under the js input root');
    t.equal(withoutTypes.stdout.includes('/docs/js/public.md'), false, 'doc build does not nest js input-root docs under a js directory');
    t.equal(withoutTypes.stdout.includes('/docs/ffi.md'), false, 'doc build does not report declaration docs without --types');
    let json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    t.ok(json.modules.some((moduleDoc) => moduleDoc.path === 'js/public.ts'), 'json includes js tree module without --types');
    t.equal(json.modules.some((moduleDoc) => moduleDoc.name === 'ffi'), false, 'json omits runtime declaration module without --types');
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      '--format',
      'both',
      '--types',
      'runtime-builtins.d.ts',
      'js'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/public.md'), 'doc build reports docs for files under the js input root');
    t.equal(run.stdout.includes('/docs/js/public.md'), false, 'doc build does not nest js input-root docs under a js directory');
    t.ok(run.stdout.includes('/docs/ffi.md'), 'doc build reports root runtime declaration docs');
    t.equal(run.stdout.includes('/docs/fino/ffi.md'), false, 'doc build does not nest declaration docs under a fino directory');
    const publicHtml = await fs.readFile(docsDir + '/public.html');
    t.equal(publicHtml.includes('docs-sidebar-directory">js</div>'), false, 'sidebar does not group js input-root modules under a js heading');
    json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    t.ok(json.modules.some((moduleDoc) => moduleDoc.path === 'js/public.ts'), 'json includes js tree module');
    t.ok(json.modules.some((moduleDoc) => moduleDoc.name === 'ffi'), 'json includes runtime declaration module');
    const found = await runCli([
      'doc',
      'search',
      'dlopen'
    ], appDir);
    t.equal(found.result.code, 0, 'doc search exits successfully');
    t.ok(found.stdout.includes('ffi.dlopen'), 'search finds runtime declaration symbols after js build');
  });
  it('keeps ambient module names when a source file shares the basename', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/js/internal');
    await fs.writeFile(appDir + '/js/internal/ffi.ts', `/**
 * Internal ffi helpers.
 *
 * @internal
 */

/**
 * Internal helper value.
 */
export const helper = 1;
`);
    await fs.writeFile(appDir + '/runtime-builtins.d.ts', `/**
 * fino:ffi — Rust-backed native library loading.
 */
declare module 'fino:ffi' {
  /**
   * Open a dynamic library.
   */
  export function dlopen(path: string | null, symbols: Record<string, unknown>): unknown;
}
`);
    const run = await runCli([
      'doc',
      'build',
      '--format',
      'markdown',
      '--types',
      'runtime-builtins.d.ts',
      'js'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const ffi = json.modules.find((moduleDoc) => moduleDoc.sourceModule === 'fino:ffi');
    t.ok(ffi, 'json keeps the ambient source module specifier');
    t.equal(ffi?.name, 'ffi', 'ambient module keeps its specifier-derived name');
    t.equal(json.modules.some((moduleDoc) => moduleDoc.name.includes('runtime-builtins')), false, 'no module is renamed after the declaration file');
    const markdown = await fs.readFile(docsDir + '/ffi.md');
    t.ok(markdown.includes('# ffi'), 'markdown titles the ambient module by its canonical name');
    await removeTree(fs, appDir + '/js/internal');
  });
  it('shows and searches fixed project docs artifacts', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    const dbPath = docsDir + '/docs.db';
    await removeTree(fs, docsDir);
    const missingBuild = await runCli([
      'doc',
      'search',
      'display',
      'name'
    ], appDir);
    t.notEqual(missingBuild.result.code, 0, 'doc search requires a prior build');
    const build = await runCli([
      'doc',
      'build',
      './advanced.ts',
      '--format',
      'both',
      '--title',
      'Advanced API'
    ], appDir);
    t.equal(build.result.code, 0, 'doc build exits successfully');
    t.equal(await exists(fs, jsonPath), true, 'doc build writes api.json');
    t.equal(await exists(fs, dbPath), true, 'doc build writes docs.db');
    await fs.unlink(dbPath);
    const search = await runCli([
      'doc',
      'search',
      'display',
      'name'
    ], appDir);
    t.equal(search.result.code, 0, 'doc search regenerates missing search db from prior build inputs');
    t.equal(search.stderr, '', 'doc search writes no stderr');
    t.ok(search.stdout.includes('advanced.ResourceBox.name'), 'search finds member docs');
    t.equal(search.stdout.includes('Wrote '), false, 'search does not surface transparent build output');
    t.equal(await exists(fs, dbPath), true, 'search regenerates missing docs.db in fixed docs dir');
    const shown = await runCli([
      'doc',
      'show',
      'advanced.open'
    ], appDir);
    t.equal(shown.result.code, 0, 'doc show exits successfully');
    t.ok(shown.stdout.includes('## open'), 'show renders symbol heading');
    t.ok(shown.stdout.includes('function open(name: string): string'), 'show renders overload signature without export prefix');
    t.equal(shown.stdout.includes('export function open'), false, 'show omits redundant export prefix');
    t.ok(shown.stdout.includes('```ts\nconst value = open("primary");'), 'show renders examples');
    const member = await runCli([
      'doc',
      'show',
      'ResourceBox.name'
    ], appDir);
    t.equal(member.result.code, 0, 'doc show finds member-qualified names');
    t.ok(member.stdout.includes('### name'), 'member show renders member heading');
    if (sqliteAvailable) {
      await fs.unlink(dbPath);
      const fromJson = await runCli([
        'doc',
        'search',
        'doc:display'
      ], appDir);
      t.equal(fromJson.result.code, 0, 'doc search regenerates missing sqlite index from api.json');
      t.ok(fromJson.stdout.includes('advanced.ResourceBox.name'), 'regenerated sqlite search supports FTS column queries');
      t.equal(await exists(fs, dbPath), true, 'search writes regenerated docs.db in fixed docs dir');
    }
    const rejectedDb = await runCli([
      'doc',
      'search',
      'display',
      '--db',
      'custom.db'
    ], appDir);
    t.notEqual(rejectedDb.result.code, 0, 'doc search rejects --db');
    const rejectedOut = await runCli([
      'doc',
      'search',
      'display',
      '--out',
      'custom-docs'
    ], appDir);
    t.notEqual(rejectedOut.result.code, 0, 'doc search rejects --out');
    const ambiguous = await runCli([
      'doc',
      'show',
      'name'
    ], appDir);
    t.equal(ambiguous.result.code, 0, 'ambiguous show exits successfully');
    t.ok(ambiguous.stdout.includes('Multiple matches'), 'ambiguous show reports candidates');
  });
  it('ignores generated and dependency directories during directory discovery', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/target');
    await ensureDir(fs, appDir + '/node_modules');
    await fs.writeFile(appDir + '/target/broken.ts', 'export const = ;\n');
    await fs.writeFile(appDir + '/node_modules/broken.ts', 'export const = ;\n');
    const run = await runCli([
      'doc',
      'build',
      '.',
      '--format',
      'markdown'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build . exits successfully');
    t.equal(run.stderr, '', 'doc build . writes no stderr');
    t.ok(run.stdout.includes('/docs/advanced.md'), 'doc build still discovers project sources');
  });
  it('serializes concurrent search index regenerations', async (t) => {
    const project = TEST_DIR + '/concurrent-search-' + Math.floor(Math.random() * 1e6);
    await ensureDir(fs, project);
    await fs.writeFile(project + '/api.ts', `/**
 * Concurrent search module.
 */

/**
 * Searchable concurrent value.
 */
export const concurrentValue = 1;
`);
    const build = await runCli([
      'doc',
      'build',
      'api.ts',
      '--format',
      'markdown'
    ], project);
    t.equal(build.result.code, 0, 'initial build exits successfully');
    await fs.unlink(project + '/docs/docs.db');
    const [a, b] = await Promise.all([runCliProcess([
      'doc',
      'search',
      'concurrentValue'
    ], project), runCliProcess([
      'doc',
      'search',
      'concurrentValue'
    ], project)]);
    t.equal(a.result.code, 0, 'first search exits successfully');
    t.equal(b.result.code, 0, 'second search exits successfully');
    t.equal(a.stderr, '', 'first search writes no stderr');
    t.equal(b.stderr, '', 'second search writes no stderr');
    t.ok(a.stdout.includes('api.concurrentValue'), 'first search finds symbol');
    t.ok(b.stdout.includes('api.concurrentValue'), 'second search finds symbol');
  });
  it('uses initial build inputs when regenerating a missing search db', async (t) => {
    const project = TEST_DIR + '/input-metadata-' + Math.floor(Math.random() * 1e6);
    await ensureDir(fs, project + '/src');
    await fs.writeFile(project + '/src/public.ts', `/**
 * Scoped public module.
 */

/**
 * Scoped value docs.
 */
export const scopedValue = 1;
`);
    await fs.writeFile(project + '/outside.ts', `/**
 * Outside module docs.
 */

/**
 * Outside value docs.
 */
export const outsideValue = 1;
`);
    const build = await runCli([
      'doc',
      'build',
      'src',
      '--format',
      'markdown'
    ], project);
    t.equal(build.result.code, 0, 'scoped build exits successfully');
    await fs.unlink(project + '/docs/docs.db');
    const scoped = await runCli([
      'doc',
      'search',
      'scopedValue'
    ], project);
    t.equal(scoped.result.code, 0, 'search regenerates missing db');
    t.ok(scoped.stdout.includes('public.scopedValue'), 'search finds scoped build input');
    const outside = await runCli([
      'doc',
      'search',
      'outsideValue'
    ], project);
    t.equal(outside.result.code, 0, 'outside search exits successfully');
    t.equal(outside.stdout, 'No results for outsideValue\n', 'search does not rediscover outside initial build roots');
  });
  it('refreshes stale search artifacts from new and changed inputs', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    await removeTree(fs, docsDir);
    const initial = await runCli([
      'doc',
      'build',
      './advanced.ts',
      '--format',
      'both',
      '--title',
      'Advanced API'
    ], appDir);
    t.equal(initial.result.code, 0, 'initial doc build exits successfully');
    t.equal(initial.stderr, '', 'initial doc build writes no stderr');
    await fs.writeFile(appDir + '/incremental-new.ts', `/**
 * Incremental new module fixture.
 */

/**
 * New symbol added after the search database was built.
 */
export function staleSearchAdded(): string {
  return 'added';
}
`);
    const foundNew = await runCli([
      'doc',
      'search',
      'staleSearchAdded'
    ], appDir);
    t.equal(foundNew.result.code, 0, 'stale search refresh exits successfully');
    t.equal(foundNew.stderr, '', 'stale search refresh writes no stderr');
    t.ok(foundNew.stdout.includes('incremental-new.staleSearchAdded'), 'search finds a symbol from a new source file');
    t.equal(foundNew.stdout.includes('Wrote '), false, 'search does not surface incremental refresh output');
    let json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    t.ok(json.modules.some((item) => item.name === 'incremental-new'), 'incremental search refresh updates api.json');
    await fs.writeFile(appDir + '/incremental-new.ts', `/**
 * Incremental changed module fixture.
 */

/**
 * New symbol added after the search database was built.
 */
export function staleSearchAdded(): string {
  return 'added';
}

/**
 * Changed symbol added to an already-cached file.
 */
export function staleSearchChanged(): string {
  return 'changed';
}
`);
    const foundChanged = await runCli([
      'doc',
      'search',
      'staleSearchChanged'
    ], appDir);
    t.equal(foundChanged.result.code, 0, 'changed-file stale search refresh exits successfully');
    t.ok(foundChanged.stdout.includes('incremental-new.staleSearchChanged'), 'search finds a symbol added to an existing source file');
    const shown = await runCli([
      'doc',
      'show',
      'staleSearchChanged'
    ], appDir);
    t.equal(shown.result.code, 0, 'show refreshes stale api json');
    t.ok(shown.stdout.includes('## staleSearchChanged'), 'show renders the newly added symbol');
    json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const incremental = json.modules.find((item) => item.name === 'incremental-new')!;
    t.ok(incremental.exports.some((item) => item.name === 'staleSearchChanged'), 'api.json includes changed-file symbol');
  });
  it('refreshes search within the original build input roots', async (t) => {
    const rootDir = TEST_DIR + '/doc-input-roots';
    const jsDir = rootDir + '/js';
    const brokenDir = rootDir + '/third_party';
    await removeTree(fs, rootDir);
    await ensureDir(fs, jsDir);
    await ensureDir(fs, brokenDir);
    await fs.writeFile(jsDir + '/initial.ts', `/**
 * Initial scoped docs module.
 */

/**
 * Initial scoped symbol.
 */
export function scopedInitial(): string {
  return 'initial';
}
`);
    await fs.writeFile(brokenDir + '/broken.js', 'export const = ;\n');
    const initial = await runCli([
      'doc',
      'build',
      './js',
      '--format',
      'markdown'
    ], rootDir);
    t.equal(initial.result.code, 0, 'initial scoped build exits successfully');
    await fs.writeFile(jsDir + '/later.ts', `/**
 * Later scoped docs module.
 */

/**
 * Later scoped symbol.
 */
export function scopedLater(): string {
  return 'later';
}
`);
    const found = await runCli([
      'doc',
      'search',
      'scopedLater'
    ], rootDir);
    t.equal(found.result.code, 0, 'search refresh exits successfully without scanning broken sibling directories');
    t.equal(found.stderr, '', 'search refresh writes no stderr');
    t.ok(found.stdout.includes('later.scopedLater'), 'search finds new symbol under original build root');
  });
  it('refreshes re-exported symbols and removes deleted cached files', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/incremental-source.ts', `/**
 * Incremental source fixture.
 */

/**
 * First re-exported value.
 */
export const firstReExported = 'first';
`);
    await fs.writeFile(appDir + '/incremental-facade.ts', `/**
 * Incremental facade fixture.
 */

export * from './incremental-source.ts';
`);
    const initial = await runCli([
      'doc',
      'build',
      './incremental-facade.ts',
      './incremental-source.ts',
      '--format',
      'both',
      '--title',
      'Incremental API'
    ], appDir);
    t.equal(initial.result.code, 0, 'initial re-export build exits successfully');
    t.equal(initial.stderr, '', 'initial re-export build writes no stderr');
    await fs.writeFile(appDir + '/incremental-source.ts', `/**
 * Incremental source fixture.
 */

/**
 * First re-exported value.
 */
export const firstReExported = 'first';

/**
 * Re-exported value added after the facade was cached.
 */
export const laterReExported = 'later';
`);
    const found = await runCli([
      'doc',
      'search',
      'laterReExported'
    ], appDir);
    t.equal(found.result.code, 0, 're-export stale search refresh exits successfully');
    t.ok(found.stdout.includes('incremental-facade.laterReExported'), 'search finds the newly re-exported facade symbol');
    await fs.unlink(appDir + '/incremental-source.ts');
    const rebuilt = await runCli([
      'doc',
      'build',
      './incremental-facade.ts',
      '--format',
      'both',
      '--title',
      'Incremental API'
    ], appDir);
    t.equal(rebuilt.result.code, 0, 'rebuild after deleting an input exits successfully');
    t.equal(rebuilt.stderr, '', 'rebuild after deleting an input writes no stderr');
    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    t.equal(json.modules.some((item) => item.name === 'incremental-source'), false, 'api.json drops deleted source files');
    t.equal(json.modules.some((item) => item.exports.some((exp) => exp.name === 'laterReExported')), false, 'api.json drops symbols from deleted sources');
    t.equal(await exists(fs, docsDir + '/incremental-source.html'), false, 'doc build prunes generated output for deleted files');
  });
  it('keeps public and private doc caches separate', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/incremental-private.ts', `/**
 * Incremental private fixture.
 */

/**
 * Public value.
 */
export const publicCacheValue = true;

/**
 * Private value.
 *
 * @internal
 */
export const privateCacheValue = true;
`);
    const privateRun = await runCli([
      'doc',
      'build',
      './incremental-private.ts',
      '--include-private',
      '--format',
      'both',
      '--title',
      'Private API'
    ], appDir);
    t.equal(privateRun.result.code, 0, 'private doc build exits successfully');
    t.equal(privateRun.stderr, '', 'private doc build writes no stderr');
    const publicRun = await runCli([
      'doc',
      'build',
      './incremental-private.ts',
      '--format',
      'both',
      '--title',
      'Public API'
    ], appDir);
    t.equal(publicRun.result.code, 0, 'public doc build exits successfully');
    t.equal(publicRun.stderr, '', 'public doc build writes no stderr');
    const hidden = await runCli([
      'doc',
      'search',
      'privateCacheValue'
    ], appDir);
    t.equal(hidden.result.code, 0, 'public search exits successfully');
    t.equal(hidden.stdout.includes('incremental-private.privateCacheValue'), false, 'public search does not reuse the private cache entry');
  });
  it('writes README-backed root html index and mirrors source paths', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      './advanced.ts',
      './pkg/index.ts',
      './alpha/client.ts',
      './beta/client.ts',
      './internal-only.ts',
      '--format',
      'html',
      '--title',
      'Docs Site'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const index = await fs.readFile(docsDir + '/index.html');
    const docsCss = await fs.readFile(docsDir + '/docs.css');
    const docsJs = await fs.readFile(docsDir + '/docs.js');
    t.ok(index.includes('<title>Docs Site</title>'), 'root index has site title');
    t.ok(index.includes('<link rel="stylesheet" href="docs.css">'), 'root index links shared docs css');
    t.ok(index.includes('<script src="docs.js" defer data-docs-client-navigation><\/script>'), 'root index links shared docs javascript');
    t.equal(index.includes('<style>'), false, 'root index does not inline docs css');
    t.equal(index.includes('document.addEventListener(\'click\''), false, 'root index does not inline docs javascript');
    t.equal(index.includes('<nav class="docs-page-index"'), false, 'root index does not render the API symbol index');
    t.ok(index.includes('<h1>Fixture API</h1>'), 'root index renders project README');
    t.ok(index.includes('<img src="./logo.svg" alt="Fixture logo">'), 'root index preserves README image URLs for copied docs assets');
    t.ok(docsCss.includes('main img[src$=".svg"]{filter:invert(1) brightness(1.25)}'), 'dark mode inverts copied SVG images such as logos');
    t.equal(await fs.readFile(docsDir + '/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><title>Fixture logo</title></svg>\n', 'doc build copies README image assets into docs output');
    t.ok(index.includes('<a href="../guides/start.md">Project guide</a>'), 'root index rewrites README links for generated output');
    t.ok(index.includes('<li>It should render Markdown lists.</li>'), 'root index renders README markdown blocks');
    t.equal(index.includes('module-card'), false, 'root index no longer renders a flat module card list');
    t.ok(index.includes('<nav class="docs-sidebar"'), 'root index includes sidebar navigation');
    t.ok(docsJs.includes('showLoading()'), 'docs javascript swaps the main content and page index while local pages load');
    t.ok(docsJs.includes('document.addEventListener(\'click\''), 'docs javascript intercepts normal local link clicks');
    t.ok(docsJs.includes('fetch(url.href'), 'docs javascript fetches local html pages without replacing the sidebar');
    t.ok(docsCss.includes('docs-loading'), 'docs css includes a loading state for client-side navigation');
    t.ok(index.includes('href="advanced.html"'), 'sidebar links regular root modules');
    t.ok(index.includes('href="pkg.html"'), 'sidebar folds index modules into parent pages');
    t.equal(index.includes('href="pkg/index.html"'), false, 'sidebar does not expose index module pages as index.html');
    t.ok(index.includes('href="alpha/client.html"'), 'sidebar links first same-basename module by source path');
    t.ok(index.includes('href="beta/client.html"'), 'sidebar links second same-basename module by source path');
    t.equal(index.includes('internal-only.html'), false, 'sidebar excludes file-level internal modules by default');
    t.ok(!index.includes('<h1 id="module:index">index</h1>'), 'root index is not an index module page');
    t.equal(await exists(fs, docsDir + '/internal-only.html'), false, 'build excludes file-level internal module pages by default');
    t.equal(await exists(fs, docsDir + '/pkg/index.html'), false, 'index module does not write a nested index.html page');
    const indexModule = await fs.readFile(docsDir + '/pkg.html');
    t.ok(indexModule.includes('<title>Docs Site - pkg</title>'), 'index module gets parent output page');
    t.ok(indexModule.includes('<link rel="stylesheet" href="docs.css">'), 'root module page links shared docs css');
    t.ok(indexModule.includes('<script src="docs.js" defer data-docs-client-navigation><\/script>'), 'root module page links shared docs javascript');
    t.ok(indexModule.includes('Package index docs.'), 'index module page renders docs');
    t.ok(indexModule.includes('href="index.html"'), 'folded index module links back to root index');
    t.ok(indexModule.includes('href="alpha/client.html"'), 'folded index module sidebar uses relative links to sibling folders');
    const alphaClient = await fs.readFile(docsDir + '/alpha/client.html');
    const betaClient = await fs.readFile(docsDir + '/beta/client.html');
    t.ok(alphaClient.includes('<title>Docs Site - alpha/client</title>'), 'first same-basename module writes mirrored page');
    t.ok(alphaClient.includes('<link rel="stylesheet" href="../docs.css">'), 'nested module page links shared docs css relatively');
    t.ok(alphaClient.includes('<script src="../docs.js" defer data-docs-client-navigation><\/script>'), 'nested module page links shared docs javascript relatively');
    t.ok(betaClient.includes('<title>Docs Site - beta/client</title>'), 'second same-basename module writes mirrored page');
    t.ok(betaClient.includes('<a href="../alpha/client.html#alpha-client.Client">AlphaClient</a>'), 'markdown source links resolve across mirrored paths');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    t.equal(json.modules.some((moduleDoc) => moduleDoc.name === 'internal-only'), false, 'json excludes file-level internal modules by default');
    const privateRun = await runCli([
      'doc',
      'build',
      './internal-only.ts',
      '--format',
      'html',
      '--include-private',
      '--title',
      'Private Docs'
    ], appDir);
    t.equal(privateRun.result.code, 0, 'private doc build exits successfully');
    t.equal(await exists(fs, docsDir + '/internal-only.html'), true, 'include-private includes file-level internal module pages');
    const internalHtml = await fs.readFile(docsDir + '/internal-only.html');
    t.ok(internalHtml.includes('Internal-only module docs.'), 'include-private renders file-level internal module docs');
  });
  it('uses the project package name as the default html title', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      './advanced.ts',
      '--format',
      'html'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const index = await fs.readFile(docsDir + '/index.html');
    const html = await fs.readFile(docsDir + '/advanced.html');
    t.ok(index.includes('<title>fixture-project</title>'), 'root index uses inferred project title');
    t.ok(index.includes('<p class="docs-sidebar-title"><a href="index.html">fixture-project</a></p>'), 'sidebar home link uses inferred project title');
    t.ok(html.includes('<title>fixture-project - advanced</title>'), 'module page uses inferred project title');
  });
  it('renders directory-discovered markdown guides as sidebar and search pages', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      '.',
      '--format',
      'both',
      '--title',
      'Guide Docs'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/guides/start.html'), 'doc build reports guide html');
    t.ok(run.stdout.includes('/docs/guides/start.md'), 'doc build reports guide markdown');
    t.equal(await exists(fs, docsDir + '/README.html'), false, 'root README is not duplicated as a guide page');
    const index = await fs.readFile(docsDir + '/index.html');
    const docsCss = await fs.readFile(docsDir + '/docs.css');
    t.ok(index.includes('href="guides/start.html"'), 'root README links to generated guide pages');
    t.ok(index.includes('class="docs-sidebar-link docs-sidebar-link-api"'), 'sidebar marks API reference links');
    t.ok(index.includes('class="docs-sidebar-link docs-sidebar-link-guide"'), 'sidebar marks guide links');
    t.ok(index.includes('<p class="docs-sidebar-title"><a href="index.html">Guide Docs</a></p>'), 'sidebar title links home using project title');
    t.equal(index.includes('API Documentation'), false, 'sidebar does not use generic API Documentation title');
    t.ok(index.includes('<div class="docs-sidebar-directory">Docs</div>'), 'sidebar renders a separate docs tree');
    t.ok(index.includes('<div class="docs-sidebar-directory">API Reference</div>'), 'sidebar renders a separate API reference tree');
    t.ok(index.indexOf('<div class="docs-sidebar-directory">Docs</div>') < index.indexOf('<div class="docs-sidebar-directory">API Reference</div>'), 'guide tree appears before API reference tree');
    t.ok(index.includes('docs-sidebar-icon docs-sidebar-icon-api'), 'sidebar renders API icons');
    t.ok(index.includes('docs-sidebar-icon docs-sidebar-icon-guide'), 'sidebar renders guide icons');
    t.ok(docsCss.includes('opacity:.62'), 'sidebar icons use subdued opacity');
    t.equal(index.includes('.docs-sidebar-link-guide .docs-sidebar-icon{color:#8250df}'), false, 'guide icons do not use a saturated accent color');
    t.ok(index.includes('viewBox="0 0 24 24"'), 'sidebar uses a cleaner 24px guide icon shape');
    t.ok(index.indexOf('href="alpha/guide.html"') < index.indexOf('<div class="docs-sidebar-directory">API Reference</div>'), 'sidebar separates guides from API pages');
    t.ok(index.indexOf('href="guides/start.html"') < index.indexOf('href="guides/advanced.html"'), 'sidebar sorts weighted guides by ascending weight');
    t.ok(index.includes('href="docs/concepts/virtual.html"'), 'sidebar uses virtual guide paths from frontmatter');
    const guideHtml = await fs.readFile(docsDir + '/guides/start.html');
    t.ok(guideHtml.includes('<title>Guide Docs - Getting Started</title>'), 'guide html uses markdown title');
    t.ok(guideHtml.includes('<nav class="docs-page-index" aria-label="Page table of contents">'), 'guide pages render a right-side table of contents');
    t.ok(guideHtml.includes('<h2 id="Usage">Usage</h2>'), 'guide markdown headings receive stable anchors');
    t.ok(guideHtml.includes('<li class="docs-page-index-heading docs-page-index-heading-2"><a href="#Usage">Usage</a></li>'), 'guide table of contents links to heading anchors');
    t.ok(guideHtml.includes('<p class="muted">guides/start.md</p>'), 'guide html shows source path');
    t.equal(guideHtml.includes('weight: 10'), false, 'guide html strips frontmatter');
    t.ok(guideHtml.includes('<a href="advanced.html">advanced guide</a>'), 'guide links resolve to other generated guides');
    t.ok(guideHtml.includes('<a href="../advanced.html#advanced.open">advanced API</a>'), 'guide links resolve to generated API anchors');
    t.ok(guideHtml.includes('<span class="tok-keyword">import</span>'), 'guide fenced code uses syntax highlighting');
    t.ok(guideHtml.includes('<span class="tok-keyword">const</span> value'), 'guide code highlighting preserves code text');
    t.ok(guideHtml.includes('href="start.html" aria-current="page"'), 'guide page marks current sidebar entry');
    const advancedGuideHtml = await fs.readFile(docsDir + '/guides/advanced.html');
    t.ok(advancedGuideHtml.includes('<a href="../advanced.html#advanced.ResourceBox">ResourceBox</a>'), 'sibling guide resolves API type links');
    t.ok(advancedGuideHtml.includes('<a href="start.html">getting started</a>'), 'sibling guide resolves guide links');
    const virtualGuideHtml = await fs.readFile(docsDir + '/docs/concepts/virtual.html');
    t.ok(virtualGuideHtml.includes('<p class="muted">guides/virtual.md</p>'), 'guide html shows source path even when output path is virtualized');
    t.equal(virtualGuideHtml.includes('path: docs/concepts/virtual.md'), false, 'virtual guide html strips path frontmatter');
    const guideMarkdown = await fs.readFile(docsDir + '/guides/start.md');
    t.ok(guideMarkdown.includes('# Getting Started'), 'markdown output copies guide markdown');
    t.equal(guideMarkdown.includes('weight: 10'), false, 'markdown output strips guide frontmatter');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const startGuide = json.guides?.find((guide) => guide.path === 'guides/start.md');
    t.ok(startGuide, 'json records guide metadata');
    t.equal(startGuide!.href, 'guides/start.html', 'json records guide output href');
    t.equal(startGuide!.weight, 10, 'json records guide weight');
    t.ok(startGuide!.summary.includes('Start with the'), 'json records guide summary');
    t.ok(startGuide!.text.includes('fixture users'), 'json records searchable guide text');
    t.equal(startGuide!.text.includes('weight: 10'), false, 'json guide text strips frontmatter');
    const virtualGuide = json.guides?.find((guide) => guide.path === 'guides/virtual.md');
    t.ok(virtualGuide, 'json records virtual guide metadata');
    t.equal(virtualGuide!.href, 'docs/concepts/virtual.html', 'json records virtual guide output href');
    const found = await runCli([
      'doc',
      'search',
      'fixture users'
    ], appDir);
    t.equal(found.result.code, 0, 'doc search exits successfully');
    t.ok(found.stdout.includes('guide:guides/start'), 'sqlite search finds guide pages');
    t.ok(found.stdout.includes('(guide)'), 'sqlite search reports guide kind');
    const sameStemDir = appDir + '/same-stem';
    await ensureDir(fs, sameStemDir);
    await fs.writeFile(sameStemDir + '/jobs.ts', `/**
 * Jobs API module.
 */
export function enqueue(): void {}
`);
    await fs.writeFile(sameStemDir + '/jobs.md', '# Jobs Guide\n\nUse this guide before calling the API.\n');
    await fs.writeFile(sameStemDir + '/notes.md', '# Notes\n\nUnrelated sibling guide.\n');
    const sameStemRun = await runCli([
      'doc',
      'build',
      './same-stem',
      '--format',
      'both',
      '--title',
      'Same Stem Docs'
    ], appDir);
    t.equal(sameStemRun.result.code, 0, 'doc build accepts sibling guide and API files with the same stem');
    t.equal(sameStemRun.stderr, '', 'same-stem doc build does not report a collision');
    t.equal(await exists(fs, docsDir + '/jobs.md'), true, 'same-stem module keeps the stem markdown output');
    t.equal(await exists(fs, docsDir + '/jobs/index.md'), true, 'same-stem guide is moved under a nested index markdown output');
    t.equal(await exists(fs, docsDir + '/jobs.html'), true, 'same-stem module keeps the stem html output');
    t.equal(await exists(fs, docsDir + '/jobs/index.html'), true, 'same-stem guide is moved under a nested index html output');
    const sameStemIndex = await fs.readFile(docsDir + '/index.html');
    t.ok(sameStemIndex.includes('href="jobs/index.html"'), 'sidebar links the nested index guide');
    t.ok(sameStemIndex.includes('<span>Jobs Guide</span>'), 'sidebar labels the nested index guide with its title');
    t.equal(sameStemIndex.includes('docs-sidebar-directory">jobs<'), false, 'sidebar promotes the index guide instead of a bare directory header');
    const collisionDir = appDir + '/collision';
    await ensureDir(fs, collisionDir);
    await fs.writeFile(collisionDir + '/index.ts', `/** Collision module. */
export const collision = true;
`);
    await fs.writeFile(appDir + '/collision.md', '# Collision Guide\n');
    const collisionRun = await runCli([
      'doc',
      'build',
      './collision/index.ts',
      './collision.md',
      '--format',
      'html'
    ], appDir);
    t.notEqual(collisionRun.result.code, 0, 'doc build rejects guide and API output collisions');
    t.ok(collisionRun.stderr.includes('output path collision'), 'collision failure explains the duplicated output path');
  });
  it('renders separate docs and API reference trees for a shared source base', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const sectionDir = appDir + '/section';
    await ensureDir(fs, sectionDir + '/nested');
    await ensureDir(fs, sectionDir + '/net/http');
    await fs.writeFile(sectionDir + '/start.md', `---
weight: 10
---
# Start Here

Begin with this guide.
`);
    await fs.writeFile(sectionDir + '/concepts.md', `---
weight: 20
---
# Concepts

Understand the ideas behind the API.
`);
    await fs.writeFile(sectionDir + '/nested/api.ts', `/** Nested API. */
export function run(): void {}
`);
    await fs.writeFile(sectionDir + '/net/http/guide.md', `---
weight: 30
---
# HTTP

Handle HTTP requests.
`);
    await fs.writeFile(sectionDir + '/net/http/server.ts', `/** HTTP server API. */
export function serve(): void {}
`);
    const run = await runCli([
      'doc',
      'build',
      './section/start.md',
      './section/concepts.md',
      './section/nested/api.ts',
      './section/net/http/guide.md',
      './section/net/http/server.ts',
      '--format',
      'html',
      '--title',
      'Section Docs'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const startHtml = await fs.readFile(docsDir + '/section/start.html');
    t.ok(startHtml.includes('<p class="docs-sidebar-title"><a href="../index.html">Section Docs</a></p>'), 'sidebar title links home using project title');
    t.ok(startHtml.includes('<div class="docs-sidebar-directory">Docs</div>'), 'sidebar renders docs section');
    t.ok(startHtml.includes('<div class="docs-sidebar-directory">API Reference</div>'), 'sidebar renders API reference section');
    t.equal(startHtml.includes('<div class="docs-sidebar-directory">section</div>'), false, 'sidebar renames the shared input base instead of rendering it');
    t.ok(startHtml.includes('href="start.html"'), 'sidebar keeps guide link valid in docs tree');
    t.ok(startHtml.includes('href="nested/api.html"'), 'sidebar keeps nested API link valid in API reference tree');
    t.ok(startHtml.indexOf('href="start.html"') < startHtml.indexOf('href="concepts.html"'), 'docs tree still sorts guides by weight');
    t.ok(startHtml.indexOf('<div class="docs-sidebar-directory">Docs</div>') < startHtml.indexOf('<div class="docs-sidebar-directory">API Reference</div>'), 'docs tree appears before API reference tree');
    t.ok(startHtml.includes('<div class="docs-sidebar-directory">nested</div>'), 'API reference tree keeps directories below the renamed base');
    t.ok(startHtml.includes('<div class="docs-sidebar-directory">net/http</div>'), 'sidebar collapses empty intermediate directories');
    t.equal(startHtml.includes('<div class="docs-sidebar-directory">net</div>'), false, 'sidebar does not render empty parent directory separately');
    t.equal(startHtml.includes('<div class="docs-sidebar-directory">http</div>'), false, 'sidebar does not render empty child directory separately after collapse');
    t.ok(startHtml.includes('href="net/http/guide.html"'), 'collapsed docs directory keeps guide link valid');
    t.ok(startHtml.includes('href="net/http/server.html"'), 'collapsed API directory keeps module link valid');
  });
  it('rejects invalid guide frontmatter', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const invalidDir = appDir + '/invalid-guides';
    await ensureDir(fs, invalidDir);
    await fs.writeFile(invalidDir + '/bad-yaml.md', `---
weight: [
---
# Bad YAML
`);
    await fs.writeFile(invalidDir + '/bad-weight.md', `---
weight: first
---
# Bad Weight
`);
    await fs.writeFile(invalidDir + '/bad-path.md', `---
path: ../escape.md
---
# Bad Path
`);
    const yamlRun = await runCli([
      'doc',
      'build',
      './invalid-guides/bad-yaml.md',
      '--format',
      'html'
    ], appDir);
    t.notEqual(yamlRun.result.code, 0, 'doc build rejects malformed guide frontmatter');
    t.ok(yamlRun.stderr.includes('bad-yaml.md'), 'malformed frontmatter error includes guide path');
    const weightRun = await runCli([
      'doc',
      'build',
      './invalid-guides/bad-weight.md',
      '--format',
      'html'
    ], appDir);
    t.notEqual(weightRun.result.code, 0, 'doc build rejects non-numeric guide weight');
    t.ok(weightRun.stderr.includes('bad-weight.md'), 'invalid weight error includes guide path');
    const pathRun = await runCli([
      'doc',
      'build',
      './invalid-guides/bad-path.md',
      '--format',
      'html'
    ], appDir);
    t.notEqual(pathRun.result.code, 0, 'doc build rejects unsafe virtual guide path');
    t.ok(pathRun.stderr.includes('bad-path.md'), 'invalid virtual path error includes guide path');
  });
  it('documents re-exports from hidden modules and links documented source modules', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      './facade.ts',
      './hidden-source.ts',
      './hidden-star.ts',
      './public-source.ts',
      './public-star.ts',
      '--format',
      'html',
      '--title',
      'Facade Docs'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.equal(await exists(fs, docsDir + '/hidden-source.html'), false, 'internal source module remains hidden by default');
    const facadeHtml = await fs.readFile(docsDir + '/facade.html');
    t.ok(facadeHtml.includes('Hidden class docs copied into public facades.'), 'html inlines class docs from hidden source module');
    t.ok(facadeHtml.includes('Hidden value docs copied with the class.'), 'html inlines members from hidden source module');
    t.ok(facadeHtml.includes('Hidden options docs copied into public facades.'), 'html inlines type docs from hidden source module');
    t.ok(facadeHtml.includes('Hidden star docs copied into public facades.'), 'html inlines star re-exports from hidden source module');
    t.ok(facadeHtml.includes('Star value docs.'), 'html inlines star re-export members from hidden source module');
    t.equal(facadeHtml.includes('privateHelper'), false, 'html does not leak internal source symbols through re-exports');
    t.equal(facadeHtml.includes('privateStar'), false, 'html does not leak internal source symbols through star re-exports');
    t.ok(facadeHtml.includes('Re-exported from <a href="public-source.html#public-source.publicTarget">public-source.publicTarget</a>.'), 'html links re-exports from documented public modules');
    t.ok(facadeHtml.includes('Re-exported from <a href="public-star.html#public-star.PublicStar">public-star.PublicStar</a>.'), 'html links star re-exports from documented public modules');
    t.equal(facadeHtml.includes('Public target docs stay canonical in the source module.'), false, 'html does not duplicate public source docs in the facade');
    t.equal(facadeHtml.includes('Public star docs stay canonical in the source module.'), false, 'html does not duplicate public star docs in the facade');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const facade = json.modules.find((moduleDoc) => moduleDoc.name === 'facade')!;
    const publicSource = json.modules.find((moduleDoc) => moduleDoc.name === 'public-source')!;
    t.ok(facade, 'json includes facade module');
    t.ok(publicSource, 'json includes public source module');
    t.equal(json.modules.some((moduleDoc) => moduleDoc.name === 'hidden-source'), false, 'json excludes hidden source module by default');
    const publicThing = facade.exports.find((item) => item.name === 'PublicThing')!;
    const hiddenOptions = facade.exports.find((item) => item.name === 'HiddenOptions')!;
    const linkedTarget = facade.exports.find((item) => item.name === 'linkedTarget')!;
    const starThing = facade.exports.find((item) => item.name === 'StarThing')!;
    const publicStar = facade.exports.find((item) => item.name === 'PublicStar')!;
    t.ok(publicThing.doc!.text.includes('Hidden class docs copied'), 'json inlines hidden class docs under facade alias');
    t.equal(publicThing.members.some((member) => member.name === 'value'), true, 'json inlines hidden class members under facade alias');
    t.ok(hiddenOptions.doc!.text.includes('Hidden options docs copied'), 'json inlines hidden type docs under facade alias');
    t.ok(starThing.doc!.text.includes('Hidden star docs copied'), 'json inlines hidden star export docs');
    t.equal(linkedTarget.reExport?.mode, 'link', 'json marks public-source re-export as linked');
    t.equal(linkedTarget.reExport?.sourceId, 'public-source.publicTarget', 'json records linked source symbol id');
    t.equal(publicStar.reExport?.mode, 'link', 'json marks public star re-export as linked');
    t.equal(publicStar.reExport?.sourceId, 'public-star.PublicStar', 'json records linked star source symbol id');
    await removeTree(fs, docsDir);
    const privateRun = await runCli([
      'doc',
      'build',
      './facade.ts',
      './hidden-source.ts',
      './hidden-star.ts',
      './public-source.ts',
      './public-star.ts',
      '--format',
      'html',
      '--include-private',
      '--title',
      'Facade Docs'
    ], appDir);
    t.equal(privateRun.result.code, 0, 'private doc build exits successfully');
    const privateFacadeHtml = await fs.readFile(docsDir + '/facade.html');
    t.ok(await exists(fs, docsDir + '/hidden-source.html'), 'include-private emits hidden source page');
    t.ok(privateFacadeHtml.includes('Re-exported from <a href="hidden-source.html#hidden-source.HiddenThing">hidden-source.HiddenThing</a>.'), 'include-private links internal-source re-exports once the source page exists');
    t.equal(privateFacadeHtml.includes('Hidden class docs copied into public facades.'), false, 'include-private does not duplicate hidden source docs in facade');
  });
  it('documents moved web globals without exposing internal import specifiers', async (t) => {
    const repoRoot = cwd();
    const docsDir = repoRoot + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli([
      'doc',
      'build',
      'js/globals/fetch.ts',
      'js/globals/abort.ts',
      'js/globals/blob.ts',
      'js/globals/console.ts',
      'js/globals/crypto.ts',
      'js/globals/encoding.ts',
      'js/globals/eventtarget.ts',
      'js/globals/eventsource.ts',
      'js/globals/formdata.ts',
      'js/globals/messaging.ts',
      'js/globals/url.ts',
      'js/globals/websocket.ts',
      'js/globals/webtransport.ts',
      'js/net/http/websocket.ts',
      'js/net/http/webtransport.ts',
      'js/internal/tty/bindings.ts',
      '--format',
      'markdown',
      '--title',
      'Globals Docs'
    ], repoRoot);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const fetchModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/fetch.ts');
    const abortModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/abort.ts');
    const blobModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/blob.ts');
    const consoleModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/console.ts');
    const cryptoModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/crypto.ts');
    const encodingModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/encoding.ts');
    const eventTargetModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/eventtarget.ts');
    const eventSourceModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/eventsource.ts');
    const formDataModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/formdata.ts');
    const messagingModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/messaging.ts');
    const urlModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/url.ts');
    const webSocketModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/websocket.ts');
    const webTransportModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/webtransport.ts');
    const httpWebSocketModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/net/http/websocket.ts');
    const httpWebTransportModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/net/http/webtransport.ts');
    t.ok(fetchModule, 'moved fetch globals module is documented by default');
    t.ok(abortModule, 'abort globals module is documented by default');
    t.ok(blobModule, 'blob globals module is documented by default');
    t.ok(consoleModule, 'console globals module is documented by default');
    t.ok(cryptoModule, 'crypto globals module is documented by default');
    t.ok(encodingModule, 'encoding globals module is documented by default');
    t.ok(eventTargetModule, 'eventtarget globals module is documented by default');
    t.ok(eventSourceModule, 'eventsource globals module is documented by default');
    t.ok(formDataModule, 'formdata globals module is documented by default');
    t.ok(messagingModule, 'messaging globals module is documented by default');
    t.ok(urlModule, 'url globals module is documented by default');
    t.ok(webSocketModule, 'websocket globals module is documented by default');
    t.ok(webTransportModule, 'webtransport globals module is documented by default');
    t.ok(httpWebSocketModule, 'http websocket module is documented by default');
    t.ok(httpWebTransportModule, 'http webtransport module is documented by default');
    t.ok(fetchModule!.exports.some((item) => item.name === 'FetchInit'), 'fetch globals include FetchInit export');
    t.equal(fetchModule!.exports.some((item) => item.name === 'fetchLater'), false, 'fetch globals do not export fetchLater');
    t.equal(fetchModule!.exports.some((item) => item.name === 'FetchLaterResult'), false, 'fetch globals do not export FetchLaterResult');
    t.ok(abortModule!.exports.some((item) => item.name === 'AbortSignal'), 'abort globals include AbortSignal export');
    t.ok(abortModule!.exports.some((item) => item.name === 'AbortController'), 'abort globals include AbortController export');
    for (const name of [
      'BlobPart',
      'BlobOptions',
      'FileOptions',
      'FileReaderHandler'
    ]) {
      t.ok(blobModule!.exports.some((item) => item.name === name), `blob globals include ${name} export`);
    }
    t.ok(consoleModule!.exports.some((item) => item.name === 'Console'), 'console globals include Console export');
    t.equal(consoleModule!.exports.some((item) => item.name === 'ConsoleCaptureRecord'), false, 'console capture records stay internal');
    t.equal(consoleModule!.exports.some((item) => item.name === 'ConsoleCaptureSink'), false, 'console capture sinks stay internal');
    for (const name of [
      'Crypto',
      'SubtleCrypto',
      'CryptoKey',
      'KeyAlgorithm',
      'KeyFormat',
      'KeyUsage',
      'BufferSource'
    ]) {
      t.ok(cryptoModule!.exports.some((item) => item.name === name), `crypto globals include ${name} export`);
    }
    t.equal(encodingModule!.exports.some((item) => item.name === 'encodeUtf8'), false, 'encoding globals do not export encodeUtf8');
    t.equal(encodingModule!.exports.some((item) => item.name === 'decodeUtf8'), false, 'encoding globals do not export decodeUtf8');
    for (const name of ['AddEventListenerOptions', 'EventCallback']) {
      t.ok(eventTargetModule!.exports.some((item) => item.name === name), `eventtarget globals include ${name} export`);
    }
    t.ok(formDataModule!.exports.some((item) => item.name === 'FormData'), 'formdata globals include FormData export');
    t.ok(formDataModule!.exports.some((item) => item.name === 'FormDataEntryValue'), 'formdata globals include FormDataEntryValue export');
    t.equal(formDataModule!.exports.some((item) => item.name === '_createMultipartBoundary'), false, 'formdata globals do not export multipart boundary helper');
    for (const name of [
      'MessageEvent',
      'MessagePort',
      'MessageChannel'
    ]) {
      t.ok(messagingModule!.exports.some((item) => item.name === name), `messaging globals include ${name} export`);
    }
    t.equal(messagingModule!.exports.some((item) => item.name === 'ThreadPort'), false, 'messaging globals do not export ThreadPort');
    t.equal(messagingModule!.exports.some((item) => item.name === 'BaseTransportPort'), false, 'messaging globals do not export BaseTransportPort');
    t.ok(urlModule!.exports.some((item) => item.name === 'URL'), 'url globals include URL export');
    t.ok(urlModule!.exports.some((item) => item.name === 'URLSearchParams'), 'url globals include URLSearchParams export');
    for (const name of [
      'WebSocket',
      'CloseEvent',
      'ErrorEvent',
      'MessageEvent'
    ]) {
      t.ok(webSocketModule!.exports.some((item) => item.name === name), `websocket globals include ${name} export`);
    }
    for (const name of [
      'WebSocketConnection',
      'WebSocketAcceptOptions',
      'WebSocketConnectOptions',
      'WebSocketError'
    ]) {
      t.equal(webSocketModule!.exports.some((item) => item.name === name), false, `websocket globals do not export ${name}`);
    }
    for (const name of [
      'WebSocketConnection',
      'WebSocketAcceptOptions',
      'WebSocketConnectOptions',
      'WebSocketError'
    ]) {
      t.ok(httpWebSocketModule!.exports.some((item) => item.name === name), `http websocket module exports ${name}`);
    }
    for (const name of [
      'WebTransport',
      'WebTransportDatagramDuplexStream',
      'WebTransportOptions'
    ]) {
      t.ok(webTransportModule!.exports.some((item) => item.name === name), `webtransport globals include ${name} export`);
    }
    for (const name of [
      'Http3WebTransportInit',
      '_fromHttp3WebTransport',
      '_acceptIncomingQuicWebTransportStream'
    ]) {
      t.equal(webTransportModule!.exports.some((item) => item.name === name), false, `webtransport globals do not export ${name}`);
    }
    t.ok(httpWebTransportModule!.exports.some((item) => item.name === 'WebTransport'), 'http webtransport module exports WebTransport');
    t.equal(json.modules.some((moduleDoc) => moduleDoc.path === 'js/internal/tty/bindings.ts'), false, 'internal tty bindings module is hidden by default');
    const markdown = await fs.readFile(docsDir + '/js/globals/fetch.md');
    const abortMarkdown = await fs.readFile(docsDir + '/js/globals/abort.md');
    const blobMarkdown = await fs.readFile(docsDir + '/js/globals/blob.md');
    const consoleMarkdown = await fs.readFile(docsDir + '/js/globals/console.md');
    const cryptoMarkdown = await fs.readFile(docsDir + '/js/globals/crypto.md');
    const encodingMarkdown = await fs.readFile(docsDir + '/js/globals/encoding.md');
    const eventTargetMarkdown = await fs.readFile(docsDir + '/js/globals/eventtarget.md');
    const eventSourceMarkdown = await fs.readFile(docsDir + '/js/globals/eventsource.md');
    const formDataMarkdown = await fs.readFile(docsDir + '/js/globals/formdata.md');
    const messagingMarkdown = await fs.readFile(docsDir + '/js/globals/messaging.md');
    const urlMarkdown = await fs.readFile(docsDir + '/js/globals/url.md');
    const webSocketMarkdown = await fs.readFile(docsDir + '/js/globals/websocket.md');
    const webTransportMarkdown = await fs.readFile(docsDir + '/js/globals/webtransport.md');
    t.equal(markdown.includes('internal:globals/'), false, 'generated module docs do not advertise internal globals specifiers');
    t.ok(markdown.includes('## FetchInit'), 'fetch markdown includes FetchInit');
    t.equal(markdown.includes('fetchLater'), false, 'fetch markdown omits fetchLater');
    t.equal(markdown.includes('FetchLaterResult'), false, 'fetch markdown omits FetchLaterResult');
    t.equal(abortMarkdown.includes('No exported declarations found.'), false, 'abort globals page includes public exports');
    t.ok(abortMarkdown.includes('## AbortSignal'), 'abort markdown includes AbortSignal');
    t.ok(abortMarkdown.includes('## AbortController'), 'abort markdown includes AbortController');
    t.equal(blobMarkdown.includes('No exported declarations found.'), false, 'blob globals page includes public exports');
    for (const name of [
      'BlobPart',
      'BlobOptions',
      'FileOptions',
      'FileReaderHandler'
    ]) {
      t.ok(blobMarkdown.includes(`## ${name}`), `blob markdown includes ${name}`);
    }
    t.equal(consoleMarkdown.includes('No exported declarations found.'), false, 'console globals page includes public exports');
    t.ok(consoleMarkdown.includes('## Console'), 'console markdown includes Console');
    t.ok(consoleMarkdown.includes('### log'), 'console markdown includes log method docs');
    t.ok(consoleMarkdown.includes('### timeEnd'), 'console markdown includes timer method docs');
    t.equal(consoleMarkdown.includes('internal:globals/'), false, 'console markdown does not advertise internal globals specifiers');
    t.equal(consoleMarkdown.includes('## Contributing'), false, 'console markdown omits contributor notes');
    t.equal(consoleMarkdown.includes('ConsoleCaptureRecord'), false, 'console markdown hides internal capture records');
    t.equal(cryptoMarkdown.includes('No exported declarations found.'), false, 'crypto globals page includes public exports');
    t.ok(cryptoMarkdown.includes('## Crypto'), 'crypto markdown includes Crypto interface');
    t.ok(cryptoMarkdown.includes('## SubtleCrypto'), 'crypto markdown includes SubtleCrypto interface');
    t.ok(cryptoMarkdown.includes('## CryptoKey'), 'crypto markdown includes CryptoKey');
    t.ok(cryptoMarkdown.includes('### digest'), 'crypto markdown includes subtle digest docs');
    t.ok(cryptoMarkdown.includes('### getRandomValues'), 'crypto markdown includes getRandomValues docs');
    t.equal(encodingMarkdown.includes('## encodeUtf8'), false, 'encoding markdown omits internal encodeUtf8 helper');
    t.equal(encodingMarkdown.includes('## decodeUtf8'), false, 'encoding markdown omits internal decodeUtf8 helper');
    t.ok(eventTargetMarkdown.includes('## AddEventListenerOptions'), 'eventtarget markdown includes AddEventListenerOptions');
    t.ok(eventTargetMarkdown.includes('## EventCallback'), 'eventtarget markdown includes EventCallback');
    t.equal(eventSourceMarkdown.includes('EventSourceReader'), false, 'eventsource globals markdown omits eventstream reader docs');
    t.equal(eventSourceMarkdown.includes('EventSourceWriter'), false, 'eventsource globals markdown omits eventstream writer docs');
    t.ok(formDataMarkdown.includes('## FormData'), 'formdata markdown includes FormData');
    t.ok(formDataMarkdown.includes('## FormDataEntryValue'), 'formdata markdown includes FormDataEntryValue');
    t.equal(formDataMarkdown.includes('_createMultipartBoundary'), false, 'formdata markdown hides multipart boundary helper');
    t.ok(messagingMarkdown.includes('## MessagePort'), 'messaging markdown includes MessagePort');
    t.ok(messagingMarkdown.includes('## MessageChannel'), 'messaging markdown includes MessageChannel');
    t.equal(messagingMarkdown.includes('## ThreadPort'), false, 'messaging markdown omits ThreadPort');
    t.equal(messagingMarkdown.includes('## BaseTransportPort'), false, 'messaging markdown omits BaseTransportPort');
    t.ok(urlMarkdown.includes('## URL'), 'url markdown includes URL');
    t.ok(urlMarkdown.includes('## URLSearchParams'), 'url markdown includes URLSearchParams');
    t.ok(webSocketMarkdown.includes('## WebSocket'), 'websocket markdown includes WebSocket');
    t.ok(webSocketMarkdown.includes('## CloseEvent'), 'websocket markdown includes CloseEvent');
    t.ok(webSocketMarkdown.includes('## ErrorEvent'), 'websocket markdown includes ErrorEvent');
    for (const name of [
      'WebSocketConnection',
      'WebSocketAcceptOptions',
      'WebSocketConnectOptions',
      'WebSocketError'
    ]) {
      t.equal(webSocketMarkdown.includes(`## ${name}`), false, `websocket markdown omits ${name}`);
    }
    t.ok(webTransportMarkdown.includes('## WebTransport'), 'webtransport markdown includes WebTransport');
    t.ok(webTransportMarkdown.includes('## WebTransportDatagramDuplexStream'), 'webtransport markdown includes datagram constructor');
    for (const name of [
      'Http3WebTransportInit',
      '_fromHttp3WebTransport',
      '_acceptIncomingQuicWebTransportStream',
      '_fromHttp3',
      '_acceptIncomingQuicStream',
      '_push',
      '_close',
      '_error',
      '_stats'
    ]) {
      t.equal(webTransportMarkdown.includes(name), false, `webtransport markdown omits ${name}`);
    }
    t.equal(await exists(fs, docsDir + '/js/internal/tty/bindings.md'), false, 'internal tty bindings markdown is not emitted by default');
    await removeTree(fs, docsDir);
  });
  it('links OpenTelemetry facade re-exports from public signal modules', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/opentelemetry');
    await ensureDir(fs, appDir + '/internal/opentelemetry');
    await fs.writeFile(appDir + '/opentelemetry.ts', `/**
 * OpenTelemetry facade docs.
 */

export { getTracerProvider, Span } from './opentelemetry/traces.ts';
export { getMeterProvider, Counter } from './opentelemetry/metrics.ts';
export { getLoggerProvider, SeverityNumber } from './opentelemetry/logs.ts';
export { OtelSDK, InMemoryExporter } from './opentelemetry/sdk.ts';
`);
    await fs.writeFile(appDir + '/opentelemetry/traces.ts', `/**
 * Trace signal docs.
 */

/**
 * Detailed span docs should stay on the traces page.
 */
export class Span {}

/**
 * Detailed tracer provider docs should stay on the traces page.
 */
export function getTracerProvider(): unknown {
  return {};
}
`);
    await fs.writeFile(appDir + '/opentelemetry/metrics.ts', `/**
 * Metric signal docs.
 */

/**
 * Detailed counter docs should stay on the metrics page.
 */
export class Counter {}

/**
 * Detailed meter provider docs should stay on the metrics page.
 */
export function getMeterProvider(): unknown {
  return {};
}
`);
    await fs.writeFile(appDir + '/opentelemetry/logs.ts', `/**
 * Log signal docs.
 */

/**
 * Detailed severity docs should stay on the logs page.
 */
export enum SeverityNumber {
  INFO = 9,
}

/**
 * Detailed logger provider docs should stay on the logs page.
 */
export function getLoggerProvider(): unknown {
  return {};
}
`);
    await fs.writeFile(appDir + '/opentelemetry/sdk.ts', `/**
 * SDK docs.
 */

/**
 * Detailed SDK docs should stay on the sdk page.
 */
export class OtelSDK {}

/**
 * Detailed exporter docs should stay on the sdk page.
 */
export class InMemoryExporter {}
`);
    await fs.writeFile(appDir + '/internal/opentelemetry/traces.ts', `/**
 * Internal trace source.
 *
 * @internal
 */
export const internalTrace = true;
`);
    await fs.writeFile(appDir + '/internal/opentelemetry/metrics.ts', `/**
 * Internal metric source.
 *
 * @internal
 */
export const internalMetric = true;
`);
    await fs.writeFile(appDir + '/internal/opentelemetry/logs.ts', `/**
 * Internal log source.
 *
 * @internal
 */
export const internalLog = true;
`);
    await fs.writeFile(appDir + '/internal/opentelemetry/sdk.ts', `/**
 * Internal SDK source.
 *
 * @internal
 */
export const internalSdk = true;
`);
    const run = await runCli([
      'doc',
      'build',
      './opentelemetry.ts',
      './opentelemetry/traces.ts',
      './opentelemetry/metrics.ts',
      './opentelemetry/logs.ts',
      './opentelemetry/sdk.ts',
      './internal/opentelemetry/traces.ts',
      './internal/opentelemetry/metrics.ts',
      './internal/opentelemetry/logs.ts',
      './internal/opentelemetry/sdk.ts',
      '--format',
      'html',
      '--title',
      'OpenTelemetry Docs'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(await exists(fs, docsDir + '/opentelemetry/traces.html'), 'traces page is emitted');
    t.ok(await exists(fs, docsDir + '/opentelemetry/metrics.html'), 'metrics page is emitted');
    t.ok(await exists(fs, docsDir + '/opentelemetry/logs.html'), 'logs page is emitted');
    t.ok(await exists(fs, docsDir + '/opentelemetry/sdk.html'), 'sdk page is emitted');
    const facadeHtml = await fs.readFile(docsDir + '/opentelemetry.html');
    t.ok(facadeHtml.includes('Re-exported from <a href="opentelemetry/traces.html#opentelemetry-traces.Span">opentelemetry/traces.Span</a>.'), 'root links trace class re-export');
    t.ok(facadeHtml.includes('Re-exported from <a href="opentelemetry/metrics.html#opentelemetry-metrics.Counter">opentelemetry/metrics.Counter</a>.'), 'root links metric class re-export');
    t.ok(facadeHtml.includes('Re-exported from <a href="opentelemetry/logs.html#opentelemetry-logs.SeverityNumber">opentelemetry/logs.SeverityNumber</a>.'), 'root links log enum re-export');
    t.ok(facadeHtml.includes('Re-exported from <a href="opentelemetry/sdk.html#opentelemetry-sdk.OtelSDK">opentelemetry/sdk.OtelSDK</a>.'), 'root links sdk class re-export');
    t.equal(facadeHtml.includes('Detailed span docs should stay on the traces page.'), false, 'root does not inline trace detail docs');
    t.equal(facadeHtml.includes('Detailed counter docs should stay on the metrics page.'), false, 'root does not inline metric detail docs');
    t.equal(facadeHtml.includes('Detailed severity docs should stay on the logs page.'), false, 'root does not inline log detail docs');
    t.equal(facadeHtml.includes('Detailed SDK docs should stay on the sdk page.'), false, 'root does not inline sdk detail docs');
  });
  it('documents exported object literal members and cleans stale output', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, docsDir);
    await fs.writeFile(docsDir + '/stale.html', '<p>old docs</p>');
    const run = await runCli([
      'doc',
      'build',
      './surface.ts',
      '--format',
      'both',
      '--title',
      'Surface API'
    ], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.equal(await exists(fs, docsDir + '/stale.html'), false, 'doc build removes stale generated html');
    const html = await fs.readFile(docsDir + '/surface.html');
    t.ok(html.includes('<ul>'), 'html renders markdown list from module comment');
    t.ok(html.includes('<li>surface.run(input)</li>'), 'html keeps module call list readable');
    t.ok(html.includes('<h3><code><span class="tok-keyword">const</span> surface</code></h3>'), 'html renders exported object signature without export prefix');
    t.ok(html.includes('id="surface.surface.run"'), 'html documents exported object method');
    t.ok(html.includes('run(input: <span class="tok-keyword">string</span>): <span class="tok-keyword">string</span>'), 'html renders object method type signature');
    t.ok(html.includes('configure(options: {\n  enabled: <span class="tok-keyword">boolean</span>;\n}): {\n  enabled: <span class="tok-keyword">boolean</span>;\n}'), 'html formats object type annotations in object method signatures');
    t.ok(html.includes('Run with a string input.'), 'html includes object method docs');
    t.ok(html.includes('id="surface.surface.nested.ping"'), 'html follows exported object references to local object members');
    t.ok(html.includes('Ping a named target.'), 'html includes nested object member docs');
    t.equal(html.includes('localHelper'), false, 'html excludes unexported local helpers');
    t.equal(html.includes('<span class="tok-keyword">export</span>'), false, 'html omits redundant export prefix');
    t.equal(html.includes('Propertys'), false, 'html uses grammatical group labels');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const moduleDoc = json.modules[0]!;
    const surface = moduleDoc.exports.find((item: DocJsonExport) => item.name === 'surface')!;
    t.ok(surface, 'json includes exported object');
    t.equal(moduleDoc.path, 'surface.ts', 'json stores project-relative module path');
    t.equal(surface.signature, 'const surface', 'json signature omits export prefix');
    t.equal(surface.members.some((member) => member.name === 'run' && member.kind === 'method'), true, 'json includes exported object method');
    t.equal(surface.members.some((member) => member.name === 'configure' && member.signature === 'configure(options: {\n  enabled: boolean;\n}): {\n  enabled: boolean;\n}'), true, 'json formats object type annotations in object method signature');
    t.equal(surface.members.some((member) => member.name === 'nested.ping'), true, 'json includes nested referenced object method');
    t.equal(moduleDoc.exports.some((item) => item.name === 'localHelper'), false, 'json excludes unexported local helper');
    const mode = moduleDoc.exports.find((item: DocJsonExport) => item.name === 'Mode')!;
    t.ok(mode, 'json includes exported enum');
    t.equal(mode.signature!.includes('export function afterEnum'), false, 'enum signature stops before following exports');
    t.ok(mode.signature!.includes('\n'), 'json records formatted multiline enum signature');
    t.equal(mode.signature!.includes('Internal enum member docs'), false, 'json strips comments from enum signatures');
    const found = await runCli([
      'doc',
      'search',
      'nested ping'
    ], appDir);
    t.equal(found.stderr, '', 'doc search writes no stderr');
    t.equal(found.result.code, 0, 'doc search exits successfully');
    t.ok(found.stdout.includes('surface.surface.nested.ping'), 'search finds nested exported object member');
    t.equal(found.stdout.includes('export const'), false, 'search signatures omit export prefix');
  });
  it('runs examples from documentation comments', async (t) => {
    const run = await runCliProcess([
      'doc',
      'test',
      './examples.ts'
    ], appDir);
    t.equal(run.result.code, 0, 'doc test exits successfully');
    t.equal(run.stderr, '', 'doc test writes no stderr');
    t.ok(run.stdout.includes('4 passed'), 'doc test runs non-ignored examples');
    t.ok(run.stdout.includes('1 ignored'), 'doc test reports ignored examples');
  });
});
