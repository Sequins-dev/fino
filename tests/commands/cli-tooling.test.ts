/** CLI tooling integration tests. */
import { describe, it } from 'fino:test/test';
import { runCli, withTempProject } from './cli-test-helpers.ts';

describe('CLI commands: tooling', () => {
  it('fmt --check reports changed files without writing', async (t) => {
    await withTempProject(
      { 'src/app.ts': 'const value = "hello";\nif (value) { console.log(value); }\n' },
      async (dir, fs) => {
        const before = await fs.readFile(dir + '/src/app.ts');
        const { stdout, stderr, result } = await runCli(['fmt', '--check'], { cwd: dir });
        const after = await fs.readFile(dir + '/src/app.ts');
        t.equal(result.code, 1, 'fmt --check exits nonzero when files would change');
        t.equal(stdout, '', 'fmt --check failure does not write stdout');
        t.ok(stderr.includes('src/app.ts would reformat'), 'fmt --check reports the changed file');
        t.equal(after, before, 'fmt --check does not write the file');
      },
    );
  });
  it('fmt writes only changed source files', async (t) => {
    await withTempProject(
      {
        'src/app.ts': 'const value = "hello";\nif (value) { console.log(value); }\n',
        'target/generated.ts': 'const value = "ignored";\n',
      },
      async (dir, fs) => {
        const { stdout, stderr, result } = await runCli(['fmt'], { cwd: dir });
        const formatted = await fs.readFile(dir + '/src/app.ts');
        const ignored = await fs.readFile(dir + '/target/generated.ts');
        t.equal(result.code, 0, 'fmt exits successfully');
        t.equal(stderr, '', 'fmt success does not write stderr');
        t.ok(stdout.includes('formatted 1 file'), 'fmt reports changed files');
        t.equal(
          formatted,
          "const value = 'hello';\nif (value) {\n  console.log(value);\n}\n",
          'fmt writes formatted source',
        );
        t.equal(ignored, 'const value = "ignored";\n', 'fmt ignores generated output directories');
      },
    );
  });
  it('fmt accepts explicit glob inputs', async (t) => {
    await withTempProject(
      {
        'src/app.ts': 'const value = "hello";\n',
        'other/app.ts': 'const value = "unchanged";\n',
      },
      async (dir, fs) => {
        const { stdout, stderr, result } = await runCli(['fmt', 'src/*.ts'], { cwd: dir });
        const formatted = await fs.readFile(dir + '/src/app.ts');
        const untouched = await fs.readFile(dir + '/other/app.ts');
        t.equal(result.code, 0, 'fmt exits successfully for explicit glob');
        t.equal(stderr, '', 'fmt explicit glob does not write stderr');
        t.ok(stdout.includes('formatted 1 file'), 'fmt explicit glob reports changed files');
        t.equal(formatted, "const value = 'hello';\n", 'fmt writes matched file');
        t.equal(untouched, 'const value = "unchanged";\n', 'fmt leaves unmatched source alone');
      },
    );
  });
  it('fmt fails missing explicit directory and glob inputs without writing', async (t) => {
    await withTempProject({ 'src/app.ts': 'const value = "hello";\n' }, async (dir, fs) => {
      const before = await fs.readFile(dir + '/src/app.ts');
      for (const [label, args] of [
        ['missing directory', ['fmt', 'missing-dir']],
        ['missing glob', ['fmt', 'src/missing-*.ts']],
      ] as [string, string[]][]) {
        const { stdout, stderr, result } = await runCli(args, { cwd: dir });
        const after = await fs.readFile(dir + '/src/app.ts');
        t.equal(result.code, 1, `fmt ${label} exits nonzero`);
        t.equal(stdout, '', `fmt ${label} does not write stdout`);
        t.ok(stderr.includes('fino fmt:'), `fmt ${label} reports command failure`);
        t.equal(after, before, `fmt ${label} does not write unrelated source`);
      }
    });
  });
  it('fmt reports parse diagnostics with file locations', async (t) => {
    await withTempProject({ 'src/broken.ts': 'export function broken( {\n' }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['fmt'], { cwd: dir });
      t.equal(result.code, 1, 'fmt exits nonzero for parse diagnostics');
      t.equal(stdout, '', 'fmt diagnostics do not write stdout');
      t.ok(stderr.includes('src/broken.ts'), 'diagnostics include the relative file path');
      t.ok(stderr.includes('1:1'), 'diagnostics include a source location');
      t.ok(stderr.includes('error parse'), 'diagnostics include severity and code');
      t.ok(stderr.includes('fino fmt:'), 'command error summary is printed');
    });
  });
  it('fmt recursively discovers source directories and ignores hidden and build output', async (t) => {
    await withTempProject(
      {
        'src/app.ts': 'const value = "hello";\n',
        'src/nested/view.ts': 'const view = "ok";\n',
        '.hidden/ignored.ts': 'const value = "hidden";\n',
        'build/ignored.ts': 'const value = "build";\n',
        'dist/ignored.ts': 'const value = "dist";\n',
        'target/ignored.ts': 'const value = "target";\n',
      },
      async (dir, fs) => {
        const { stdout, stderr, result } = await runCli(['fmt'], { cwd: dir });
        const app = await fs.readFile(dir + '/src/app.ts');
        const view = await fs.readFile(dir + '/src/nested/view.ts');
        const hidden = await fs.readFile(dir + '/.hidden/ignored.ts');
        const build = await fs.readFile(dir + '/build/ignored.ts');
        const dist = await fs.readFile(dir + '/dist/ignored.ts');
        const target = await fs.readFile(dir + '/target/ignored.ts');
        t.equal(result.code, 0, 'fmt exits successfully');
        t.equal(stderr, '', 'fmt recursive discovery does not write stderr');
        t.ok(stdout.includes('formatted 2 files'), 'fmt reports both discovered source files');
        t.equal(app, "const value = 'hello';\n", 'fmt formats nested source under cwd');
        t.equal(view, "const view = 'ok';\n", 'fmt formats recursively discovered nested source');
        t.equal(hidden, 'const value = "hidden";\n', 'fmt ignores hidden directories');
        t.equal(build, 'const value = "build";\n', 'fmt ignores build directories');
        t.equal(dist, 'const value = "dist";\n', 'fmt ignores dist directories');
        t.equal(target, 'const value = "target";\n', 'fmt ignores target directories');
      },
    );
  });
  it('fmt discovery uses supported extensions, recursion, ignores, sorting, and dedupe', async (t) => {
    await withTempProject(
      {
        'src/b.ts': 'const b = "b";\n',
        'src/a.ts': 'const a = "a";\n',
        'src/nested/c.jsx': 'const c = "c";\n',
        'src/unsupported.json': '{"quote":"double"}\n',
        '.hidden/d.ts': 'const d = "d";\n',
        'node_modules/pkg/e.ts': 'const e = "e";\n',
      },
      async (dir, fs) => {
        const { stdout, stderr, result } = await runCli(['fmt', 'src/b.ts', 'src', 'src/*.ts'], {
          cwd: dir,
        });
        const a = await fs.readFile(dir + '/src/a.ts');
        const b = await fs.readFile(dir + '/src/b.ts');
        const c = await fs.readFile(dir + '/src/nested/c.jsx');
        const unsupported = await fs.readFile(dir + '/src/unsupported.json');
        const hidden = await fs.readFile(dir + '/.hidden/d.ts');
        const ignored = await fs.readFile(dir + '/node_modules/pkg/e.ts');
        t.equal(result.code, 0, 'fmt exits successfully for mixed explicit inputs');
        t.equal(stderr, '', 'fmt mixed discovery does not write stderr');
        t.ok(
          stdout.includes('formatted 3 files'),
          'fmt de-dupes overlapping file, directory, and glob inputs',
        );
        t.equal(a, "const a = 'a';\n", 'fmt includes supported .ts files');
        t.equal(b, "const b = 'b';\n", 'fmt includes supported .ts files once');
        t.equal(c, "const c = 'c';\n", 'fmt recursively includes supported nested files');
        t.equal(unsupported, '{"quote":"double"}\n', 'fmt ignores unsupported extensions');
        t.equal(hidden, 'const d = "d";\n', 'fmt ignores hidden directories');
        t.equal(ignored, 'const e = "e";\n', 'fmt ignores built-in ignored directories');
      },
    );
  });
  it('lint reports diagnostics and lint --fix does not format', async (t) => {
    await withTempProject(
      { 'src/app.ts': 'debugger;\nexport const value = "hello";\n' },
      async (dir, fs) => {
        const linted = await runCli(['lint'], { cwd: dir });
        t.equal(linted.result.code, 1, 'lint exits nonzero for diagnostics');
        t.ok(linted.stderr.includes('no-debugger'), 'lint reports rule code');
        const fixed = await runCli(['lint', '--fix'], { cwd: dir });
        const after = await fs.readFile(dir + '/src/app.ts');
        t.equal(fixed.result.code, 0, 'lint --fix exits successfully after applying safe fixes');
        t.ok(
          fixed.stdout.includes('fino lint: fixed 1 file, 0 remaining'),
          'lint --fix reports applied fixes',
        );
        t.equal(fixed.stderr, '', 'lint --fix does not report diagnostics removed by fixes');
        t.equal(after.includes('debugger'), false, 'lint --fix removes the debugger statement');
        t.ok(
          after.includes('export const value = "hello";'),
          'lint --fix does not reformat unaffected source',
        );
      },
    );
  });
  it('lint fails missing explicit directory and glob inputs without writing', async (t) => {
    await withTempProject({ 'src/app.ts': 'const value = "hello";\n' }, async (dir, fs) => {
      const before = await fs.readFile(dir + '/src/app.ts');
      for (const [label, args] of [
        ['missing directory', ['lint', 'missing-dir']],
        ['missing glob', ['lint', 'src/missing-*.ts']],
      ] as [string, string[]][]) {
        const { stdout, stderr, result } = await runCli(args, { cwd: dir });
        const after = await fs.readFile(dir + '/src/app.ts');
        t.equal(result.code, 1, `lint ${label} exits nonzero`);
        t.equal(stdout, '', `lint ${label} does not write stdout`);
        t.ok(stderr.includes('fino lint:'), `lint ${label} reports command failure`);
        t.equal(after, before, `lint ${label} does not write unrelated source`);
      }
    });
  });
  it('lint reports files in sorted de-duplicated discovery order', async (t) => {
    await withTempProject(
      {
        'src/b.ts': 'debugger;\n',
        'src/a.ts': 'debugger;\n',
        'src/nested/c.ts': 'debugger;\n',
        'src/ignored.json': '{"debugger":true}\n',
        '.hidden/d.ts': 'debugger;\n',
        'dist/e.ts': 'debugger;\n',
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['lint', 'src/b.ts', 'src', 'src/*.ts'], {
          cwd: dir,
        });
        const first = stderr.indexOf('src/a.ts');
        const second = stderr.indexOf('src/b.ts');
        const third = stderr.indexOf('src/nested/c.ts');
        t.equal(result.code, 1, 'lint exits nonzero for discovered diagnostics');
        t.equal(stdout, '', 'lint diagnostics do not write stdout');
        t.ok(
          first !== -1 && second !== -1 && third !== -1,
          'lint reports all supported discovered files',
        );
        t.ok(first < second && second < third, 'lint reports discovered files in sorted order');
        t.equal(
          stderr.indexOf('src/b.ts'),
          stderr.lastIndexOf('src/b.ts'),
          'lint de-dupes overlapping inputs',
        );
        t.notOk(stderr.includes('src/ignored.json'), 'lint ignores unsupported extensions');
        t.notOk(stderr.includes('.hidden/d.ts'), 'lint ignores hidden directories');
        t.notOk(stderr.includes('dist/e.ts'), 'lint ignores built-in ignored directories');
      },
    );
  });
});
