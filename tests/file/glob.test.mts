/**
 * Tests for fino:file Glob pattern matching and DiskFileSystem.glob() walk.
 */

import { describe, it, before, after } from 'fino:test/test';
import { DiskFileSystem, Glob } from 'fino:file';

const TEST_DIR = '/tmp/fino-glob-test-' + Math.floor(Math.random() * 1_000_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTree(fs: DiskFileSystem, root: string, tree: Record<string, string | null>): Promise<void> {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = root + '/' + rel;
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    // Create parent directories
    const parts = dir.replace(root + '/', '').split('/');
    let cur = root;
    for (const part of parts) {
      cur += '/' + part;
      try { await fs.mkdir(cur); } catch { /* already exists */ }
    }
    if (content !== null) {
      await fs.writeFile(abs, content ?? '');
    } else {
      try { await fs.mkdir(abs); } catch { /* already exists */ }
    }
  }
}

async function collectGlob(fs: DiskFileSystem, pattern: string, options = {}): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of fs.glob(pattern, options)) {
    results.push(entry.path.toString());
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Glob (pattern matching only)', () => {
  it('Glob#test — single star', (t) => {
    const g = new Glob('*.ts');
    t.ok(g.test('index.ts'),    '*.ts matches index.ts');
    t.ok(g.test('foo.ts'),      '*.ts matches foo.ts');
    t.ok(!g.test('src/foo.ts'), '*.ts does not match src/foo.ts');
    t.ok(!g.test('foo.js'),     '*.ts does not match foo.js');
  });

  it('Glob#test — question mark', (t) => {
    const g = new Glob('?.ts');
    t.ok(g.test('a.ts'),   '?.ts matches a.ts');
    t.ok(!g.test('ab.ts'), '?.ts does not match ab.ts');
    t.ok(!g.test('.ts'),   '?.ts does not match .ts');
  });

  it('Glob#test — double star anywhere', (t) => {
    const g = new Glob('**/*.ts');
    t.ok(g.test('index.ts'),           '**/*.ts matches index.ts');
    t.ok(g.test('src/index.ts'),       '**/*.ts matches src/index.ts');
    t.ok(g.test('src/lib/util.ts'),    '**/*.ts matches src/lib/util.ts');
    t.ok(!g.test('src/lib/util.js'),   '**/*.ts does not match util.js');
  });

  it('Glob#test — double star at end', (t) => {
    const g = new Glob('src/**');
    t.ok(g.test('src/index.ts'),    'src/** matches src/index.ts');
    t.ok(g.test('src/lib/foo.ts'), 'src/** matches src/lib/foo.ts');
    t.ok(!g.test('lib/foo.ts'),    'src/** does not match lib/foo.ts');
  });

  it('Glob#test — brace expansion', (t) => {
    const g = new Glob('*.{ts,js}');
    t.ok(g.test('index.ts'),   '*.{ts,js} matches index.ts');
    t.ok(g.test('index.js'),   '*.{ts,js} matches index.js');
    t.ok(!g.test('index.mts'), '*.{ts,js} does not match index.mts');
  });

  it('Glob#test — character class', (t) => {
    const g = new Glob('[abc].ts');
    t.ok(g.test('a.ts'),  '[abc].ts matches a.ts');
    t.ok(g.test('b.ts'),  '[abc].ts matches b.ts');
    t.ok(g.test('c.ts'),  '[abc].ts matches c.ts');
    t.ok(!g.test('d.ts'), '[abc].ts does not match d.ts');
  });

  it('Glob#test — negated character class', (t) => {
    const g = new Glob('[!abc].ts');
    t.ok(g.test('d.ts'),   '[!abc].ts matches d.ts');
    t.ok(!g.test('a.ts'),  '[!abc].ts does not match a.ts');
    t.ok(!g.test('ab.ts'), '[!abc].ts does not match ab.ts (two chars)');
  });

  it('Glob#test — dotfiles excluded by default', (t) => {
    const g = new Glob('**/*.ts');
    t.ok(!g.test('.hidden/index.ts'),    'dotfile dir excluded');
    t.ok(!g.test('src/.config.ts'),      'dotfile excluded');
    t.ok(g.test('src/index.ts'),         'non-dot included');
  });

  it('Glob#test — dotfiles included when dot:true', (t) => {
    const g = new Glob('**/*.ts', { dot: true });
    t.ok(g.test('.hidden/index.ts'),  'dot:true includes dotfile dir');
    t.ok(g.test('src/.config.ts'),    'dot:true includes dotfile');
  });

  it('Glob#test — literal dot in pattern includes dotfiles', (t) => {
    const g = new Glob('.hidden/*.ts');
    t.ok(g.test('.hidden/index.ts'),  '.hidden/*.ts matches .hidden/index.ts');
    t.ok(!g.test('src/index.ts'),     '.hidden/*.ts does not match src/index.ts');
  });

  it('Glob#test — backslash escape', (t) => {
    const g = new Glob('foo\\*.ts');
    t.ok(g.test('foo*.ts'),   'escaped * is literal');
    t.ok(!g.test('foobar.ts'), 'escaped * does not match "bar"');
  });
});

describe('DiskFileSystem.glob() — directory walker', () => {
  let fs: DiskFileSystem;

  before(async () => {
    fs = new DiskFileSystem();
    await fs.mkdir(TEST_DIR);
    // Create test tree:
    //   src/
    //     index.ts
    //     lib/
    //       util.ts
    //       helper.js
    //     .hidden/
    //       secret.ts
    //   test/
    //     spec.ts
    //     fixtures/
    //       data.json
    //   README.md
    await createTree(fs, TEST_DIR, {
      'src': null,
      'src/index.ts': 'export {};',
      'src/lib': null,
      'src/lib/util.ts': 'export {};',
      'src/lib/helper.js': 'module.exports = {};',
      'src/.hidden': null,
      'src/.hidden/secret.ts': '// secret',
      'test': null,
      'test/spec.ts': 'test();',
      'test/fixtures': null,
      'test/fixtures/data.json': '{}',
      'README.md': '# Test',
    });
  });

  after(async () => {
    // Clean up test tree recursively
    async function rm(path: string) {
      const st = await fs.lstat(path);
      if (st.isDirectory()) {
        const dir = await fs.dir(path);
        for await (const entry of dir) {
          await rm(entry.path.toString());
        }
        await fs.rmdir(path);
      } else {
        await fs.unlink(path);
      }
    }
    await rm(TEST_DIR);
  });

  it('matches **/*.ts in test dir', async (t) => {
    const results = await collectGlob(fs, '**/*.ts', { cwd: TEST_DIR });
    // Should find all .ts files (excluding dotfile dir by default)
    t.ok(results.some(r => r.endsWith('src/index.ts')),  'finds src/index.ts');
    t.ok(results.some(r => r.endsWith('src/lib/util.ts')), 'finds src/lib/util.ts');
    t.ok(results.some(r => r.endsWith('test/spec.ts')),  'finds test/spec.ts');
    t.ok(!results.some(r => r.includes('.hidden')),       'excludes dotfile dirs');
  });

  it('matches **/*.ts with dot:true', async (t) => {
    const results = await collectGlob(fs, '**/*.ts', { cwd: TEST_DIR, dot: true });
    t.ok(results.some(r => r.includes('.hidden')), 'includes dotfile dir with dot:true');
  });

  it('matches pattern with fixed prefix src/*.ts', async (t) => {
    const results = await collectGlob(fs, 'src/*.ts', { cwd: TEST_DIR });
    t.ok(results.some(r => r.endsWith('src/index.ts')),    'finds src/index.ts');
    t.ok(!results.some(r => r.endsWith('lib/util.ts')),    'excludes nested util.ts');
    t.ok(!results.some(r => r.endsWith('test/spec.ts')),   'excludes test/spec.ts');
  });

  it('matches src/**/*.ts recursively', async (t) => {
    const results = await collectGlob(fs, 'src/**/*.ts', { cwd: TEST_DIR });
    t.ok(results.some(r => r.endsWith('src/index.ts')),      'finds src/index.ts');
    t.ok(results.some(r => r.endsWith('src/lib/util.ts')),   'finds src/lib/util.ts');
    t.ok(!results.some(r => r.endsWith('test/spec.ts')),     'excludes test/spec.ts');
  });

  it('matches *.md at root', async (t) => {
    const results = await collectGlob(fs, '*.md', { cwd: TEST_DIR });
    t.ok(results.some(r => r.endsWith('README.md')), 'finds README.md');
    t.ok(results.length === 1,                        'only one .md file');
  });

  it('brace expansion {ts,js}', async (t) => {
    const results = await collectGlob(fs, 'src/lib/*.{ts,js}', { cwd: TEST_DIR });
    t.ok(results.some(r => r.endsWith('util.ts')),    'finds util.ts');
    t.ok(results.some(r => r.endsWith('helper.js')),  'finds helper.js');
    t.equal(results.length, 2,                         '2 results');
  });

  it('onlyFiles: true skips directories', async (t) => {
    const results = await collectGlob(fs, '**/*', { cwd: TEST_DIR, onlyFiles: true });
    t.ok(results.every(r => !r.endsWith('src') && !r.endsWith('lib')), 'no bare directories');
  });

  it('onlyDirectories: true yields only directories', async (t) => {
    const results = await collectGlob(fs, '**/*', { cwd: TEST_DIR, onlyDirectories: true });
    t.ok(results.length > 0, 'found some dirs');
    t.ok(results.some(r => r.endsWith('src')),  'found src');
    t.ok(results.some(r => r.endsWith('test')), 'found test');
    t.ok(!results.some(r => r.endsWith('.ts')), 'no .ts files');
  });

  it('AbortSignal cancels the walk', async (t) => {
    const ac = new AbortController();
    ac.abort();
    const results = await collectGlob(fs, '**/*.ts', { cwd: TEST_DIR, signal: ac.signal });
    t.equal(results.length, 0, 'aborted walk yields no results');
  });

  it('non-existent cwd returns no results', async (t) => {
    const results = await collectGlob(fs, '**/*.ts', { cwd: '/nonexistent-path-xyz' });
    t.equal(results.length, 0, 'missing cwd → empty');
  });

  it('pattern with no matches returns empty', async (t) => {
    const results = await collectGlob(fs, '**/*.rust', { cwd: TEST_DIR });
    t.equal(results.length, 0, 'no .rust files');
  });
});
