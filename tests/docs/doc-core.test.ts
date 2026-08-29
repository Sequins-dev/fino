/** Documentation core integration tests. */
import { after, before, describe, it } from 'fino:test/test';
import { Database, sqliteAvailable } from 'fino:database/sqlite';
import {
  createDocTestFixture,
  type DocTestFixture,
  removeDocTestFixture,
  type DocJsonExport,
  type DocJsonMember,
  type DocJsonOutput,
  ensureDir,
  removeTree,
  runCli,
} from './doc-test-helpers.ts';

describe('fino doc: core', () => {
  let fixture!: DocTestFixture;
  let fs!: DocTestFixture['fs'];
  let appDir!: string;

  before(async () => {
    fixture = await createDocTestFixture();
    ({ fs, appDir } = fixture);
  });

  after(async () => {
    await removeDocTestFixture(fixture);
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
    t.ok(
      markdown.includes('```ts\nfunction add(a: number, b: number): number\n```'),
      'markdown includes typed function signature without export prefix',
    );
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
    t.ok(
      markdown.includes('type ConfigSource =\n'),
      'markdown formats long type alias across lines',
    );
    t.ok(
      markdown.includes('| { inline?:'),
      'markdown preserves each union branch in the formatted signature',
    );
    t.ok(
      markdown.includes("format: 'json' | 'yaml' | 'toml';"),
      'markdown preserves nested literal union in formatted signature',
    );
    t.equal(
      markdown.includes('internal marker'),
      false,
      'markdown strips comments from formatted signatures',
    );
    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const firstModule = json.modules[0]!;
    const firstExport = firstModule.exports[0]!;
    t.equal(json.modules.length, 1, 'json includes one module');
    t.equal(firstModule.name, 'api', 'json records module name');
    t.equal(
      firstModule.doc.text.includes('Example API module.'),
      true,
      'json records module prelude',
    );
    t.equal(firstModule.exports.length, 6, 'json includes exported declarations');
    t.equal(firstExport.name, 'add', 'json records function export');
    t.equal(
      firstExport.signature,
      'function add(a: number, b: number): number',
      'json records function signature without export prefix',
    );
    const buildRuntimeConfig = firstModule.exports.find(
      (item: DocJsonExport) => item.name === 'buildRuntimeConfig',
    );
    t.ok(buildRuntimeConfig, 'json includes long function export');
    t.ok(
      buildRuntimeConfig!.signature.includes('\n'),
      'json records formatted multiline function signature',
    );
    const configSource = firstModule.exports.find(
      (item: DocJsonExport) => item.name === 'ConfigSource',
    );
    t.ok(configSource, 'json includes type alias export');
    t.ok(configSource!.signature.includes('\n'), 'json records formatted multiline type signature');
    t.equal(
      configSource!.signature.includes('internal marker'),
      false,
      'json strips comments from formatted signatures',
    );
    const secretBox = firstModule.exports.find((item: DocJsonExport) => item.name === 'SecretBox');
    t.ok(secretBox, 'json includes class export');
    const response = firstModule.exports.find((item: DocJsonExport) => item.name === 'ApiResponse');
    t.ok(response, 'json includes interface export');
    t.equal(
      response!.members.some((item: DocJsonMember) => item.name === 'traceId'),
      false,
      'json excludes @internal interface member',
    );
    t.equal(
      secretBox!.members.some((item: DocJsonMember) => item.name === 'debugToken'),
      false,
      'json excludes @internal class member',
    );
    t.equal(
      secretBox!.members.some((item: DocJsonMember) => item.name === '#token'),
      false,
      'json excludes private class property',
    );
    t.equal(
      secretBox!.members.some((item: DocJsonMember) => item.name === '#peek'),
      false,
      'json excludes private class method',
    );
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
    await fs.writeFile(
      staleDir + '/current.ts',
      `/**
 * Current module.
 */
export function current(): number {
return 1;
}
`,
    );
    const db = await Database.open(docsDir + '/docs.db');
    try {
      await db.exec(
        'CREATE TABLE IF NOT EXISTS doc_files (path TEXT NOT NULL, kind TEXT NOT NULL, include_private INTEGER NOT NULL, mtime_ms REAL NOT NULL, size INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (path, kind, include_private))',
      );
      const staleJson = JSON.stringify({
        modules: [
          {
            path: 'target/stale.ts',
            name: 'stale',
            doc: { text: 'stale'.repeat(1024) },
            exports: [],
          },
        ],
      });
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
    const run = await runCli(['doc', 'build', './current.ts', '--format', 'markdown'], staleDir);
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
    const run = await runCli(
      [
        'doc',
        'build',
        './api.ts',
        '--format',
        'both',
        '--include-private',
        '--title',
        'Private API',
      ],
      appDir,
    );
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
    t.equal(
      response.members.some((member) => member.name === 'traceId'),
      true,
      'include-private json includes @internal interface member',
    );
    t.equal(
      secretBox.members.some((member) => member.name === 'debugToken'),
      true,
      'include-private json includes @internal class member',
    );
    t.equal(
      secretBox.members.some((member) => member.name === '#token'),
      true,
      'include-private json includes private class property',
    );
    t.equal(
      secretBox.members.some((member) => member.name === '#peek'),
      true,
      'include-private json includes private class method',
    );
  });
  it('keeps generated public module docs free of private-member stubs by default', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli(
      ['doc', 'build', './private-stubs.ts', '--format', 'both', '--title', 'SDK Public Docs'],
      appDir,
    );
    t.equal(run.result.code, 0, 'public module doc build exits successfully');
    t.equal(run.stderr, '', 'public module doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/private-stubs.html');
    const markdown = await fs.readFile(docsDir + '/private-stubs.md');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const moduleDoc = json.modules.find((item) => item.name === 'private-stubs')!;
    t.equal(
      html.includes('private field on'),
      false,
      'html excludes generated private-field stub text',
    );
    t.equal(html.includes('private member'), false, 'html excludes private-member language');
    t.equal(html.includes('#secret'), false, 'html excludes private field anchors');
    t.equal(
      markdown.includes('private field on'),
      false,
      'markdown excludes generated private-field stub text',
    );
    t.equal(markdown.includes('#secret'), false, 'markdown excludes private field anchors');
    t.equal(
      moduleDoc.exports.some((item) => item.name.startsWith('#')),
      false,
      'json excludes private exported names',
    );
    t.equal(
      moduleDoc.exports.some((item) => item.members.some((member) => member.name.startsWith('#'))),
      false,
      'json excludes private member names',
    );
  });
  it('builds v2 json, html, and sqlite search artifacts', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    const dbPath = docsDir + '/docs.db';
    await removeTree(fs, docsDir);
    const run = await runCli(
      ['doc', 'build', './advanced.ts', '--format', 'both', '--title', 'Advanced API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/advanced.md'), 'doc build reports markdown');
    t.ok(run.stdout.includes('/docs/advanced.html'), 'doc build reports html');
    t.ok(run.stdout.includes('/docs/docs.db'), 'doc build reports sqlite index');
    const html = await fs.readFile(docsDir + '/advanced.html');
    const docsCss = await fs.readFile(docsDir + '/docs.css');
    t.ok(html.includes('<title>Advanced API - advanced</title>'), 'html includes title');
    t.ok(
      html.includes('<p class="muted">advanced.ts</p>'),
      'html shows module path relative to project root',
    );
    t.ok(!html.includes(appDir), 'html does not include absolute project paths');
    t.ok(html.includes('id="advanced.open"'), 'html includes symbol anchors');
    t.ok(html.includes('<main'), 'html uses the shared docs template layout');
    t.ok(
      docsCss.includes(
        '.docs-layout{display:grid;grid-template-columns:280px minmax(0,1fr);height:100vh',
      ),
      'shared layout uses fixed viewport height',
    );
    t.ok(
      docsCss.includes('.docs-layout-api{grid-template-columns:280px minmax(0,1fr) 240px}'),
      'api layout reserves a right page index column',
    );
    t.ok(
      docsCss.includes('main{display:block;max-width:980px;width:100%;height:100vh;overflow:auto'),
      'content area scrolls independently',
    );
    t.ok(
      docsCss.includes(
        'main{display:block;max-width:980px;width:100%;height:100vh;overflow:auto;padding:40px 48px 72px;grid-column:2;grid-row:1}',
      ),
      'content stays in the first desktop grid row',
    );
    t.ok(
      docsCss.includes(
        '.docs-page-index{border-left:1px solid var(--border);padding:40px 18px 72px;overflow:auto;position:sticky;top:0;height:100vh',
      ),
      'page index is independently scrollable and sticky',
    );
    t.ok(
      docsCss.includes(
        '.docs-page-index{border-left:1px solid var(--border);padding:40px 18px 72px;overflow:auto;position:sticky;top:0;height:100vh;grid-column:3;grid-row:1}',
      ),
      'page index stays in the first desktop grid row',
    );
    t.ok(
      docsCss.includes('.docs-sidebar{grid-column:1;grid-row:1;'),
      'left sidebar stays in the first desktop grid row',
    );
    t.ok(
      docsCss.includes(
        '@media(max-width:760px){body{overflow:auto}.docs-layout,.docs-layout-api{display:block;height:auto}',
      ),
      'mobile layout collapses API pages to a single column',
    );
    t.ok(
      docsCss.includes('.docs-symbol{margin:0 0 72px}'),
      'template separates symbols with enough whitespace after descriptions and examples',
    );
    t.ok(
      docsCss.includes('.docs-symbol>h3+p,.member>h5+p{margin-top:0}'),
      'template keeps descriptions close to their signatures',
    );
    t.ok(
      docsCss.includes('color-scheme:light dark'),
      'template advertises light and dark color schemes',
    );
    t.ok(
      docsCss.includes('@media(prefers-color-scheme:dark)'),
      'template automatically follows dark mode preference',
    );
    t.ok(docsCss.includes('--bg:#0d1117'), 'template defines dark background color');
    t.ok(
      html.includes('<h2>Overview</h2>'),
      'module markdown headings are offset below module title',
    );
    t.ok(html.includes('<h2>Functions</h2>'), 'html groups exports by kind');
    t.ok(
      html.includes(
        '<h3><code><span class="tok-keyword">function</span> open(name: <span class="tok-keyword">string</span>): <span class="tok-keyword">string</span></code></h3>',
      ),
      'html uses highlighted signatures as item headings without export prefix',
    );
    t.ok(
      !html.includes('<span class="tok-keyword">export</span>'),
      'html omits redundant export prefixes',
    );
    t.ok(html.includes('<h4>Usage</h4>'), 'export markdown headings are offset below export title');
    t.ok(html.includes('<h4>Getters</h4>'), 'html groups members by kind');
    t.ok(
      html.includes(
        '<h5><code><span class="tok-keyword">get</span> name(): <span class="tok-keyword">string</span></code></h5>',
      ),
      'html uses highlighted member signatures as headings',
    );
    t.ok(
      html.includes('<h6>Details</h6>'),
      'member markdown headings are offset below member title',
    );
    t.ok(
      html.includes('<nav class="docs-page-index" aria-label="Page symbol index">'),
      'api pages include a page-local symbol index',
    );
    t.ok(
      html.includes('<a href="#advanced.open">open</a>'),
      'page index links exported symbols by concise name',
    );
    t.ok(
      html.includes('<a href="#advanced.ResourceBox">ResourceBox</a>'),
      'page index links class exports by concise name',
    );
    t.ok(
      html.includes('<a href="#advanced.ResourceBox.name">name</a>'),
      'page index links class members by concise name',
    );
    t.ok(
      html.includes('<a href="#advanced.ResourceBox.from">from</a>'),
      'page index links static members by concise name',
    );
    t.equal(
      html.includes('<a href="#advanced.ResourceBox.name">get name()'),
      false,
      'page index does not use full member signatures',
    );
    t.ok(
      html.indexOf('<a href="#advanced.ResourceBox">ResourceBox</a>') <
        html.indexOf('<a href="#advanced.ResourceBox.name">name</a>'),
      'page index nests members after their parent export',
    );
    t.ok(
      !html.includes('<p class="muted">function</p>'),
      'html does not repeat per-symbol kind labels',
    );
    t.ok(
      html.includes(
        'Use <strong>advanced</strong> resources with the <code>ResourceBox</code> helper.',
      ),
      'html renders module markdown',
    );
    t.ok(
      html.includes('<a href="../guides/advanced.md">advanced guide</a>'),
      'html rewrites source-relative module markdown links for generated output',
    );
    t.ok(
      html.includes(
        'Supports <a href="https://example.test/resources">resource names</a> and <strong>flags</strong>.',
      ),
      'html renders description markdown',
    );
    t.ok(!html.includes('@returns'), 'html does not render directive tags');
    t.ok(!html.includes('@param'), 'html does not render param directive tags');
    t.ok(
      html.includes(
        '<h5><code><span class="tok-keyword">static</span> from(name: <span class="tok-keyword">string</span>): <a class="tok-type" href="advanced.html#advanced.ResourceBox">ResourceBox</a></code></h5>',
      ),
      'html links local symbols inside signatures',
    );
    t.ok(
      html.includes(
        'href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date">Date</a>',
      ),
      'html links Date signatures to MDN',
    );
    t.ok(
      html.includes(
        'href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Typed_arrays">ArrayBufferView</a>',
      ),
      'html links ArrayBufferView signatures to MDN',
    );
    t.ok(
      html.includes(
        'href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols">Iterable</a>',
      ),
      'html links Iterable signatures to MDN',
    );
    t.ok(
      html.includes(
        'href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncIterator">AsyncIterator</a>',
      ),
      'html links AsyncIterator signatures to MDN',
    );
    t.ok(
      html.includes(
        'href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols">IteratorResult</a>',
      ),
      'html links IteratorResult signatures to MDN',
    );
    t.ok(
      html.includes(
        'href="https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype">Partial</a>',
      ),
      'html links Partial signatures to TypeScript docs',
    );
    t.ok(
      html.includes('<a href="advanced.html#advanced.ResourceBox">ResourceBox</a>'),
      'html resolves reference links to generated symbol anchors',
    );
    t.ok(
      html.includes('<a href="advanced.html#advanced.ResourceBox.name">the name getter</a>'),
      'html resolves same-module symbol links',
    );
    t.ok(
      html.includes('<a href="https://example.test/docs">https://example.test/docs</a>.'),
      'html linkifies bare URLs',
    );
    t.ok(
      html.includes(
        ') {\n  <span class="tok-keyword">throw</span> <span class="tok-keyword">new</span> Error(value);',
      ),
      'html preserves fenced code indentation',
    );
    t.equal(html.includes('trace()'), false, 'html excludes @internal class members by default');
    t.equal(
      html.includes('internalOnly'),
      false,
      'html excludes TypeScript private class members by default',
    );
    t.equal(
      html.includes('Hidden implementation detail.'),
      false,
      'html excludes private member docs by default',
    );
    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const moduleDoc = json.modules[0]!;
    const open = moduleDoc.exports.find((item: DocJsonExport) => item.name === 'open')!;
    const box = moduleDoc.exports.find((item: DocJsonExport) => item.name === 'ResourceBox')!;
    t.equal(moduleDoc.id, 'module:advanced', 'module has stable id');
    t.equal(moduleDoc.sourceModule, 'advanced', 'module has source specifier metadata');
    t.equal(open.id, 'advanced.open', 'export has stable id');
    t.equal(open.signatures!.length, 2, 'overloads are grouped as signatures');
    t.equal(
      open.doc!.blocks!.some((block) => block.kind === 'example'),
      false,
      'legacy example blocks are not emitted',
    );
    t.equal(
      open.doc!.blocks!.some((block) => block.kind === 'code' && block.lang === 'ts'),
      true,
      'fenced examples are structured code blocks',
    );
    t.equal(
      open.doc!.blocks!.some((block) => block.kind === 'param'),
      false,
      'directive params are not emitted as structured blocks',
    );
    t.equal(
      box.members.some((member) => member.kind === 'constructor'),
      true,
      'constructor is classified',
    );
    t.equal(
      box.members.some((member) => member.kind === 'getter' && member.name === 'name'),
      true,
      'getter is classified',
    );
    t.equal(
      box.members.some((member) => member.kind === 'setter' && member.name === 'name'),
      true,
      'setter is classified',
    );
    t.equal(
      box.members.some((member) => member.kind === 'static-method' && member.name === 'from'),
      true,
      'static method is classified',
    );
    t.equal(
      box.members.some((member) => member.name === 'trace'),
      false,
      'internal members are excluded from json by default',
    );
    t.equal(
      box.members.some((member) => member.name === 'internalOnly'),
      false,
      'internal members are excluded by default',
    );
    const found = await runCli(['doc', 'search', 'display', 'name'], appDir);
    t.equal(found.result.code, 0, 'doc search uses the generated sqlite index');
    t.ok(found.stdout.includes('advanced.ResourceBox.name'), 'sqlite search finds member docs');
    const hidden = await runCli(['doc', 'search', 'internalOnly'], appDir);
    t.equal(hidden.result.code, 0, 'doc search exits successfully for private member query');
    t.equal(
      hidden.stdout.includes('advanced.ResourceBox.internalOnly'),
      false,
      'sqlite search excludes private members by default',
    );
  });
});
