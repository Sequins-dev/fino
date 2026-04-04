/**
 * Integration tests for `fino doc`.
 */

import { after, before, describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process, execPath } from 'fino:runtime/process';

const TEST_DIR = '/tmp/fino-doc-test-' + Math.floor(Math.random() * 1_000_000);

interface DocJsonMember {
  name: string;
}

interface DocJsonExport extends DocJsonMember {
  signature?: string;
  members: DocJsonMember[];
}

interface DocJsonModule {
  name: string;
  doc: { text: string };
  exports: DocJsonExport[];
}

interface DocJsonOutput {
  modules: DocJsonModule[];
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

async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; result: Awaited<ReturnType<Process['wait']>> }> {
  const proc = new Process(execPath, args, { cwd });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return { stdout, stderr, result };
}

describe('fino doc', () => {
  let fs: DiskFileSystem;
  let appDir: string;

  before(async () => {
    fs = new DiskFileSystem();
    await ensureDir(fs, TEST_DIR);
    appDir = TEST_DIR + '/app';
    await ensureDir(fs, appDir);
    await fs.writeFile(appDir + '/api.mts', `/**
 * Example API module.
 *
 * This module demonstrates generated API docs.
 */

/**
 * Add two numbers together.
 *
 * @param a Left operand.
 * @param b Right operand.
 * @returns The numeric sum.
 */
export function add(a: number, b: number): number {
  return a + b;
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
`);
  });

  after(async () => {
    await removeTree(fs, TEST_DIR);
  });

  it('writes markdown and json docs for exported declarations', async (t) => {
    const outDir = appDir + '/docs';
    const jsonPath = outDir + '/api.json';
    const run = await runCli(['doc', './api.mts', '--out', outDir, '--json', jsonPath], appDir);

    t.equal(run.result.code, 0, 'doc exits successfully');
    t.equal(run.stderr, '', 'doc writes no stderr');
    t.ok(run.stdout.includes('Wrote'), 'doc reports generated files');

    const markdown = await fs.readFile(outDir + '/api.md');
    t.ok(markdown.includes('# api'), 'markdown includes module heading');
    t.ok(markdown.includes('Example API module.'), 'markdown includes module prelude');
    t.ok(markdown.includes('## add'), 'markdown includes function section');
    t.ok(markdown.includes('```ts\nexport function add(a: number, b: number): number\n```'), 'markdown includes typed function signature');
    t.ok(markdown.includes('@param `a` Left operand.'), 'markdown includes param tag');
    t.ok(markdown.includes('## ApiResponse'), 'markdown includes interface section');
    t.ok(markdown.includes('### ok'), 'markdown includes interface member section');
    t.ok(markdown.includes('```ts\nok: boolean\n```'), 'markdown includes member signature');
    t.ok(markdown.includes('## SecretBox'), 'markdown includes class section');
    t.ok(markdown.includes('### id'), 'markdown includes public class property');
    t.ok(markdown.includes('### value'), 'markdown includes public class method');
    t.ok(!markdown.includes('### #token'), 'markdown excludes private class property');
    t.ok(!markdown.includes('### #peek'), 'markdown excludes private class method');
    t.ok(markdown.includes('## VERSION'), 'markdown includes const section');

    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const firstModule = json.modules[0]!;
    const firstExport = firstModule.exports[0]!;
    t.equal(json.modules.length, 1, 'json includes one module');
    t.equal(firstModule.name, 'api', 'json records module name');
    t.equal(firstModule.doc.text.includes('Example API module.'), true, 'json records module prelude');
    t.equal(firstModule.exports.length, 4, 'json includes exported declarations');
    t.equal(firstExport.name, 'add', 'json records function export');
    t.equal(firstExport.signature, 'export function add(a: number, b: number): number', 'json records function signature');
    const secretBox = firstModule.exports.find((item: DocJsonExport) => item.name === 'SecretBox');
    t.ok(secretBox, 'json includes class export');
    t.equal(secretBox!.members.some((item: DocJsonMember) => item.name === '#token'), false, 'json excludes private class property');
    t.equal(secretBox!.members.some((item: DocJsonMember) => item.name === '#peek'), false, 'json excludes private class method');
  });
});
