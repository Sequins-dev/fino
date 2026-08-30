/** Shared fixture construction and helpers for `fino doc` integration tests. */
import { DiskFileSystem } from 'fino:file';
import { chdir, cwd, execPath, Process } from 'fino:process';
import rootCommand from 'internal:commands/root';
export const TEST_DIR = '/tmp/fino-doc-test-' + Math.floor(Math.random() * 1e6);
export const REPO_DIR = cwd();
export interface DocJsonMember {
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
export interface DocJsonExport extends DocJsonMember {
  signature?: string;
  members: DocJsonMember[];
}
export interface DocJsonModule {
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
export interface DocJsonGuide {
  title: string;
  path: string;
  href: string;
  summary: string;
  text: string;
  weight?: number;
}
export interface DocJsonOutput {
  modules: DocJsonModule[];
  guides?: DocJsonGuide[];
}
function decodeUtf8(b: ArrayBuffer | ArrayBufferView): string {
  return new TextDecoder().decode(b);
}
async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  return decodeUtf8(
    chunks.reduce((acc: Uint8Array, c: Uint8Array) => {
      const merged = new Uint8Array(acc.byteLength + c.byteLength);
      merged.set(acc);
      merged.set(c, acc.byteLength);
      return merged;
    }, new Uint8Array(0)),
  );
}
export async function exists(fs: DiskFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (_) {
    return false;
  }
}
export async function ensureDir(fs: DiskFileSystem, path: string): Promise<void> {
  if (path === '.' || path === '/' || path.length === 0) return;
  if (await exists(fs, path)) return;
  const idx = path.lastIndexOf('/');
  const parent = idx <= 0 ? '.' : path.slice(0, idx);
  await ensureDir(fs, parent);
  await fs.mkdir(path);
}
export async function removeTree(fs: DiskFileSystem, path: string): Promise<void> {
  if (!(await exists(fs, path))) return;
  const entry = await fs.entry(path);
  if (entry.isDirectory()) {
    const dir = await fs.dir(path);
    for (const child of await dir.entries()) await removeTree(fs, child.path.toString());
    await fs.rmdir(path);
    return;
  }
  await fs.unlink(path);
}
export async function runCli(
  args: string[],
  nextCwd: string,
): Promise<{
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
        signal: null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: message + '\n',
      result: {
        code: 1,
        signal: null,
      },
    };
  } finally {
    chdir(previousCwd);
  }
}
export async function runCliProcess(
  args: string[],
  cwd: string,
): Promise<{
  stdout: string;
  stderr: string;
  result: Awaited<ReturnType<Process['wait']>>;
}> {
  const proc = new Process(execPath, args, { cwd });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return {
    stdout,
    stderr,
    result,
  };
}

export interface DocTestFixture {
  fs: DiskFileSystem;
  appDir: string;
  testDir: string;
}

export async function createDocTestFixture(): Promise<DocTestFixture> {
  const fs = new DiskFileSystem();
  const rawReadFile = fs.readFile.bind(fs);
  const rawWriteFile = fs.writeFile.bind(fs);
  fs.readFile = (async (path: string) =>
    new TextDecoder().decode(await rawReadFile(path))) as never;
  fs.writeFile = (async (
    path: string,
    data: string | Uint8Array | ArrayBuffer | ArrayBufferView,
  ) => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await rawWriteFile(path, bytes);
  }) as never;
  await ensureDir(fs, TEST_DIR);
  const appDir = TEST_DIR + '/app';
  await ensureDir(fs, appDir);
  await fs.writeFile(
    appDir + '/README.md',
    `# Fixture API

This README becomes the documentation home page.

![Fixture logo](./logo.svg)

[Project guide](./guides/start.md)

- It should render Markdown lists.
- It should leave the module index to the sidebar.
`,
  );
  await fs.writeFile(
    appDir + '/logo.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"><title>Fixture logo</title></svg>\n',
  );
  await fs.writeFile(
    appDir + '/package.json',
    JSON.stringify(
      {
        name: 'fixture-project',
        version: '1.0.0',
      },
      null,
      2,
    ) + '\n',
  );
  await ensureDir(fs, appDir + '/guides');
  await fs.writeFile(
    appDir + '/guides/start.md',
    `---
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
`,
  );
  await fs.writeFile(
    appDir + '/guides/advanced.md',
    `---
weight: 20
---
# Advanced Guide

Advanced workflows use [ResourceBox](../advanced.ts#ResourceBox) and return to [getting started](./start.md).

Use this guide when examples need more intent than API references.
`,
  );
  await fs.writeFile(
    appDir + '/guides/virtual.md',
    `---
path: docs/concepts/virtual.md
weight: 15
---
# Virtual Guide

This guide keeps its source file in guides but appears under docs concepts.
`,
  );
  await fs.writeFile(
    appDir + '/api.ts',
    `/**
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
`,
  );
  await fs.writeFile(
    appDir + '/advanced.ts',
    `/**
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
`,
  );
  await fs.writeFile(
    appDir + '/private-stubs.ts',
    `/**
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
`,
  );
  await fs.writeFile(
    appDir + '/examples.ts',
    `/**
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
`,
  );
  await ensureDir(fs, appDir + '/pkg');
  await fs.writeFile(
    appDir + '/pkg/index.ts',
    `/**
 * Package index docs.
 */

/**
 * Package entrypoint value.
 */
export const pkgName: string = 'pkg';
`,
  );
  await ensureDir(fs, appDir + '/alpha');
  await ensureDir(fs, appDir + '/beta');
  await fs.writeFile(
    appDir + '/alpha/client.ts',
    `/**
 * Alpha client docs.
 */
export interface Client {
  /**
   * Alpha client name.
   */
  name: string;
}
`,
  );
  await fs.writeFile(
    appDir + '/alpha/guide.md',
    `# Alpha Guide

Use this guide before opening the [client API](./client.ts#Client).
`,
  );
  await fs.writeFile(
    appDir + '/beta/client.ts',
    `/**
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
`,
  );
  await fs.writeFile(
    appDir + '/internal-only.ts',
    `/**
 * Internal-only module docs.
 *
 * @internal
 */
export function hiddenApi(): string {
  return 'hidden';
}
`,
  );
  await fs.writeFile(
    appDir + '/hidden-source.ts',
    `/**
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
`,
  );
  await fs.writeFile(
    appDir + '/public-source.ts',
    `/**
 * Public re-export source.
 */

/**
 * Public target docs stay canonical in the source module.
 */
export function publicTarget(input: string): string {
  return input;
}
`,
  );
  await fs.writeFile(
    appDir + '/hidden-star.ts',
    `/**
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
`,
  );
  await fs.writeFile(
    appDir + '/public-star.ts',
    `/**
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
`,
  );
  await fs.writeFile(
    appDir + '/facade.ts',
    `/**
 * Public facade docs.
 */

export { HiddenThing as PublicThing, type HiddenOptions } from './hidden-source.ts';
export { publicTarget as linkedTarget } from './public-source.ts';
export * from './hidden-star.ts';
export * from './public-star.ts';
`,
  );
  await fs.writeFile(
    appDir + '/surface.ts',
    `/**
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
`,
  );
  return { fs, appDir, testDir: TEST_DIR };
}

export async function removeDocTestFixture(fixture: DocTestFixture): Promise<void> {
  await removeTree(fixture.fs, fixture.testDir);
}
