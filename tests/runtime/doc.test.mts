/**
 * Integration tests for `fino doc`.
 */

import { after, before, describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process, execPath } from 'fino:runtime/process';
import { sqliteAvailable } from 'fino:sqlite';

const TEST_DIR = '/tmp/fino-doc-test-' + Math.floor(Math.random() * 1_000_000);

interface DocJsonMember {
  name: string;
  id?: string;
  kind?: string;
  signatures?: string[];
  doc?: { text: string; blocks?: Array<{ kind: string; [key: string]: unknown }> };
}

interface DocJsonExport extends DocJsonMember {
  signature?: string;
  members: DocJsonMember[];
}

interface DocJsonModule {
  name: string;
  id?: string;
  sourceModule?: string;
  doc: { text: string; blocks?: Array<{ kind: string; [key: string]: unknown }> };
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
    await fs.writeFile(appDir + '/advanced.mts', `/**
 * Advanced module docs.
 *
 * Use **advanced** resources with the \`ResourceBox\` helper.
 *
 * # Overview
 *
 * See [ResourceBox][box], [the name getter](#ResourceBox.name), and https://example.test/docs.
 * [box]: ./advanced.mts#ResourceBox
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
   * Hidden implementation detail.
   */
  private internalOnly(): void {}
}
`);
    await fs.writeFile(appDir + '/examples.mts', `/**
 * Example helper.
 *
 * \`\`\`ts
 * # const hidden = 41;
 * if (hidden + 1 !== 42) throw new Error('bad math');
 * \`\`\`
 *
 * \`\`\`ts ignore
 * throw new Error('ignored');
 * \`\`\`
 *
 * \`\`\`ts throws
 * throw new Error('expected');
 * \`\`\`
 */
export function helper(): number {
  return 42;
}
`);
    await ensureDir(fs, appDir + '/pkg');
    await fs.writeFile(appDir + '/pkg/index.mts', `/**
 * Package index docs.
 */

/**
 * Package entrypoint value.
 */
export const pkgName: string = 'pkg';
`);
  });

  after(async () => {
    await removeTree(fs, TEST_DIR);
  });

  it('writes markdown and json docs for exported declarations', async (t) => {
    const outDir = appDir + '/docs';
    const jsonPath = outDir + '/api.json';
    await removeTree(fs, outDir);
    const run = await runCli(['doc', './api.mts'], appDir);

    t.equal(run.result.code, 0, 'doc exits successfully');
    t.equal(run.stderr, '', 'doc writes no stderr');
    t.ok(run.stdout.includes('Wrote'), 'doc reports generated files');

    const markdown = await fs.readFile(outDir + '/api.md');
    t.ok(markdown.includes('# api'), 'markdown includes module heading');
    t.ok(markdown.includes('Example API module.'), 'markdown includes module prelude');
    t.ok(markdown.includes('## add'), 'markdown includes function section');
    t.ok(markdown.includes('```ts\nexport function add(a: number, b: number): number\n```'), 'markdown includes typed function signature');
    t.ok(!markdown.includes('@param'), 'markdown omits directive tags');
    t.ok(!markdown.includes('@returns'), 'markdown omits return directive tags');
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

  it('builds v2 json, html, and sqlite search artifacts', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    const dbPath = docsDir + '/docs.db';
    await removeTree(fs, docsDir);
    const run = await runCli(['doc', 'build', './advanced.mts', '--format', 'both', '--title', 'Advanced API'], appDir);

    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/advanced.md'), 'doc build reports markdown');
    t.ok(run.stdout.includes('/docs/advanced.html'), 'doc build reports html');
    t.ok(run.stdout.includes('/docs/docs.db'), 'doc build reports sqlite index');

    const html = await fs.readFile(docsDir + '/advanced.html');
    t.ok(html.includes('<title>Advanced API - advanced</title>'), 'html includes title');
    t.ok(html.includes('<p class="muted">advanced.mts</p>'), 'html shows module path relative to project root');
    t.ok(!html.includes(appDir), 'html does not include absolute project paths');
    t.ok(html.includes('id="advanced.open"'), 'html includes symbol anchors');
    t.ok(html.includes('<main'), 'html uses the shared docs template layout');
    t.ok(html.includes('<h2>Overview</h2>'), 'module markdown headings are offset below module title');
    t.ok(html.includes('<h2>Functions</h2>'), 'html groups exports by kind');
    t.ok(html.includes('<h3><code><span class="tok-keyword">export</span> <span class="tok-keyword">function</span> open(name: <span class="tok-keyword">string</span>): <span class="tok-keyword">string</span></code></h3>'), 'html uses highlighted signatures as item headings');
    t.ok(html.includes('<h4>Usage</h4>'), 'export markdown headings are offset below export title');
    t.ok(html.includes('<h4>Getters</h4>'), 'html groups members by kind');
    t.ok(html.includes('<h5><code><span class="tok-keyword">get</span> name(): <span class="tok-keyword">string</span></code></h5>'), 'html uses highlighted member signatures as headings');
    t.ok(html.includes('<h6>Details</h6>'), 'member markdown headings are offset below member title');
    t.ok(!html.includes('<p class="muted">function</p>'), 'html does not repeat per-symbol kind labels');
    t.ok(html.includes('Use <strong>advanced</strong> resources with the <code>ResourceBox</code> helper.'), 'html renders module markdown');
    t.ok(html.includes('Supports <a href="https://example.test/resources">resource names</a> and <strong>flags</strong>.'), 'html renders description markdown');
    t.ok(!html.includes('@returns'), 'html does not render directive tags');
    t.ok(!html.includes('@param'), 'html does not render param directive tags');
    t.ok(html.includes('<h5><code><span class="tok-keyword">static</span> from(name: <span class="tok-keyword">string</span>): <a class="tok-type" href="advanced.html#advanced.ResourceBox">ResourceBox</a></code></h5>'), 'html links local symbols inside signatures');
    t.ok(html.includes('<a href="advanced.html#advanced.ResourceBox">ResourceBox</a>'), 'html resolves reference links to generated symbol anchors');
    t.ok(html.includes('<a href="advanced.html#advanced.ResourceBox.name">the name getter</a>'), 'html resolves same-module symbol links');
    t.ok(html.includes('<a href="https://example.test/docs">https://example.test/docs</a>.'), 'html linkifies bare URLs');
    t.ok(html.includes(') {\n  <span class="tok-keyword">throw</span> <span class="tok-keyword">new</span> Error(value);'), 'html preserves fenced code indentation');

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
    t.equal(box.members.some((member) => member.name === 'internalOnly'), false, 'internal members are excluded by default');

    const found = await runCli(['doc', 'search', 'display', 'name'], appDir);
    t.equal(found.result.code, 0, 'doc search uses the generated sqlite index');
    t.ok(found.stdout.includes('advanced.ResourceBox.name'), 'sqlite search finds member docs');
  });

  it('shows and searches fixed project docs artifacts', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    const dbPath = docsDir + '/docs.db';
    await removeTree(fs, docsDir);

    const coldSearch = await runCli(['doc', 'search', 'display', 'name'], appDir);
    t.equal(coldSearch.result.code, 0, 'doc search exits successfully without prebuilt artifacts');
    t.equal(coldSearch.stderr, '', 'doc search writes no stderr');
    t.ok(coldSearch.stdout.includes('advanced.ResourceBox.name'), 'search finds member docs');
    t.equal(coldSearch.stdout.includes('Wrote '), false, 'search does not surface transparent build output');
    t.equal(await exists(fs, jsonPath), true, 'search generates missing api.json in fixed docs dir');
    t.equal(await exists(fs, dbPath), true, 'search generates missing docs.db in fixed docs dir');

    const shown = await runCli(['doc', 'show', 'advanced.open'], appDir);
    t.equal(shown.result.code, 0, 'doc show exits successfully');
    t.ok(shown.stdout.includes('## open'), 'show renders symbol heading');
    t.ok(shown.stdout.includes('export function open(name: string): string'), 'show renders overload signature');
    t.ok(shown.stdout.includes('```ts\nconst value = open("primary");'), 'show renders examples');

    const member = await runCli(['doc', 'show', 'ResourceBox.name'], appDir);
    t.equal(member.result.code, 0, 'doc show finds member-qualified names');
    t.ok(member.stdout.includes('### name'), 'member show renders member heading');

    if (sqliteAvailable) {
      await fs.unlink(dbPath);
      const fromJson = await runCli(['doc', 'search', 'doc:display'], appDir);
      t.equal(fromJson.result.code, 0, 'doc search regenerates missing sqlite index from api.json');
      t.ok(fromJson.stdout.includes('advanced.ResourceBox.name'), 'regenerated sqlite search supports FTS column queries');
      t.equal(await exists(fs, dbPath), true, 'search writes regenerated docs.db in fixed docs dir');
    }

    const rejectedDb = await runCli(['doc', 'search', 'display', '--db', 'custom.db'], appDir);
    t.notEqual(rejectedDb.result.code, 0, 'doc search rejects --db');

    const rejectedOut = await runCli(['doc', 'search', 'display', '--out', 'custom-docs'], appDir);
    t.notEqual(rejectedOut.result.code, 0, 'doc search rejects --out');

    const ambiguous = await runCli(['doc', 'show', 'name'], appDir);
    t.equal(ambiguous.result.code, 0, 'ambiguous show exits successfully');
    t.ok(ambiguous.stdout.includes('Multiple matches'), 'ambiguous show reports candidates');
  });

  it('writes a root html index and keeps index modules at path-based locations', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli(['doc', 'build', './advanced.mts', './pkg/index.mts', '--format', 'html', '--title', 'Docs Site'], appDir);

    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');

    const index = await fs.readFile(docsDir + '/index.html');
    t.ok(index.includes('<title>Docs Site</title>'), 'root index has site title');
    t.ok(index.includes('API Modules'), 'root index is a module landing page');
    t.ok(index.includes('href="advanced.html"'), 'root index links regular modules');
    t.ok(index.includes('href="pkg/index.html"'), 'root index links index modules at path-based locations');
    t.ok(!index.includes('<h1 id="module:index">index</h1>'), 'root index is not an index module page');

    const indexModule = await fs.readFile(docsDir + '/pkg/index.html');
    t.ok(indexModule.includes('<title>Docs Site - pkg/index</title>'), 'index module gets path-based output page');
    t.ok(indexModule.includes('Package index docs.'), 'index module page renders docs');
  });

  it('runs examples from documentation comments', async (t) => {
    const run = await runCli(['doc', 'test', './examples.mts'], appDir);

    t.equal(run.result.code, 0, 'doc test exits successfully');
    t.equal(run.stderr, '', 'doc test writes no stderr');
    t.ok(run.stdout.includes('2 passed'), 'doc test runs non-ignored examples');
    t.ok(run.stdout.includes('1 ignored'), 'doc test reports ignored examples');
  });
});
