/** Documentation search integration tests. */
import { after, before, describe, it } from 'fino:test/test';
import { sqliteAvailable } from 'fino:database/sqlite';
import {
  createDocTestFixture,
  type DocTestFixture,
  removeDocTestFixture,
  type DocJsonOutput,
  TEST_DIR,
  ensureDir,
  exists,
  removeTree,
  runCli,
  runCliProcess,
} from './doc-test-helpers.ts';

describe('fino doc: search', () => {
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
  it('shows and searches fixed project docs artifacts', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    const dbPath = docsDir + '/docs.db';
    await removeTree(fs, docsDir);
    const missingBuild = await runCli(['doc', 'search', 'display', 'name'], appDir);
    t.notEqual(missingBuild.result.code, 0, 'doc search requires a prior build');
    const build = await runCli(
      ['doc', 'build', './advanced.ts', '--format', 'both', '--title', 'Advanced API'],
      appDir,
    );
    t.equal(build.result.code, 0, 'doc build exits successfully');
    t.equal(await exists(fs, jsonPath), true, 'doc build writes api.json');
    t.equal(await exists(fs, dbPath), true, 'doc build writes docs.db');
    await fs.unlink(dbPath);
    const search = await runCli(['doc', 'search', 'display', 'name'], appDir);
    t.equal(
      search.result.code,
      0,
      'doc search regenerates missing search db from prior build inputs',
    );
    t.equal(search.stderr, '', 'doc search writes no stderr');
    t.ok(search.stdout.includes('advanced.ResourceBox.name'), 'search finds member docs');
    t.equal(
      search.stdout.includes('Wrote '),
      false,
      'search does not surface transparent build output',
    );
    t.equal(await exists(fs, dbPath), true, 'search regenerates missing docs.db in fixed docs dir');
    const shown = await runCli(['doc', 'show', 'advanced.open'], appDir);
    t.equal(shown.result.code, 0, 'doc show exits successfully');
    t.ok(shown.stdout.includes('## open'), 'show renders symbol heading');
    t.ok(
      shown.stdout.includes('function open(name: string): string'),
      'show renders overload signature without export prefix',
    );
    t.equal(
      shown.stdout.includes('export function open'),
      false,
      'show omits redundant export prefix',
    );
    t.ok(shown.stdout.includes('```ts\nconst value = open("primary");'), 'show renders examples');
    const member = await runCli(['doc', 'show', 'ResourceBox.name'], appDir);
    t.equal(member.result.code, 0, 'doc show finds member-qualified names');
    t.ok(member.stdout.includes('### name'), 'member show renders member heading');
    if (sqliteAvailable) {
      await fs.unlink(dbPath);
      const fromJson = await runCli(['doc', 'search', 'doc:display'], appDir);
      t.equal(fromJson.result.code, 0, 'doc search regenerates missing sqlite index from api.json');
      t.ok(
        fromJson.stdout.includes('advanced.ResourceBox.name'),
        'regenerated sqlite search supports FTS column queries',
      );
      t.equal(
        await exists(fs, dbPath),
        true,
        'search writes regenerated docs.db in fixed docs dir',
      );
    }
    const rejectedDb = await runCli(['doc', 'search', 'display', '--db', 'custom.db'], appDir);
    t.notEqual(rejectedDb.result.code, 0, 'doc search rejects --db');
    const rejectedOut = await runCli(['doc', 'search', 'display', '--out', 'custom-docs'], appDir);
    t.notEqual(rejectedOut.result.code, 0, 'doc search rejects --out');
    const ambiguous = await runCli(['doc', 'show', 'name'], appDir);
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
    const run = await runCli(['doc', 'build', '.', '--format', 'markdown'], appDir);
    t.equal(run.result.code, 0, 'doc build . exits successfully');
    t.equal(run.stderr, '', 'doc build . writes no stderr');
    t.ok(run.stdout.includes('/docs/advanced.md'), 'doc build still discovers project sources');
  });
  it('serializes concurrent search index regenerations', async (t) => {
    const project = TEST_DIR + '/concurrent-search-' + Math.floor(Math.random() * 1e6);
    await ensureDir(fs, project);
    await fs.writeFile(
      project + '/api.ts',
      `/**
 * Concurrent search module.
 */

/**
 * Searchable concurrent value.
 */
export const concurrentValue = 1;
`,
    );
    const build = await runCli(['doc', 'build', 'api.ts', '--format', 'markdown'], project);
    t.equal(build.result.code, 0, 'initial build exits successfully');
    await fs.unlink(project + '/docs/docs.db');
    const [a, b] = await Promise.all([
      runCliProcess(['doc', 'search', 'concurrentValue'], project),
      runCliProcess(['doc', 'search', 'concurrentValue'], project),
    ]);
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
    await fs.writeFile(
      project + '/src/public.ts',
      `/**
 * Scoped public module.
 */

/**
 * Scoped value docs.
 */
export const scopedValue = 1;
`,
    );
    await fs.writeFile(
      project + '/outside.ts',
      `/**
 * Outside module docs.
 */

/**
 * Outside value docs.
 */
export const outsideValue = 1;
`,
    );
    const build = await runCli(['doc', 'build', 'src', '--format', 'markdown'], project);
    t.equal(build.result.code, 0, 'scoped build exits successfully');
    await fs.unlink(project + '/docs/docs.db');
    const scoped = await runCli(['doc', 'search', 'scopedValue'], project);
    t.equal(scoped.result.code, 0, 'search regenerates missing db');
    t.ok(scoped.stdout.includes('public.scopedValue'), 'search finds scoped build input');
    const outside = await runCli(['doc', 'search', 'outsideValue'], project);
    t.equal(outside.result.code, 0, 'outside search exits successfully');
    t.equal(
      outside.stdout,
      'No results for outsideValue\n',
      'search does not rediscover outside initial build roots',
    );
  });
  it('refreshes stale search artifacts from new and changed inputs', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    await removeTree(fs, docsDir);
    const initial = await runCli(
      ['doc', 'build', './advanced.ts', '--format', 'both', '--title', 'Advanced API'],
      appDir,
    );
    t.equal(initial.result.code, 0, 'initial doc build exits successfully');
    t.equal(initial.stderr, '', 'initial doc build writes no stderr');
    await fs.writeFile(
      appDir + '/incremental-new.ts',
      `/**
 * Incremental new module fixture.
 */

/**
 * New symbol added after the search database was built.
 */
export function staleSearchAdded(): string {
return 'added';
}
`,
    );
    const foundNew = await runCli(['doc', 'search', 'staleSearchAdded'], appDir);
    t.equal(foundNew.result.code, 0, 'stale search refresh exits successfully');
    t.equal(foundNew.stderr, '', 'stale search refresh writes no stderr');
    t.ok(
      foundNew.stdout.includes('incremental-new.staleSearchAdded'),
      'search finds a symbol from a new source file',
    );
    t.equal(
      foundNew.stdout.includes('Wrote '),
      false,
      'search does not surface incremental refresh output',
    );
    let json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    t.ok(
      json.modules.some((item) => item.name === 'incremental-new'),
      'incremental search refresh updates api.json',
    );
    await fs.writeFile(
      appDir + '/incremental-new.ts',
      `/**
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
`,
    );
    const foundChanged = await runCli(['doc', 'search', 'staleSearchChanged'], appDir);
    t.equal(foundChanged.result.code, 0, 'changed-file stale search refresh exits successfully');
    t.ok(
      foundChanged.stdout.includes('incremental-new.staleSearchChanged'),
      'search finds a symbol added to an existing source file',
    );
    const shown = await runCli(['doc', 'show', 'staleSearchChanged'], appDir);
    t.equal(shown.result.code, 0, 'show refreshes stale api json');
    t.ok(shown.stdout.includes('## staleSearchChanged'), 'show renders the newly added symbol');
    json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const incremental = json.modules.find((item) => item.name === 'incremental-new')!;
    t.ok(
      incremental.exports.some((item) => item.name === 'staleSearchChanged'),
      'api.json includes changed-file symbol',
    );
  });
  it('refreshes search within the original build input roots', async (t) => {
    const rootDir = TEST_DIR + '/doc-input-roots';
    const jsDir = rootDir + '/js';
    const brokenDir = rootDir + '/third_party';
    await removeTree(fs, rootDir);
    await ensureDir(fs, jsDir);
    await ensureDir(fs, brokenDir);
    await fs.writeFile(
      jsDir + '/initial.ts',
      `/**
 * Initial scoped docs module.
 */

/**
 * Initial scoped symbol.
 */
export function scopedInitial(): string {
return 'initial';
}
`,
    );
    await fs.writeFile(brokenDir + '/broken.js', 'export const = ;\n');
    const initial = await runCli(['doc', 'build', './js', '--format', 'markdown'], rootDir);
    t.equal(initial.result.code, 0, 'initial scoped build exits successfully');
    await fs.writeFile(
      jsDir + '/later.ts',
      `/**
 * Later scoped docs module.
 */

/**
 * Later scoped symbol.
 */
export function scopedLater(): string {
return 'later';
}
`,
    );
    const found = await runCli(['doc', 'search', 'scopedLater'], rootDir);
    t.equal(
      found.result.code,
      0,
      'search refresh exits successfully without scanning broken sibling directories',
    );
    t.equal(found.stderr, '', 'search refresh writes no stderr');
    t.ok(
      found.stdout.includes('later.scopedLater'),
      'search finds new symbol under original build root',
    );
  });
  it('refreshes re-exported symbols and removes deleted cached files', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    await removeTree(fs, docsDir);
    await fs.writeFile(
      appDir + '/incremental-source.ts',
      `/**
 * Incremental source fixture.
 */

/**
 * First re-exported value.
 */
export const firstReExported = 'first';
`,
    );
    await fs.writeFile(
      appDir + '/incremental-facade.ts',
      `/**
 * Incremental facade fixture.
 */

export * from './incremental-source.ts';
`,
    );
    const initial = await runCli(
      [
        'doc',
        'build',
        './incremental-facade.ts',
        './incremental-source.ts',
        '--format',
        'both',
        '--title',
        'Incremental API',
      ],
      appDir,
    );
    t.equal(initial.result.code, 0, 'initial re-export build exits successfully');
    t.equal(initial.stderr, '', 'initial re-export build writes no stderr');
    await fs.writeFile(
      appDir + '/incremental-source.ts',
      `/**
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
`,
    );
    const found = await runCli(['doc', 'search', 'laterReExported'], appDir);
    t.equal(found.result.code, 0, 're-export stale search refresh exits successfully');
    t.ok(
      found.stdout.includes('incremental-facade.laterReExported'),
      'search finds the newly re-exported facade symbol',
    );
    await fs.unlink(appDir + '/incremental-source.ts');
    const rebuilt = await runCli(
      ['doc', 'build', './incremental-facade.ts', '--format', 'both', '--title', 'Incremental API'],
      appDir,
    );
    t.equal(rebuilt.result.code, 0, 'rebuild after deleting an input exits successfully');
    t.equal(rebuilt.stderr, '', 'rebuild after deleting an input writes no stderr');
    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    t.equal(
      json.modules.some((item) => item.name === 'incremental-source'),
      false,
      'api.json drops deleted source files',
    );
    t.equal(
      json.modules.some((item) => item.exports.some((exp) => exp.name === 'laterReExported')),
      false,
      'api.json drops symbols from deleted sources',
    );
    t.equal(
      await exists(fs, docsDir + '/incremental-source.html'),
      false,
      'doc build prunes generated output for deleted files',
    );
  });
  it('keeps public and private doc caches separate', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(
      appDir + '/incremental-private.ts',
      `/**
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
`,
    );
    const privateRun = await runCli(
      [
        'doc',
        'build',
        './incremental-private.ts',
        '--include-private',
        '--format',
        'both',
        '--title',
        'Private API',
      ],
      appDir,
    );
    t.equal(privateRun.result.code, 0, 'private doc build exits successfully');
    t.equal(privateRun.stderr, '', 'private doc build writes no stderr');
    const publicRun = await runCli(
      ['doc', 'build', './incremental-private.ts', '--format', 'both', '--title', 'Public API'],
      appDir,
    );
    t.equal(publicRun.result.code, 0, 'public doc build exits successfully');
    t.equal(publicRun.stderr, '', 'public doc build writes no stderr');
    const hidden = await runCli(['doc', 'search', 'privateCacheValue'], appDir);
    t.equal(hidden.result.code, 0, 'public search exits successfully');
    t.equal(
      hidden.stdout.includes('incremental-private.privateCacheValue'),
      false,
      'public search does not reuse the private cache entry',
    );
  });
});
