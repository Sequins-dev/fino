import { describe, it } from 'fino:test/test';
import { Realm, ImportMap } from 'fino:realm';
import { DiskFileSystem } from 'fino:file';

const entry = new URL('./fixtures/enforcement-entry.ts', import.meta.url).pathname;
const target = new URL('./fixtures/enforcement-target.ts', import.meta.url);

async function rejection(realm: Realm): Promise<string> {
  try {
    await realm.run();
    return 'IMPORT SUCCEEDED';
  } catch (error) {
    return String(error);
  }
}

describe('Import authorization before module reuse', () => {
  for (const dynamic of [false, true]) {
    for (const warm of [false, true]) {
      it(`denies internal imports (${dynamic ? 'dynamic' : 'static'}, ${warm ? 'warm' : 'cold'})`, async (t) => {
        const code = `${warm ? "import 'fino:realm';" : ''}
          ${dynamic ? "await import('internal:realm-native');" : "import 'internal:realm-native';"}`;
        // The test runner explicitly permits internal imports for its own fixtures.
        // Restore the user-code restriction in this child.
        const realm = Realm.fromSource(code, {
          specifier: entry,
          overrides: new ImportMap([{ pattern: 'internal:*', directive: 'block' }]),
        });
        const result = await rejection(realm);
        t.ok(result.includes('blocked'), 'private host bridge stays private: ' + result);
      });
    }
    for (const warm of [false, true]) {
      it(`checks importer policy for public builtins (${dynamic ? 'dynamic' : 'static'}, ${warm ? 'warm' : 'cold'})`, async (t) => {
        const realm = Realm.fromSource(
          `${warm ? "import './enforcement-warm.ts';" : ''}
           ${dynamic ? "await import('fino:format/csv');" : "import 'fino:format/csv';"}`,
          {
            specifier: entry,
            overrides: new ImportMap([
              {
                from: new URL('./fixtures/enforcement-entry.ts', import.meta.url).href,
                pattern: 'fino:format/csv',
                directive: 'block',
              },
            ]),
          },
        );
        t.ok(
          (await rejection(realm)).includes('blocked'),
          'cache identity does not grant permission',
        );
      });
    }
    for (const spec of [
      './enforcement-target.ts',
      target.pathname,
      target.href,
      'enforcement-package',
    ]) {
      it(`blocks ${spec} (${dynamic ? 'dynamic' : 'static'})`, async (t) => {
        const realm = Realm.fromSource(
          dynamic ? `await import(${JSON.stringify(spec)});` : `import ${JSON.stringify(spec)};`,
          {
            specifier: entry,
            overrides: new ImportMap([{ pattern: spec, directive: 'block' }]),
          },
        );
        t.ok((await rejection(realm)).includes('blocked'), 'denied before resolution or execution');
      });
    }
    it(`blocks canonical file aliases (${dynamic ? 'dynamic' : 'static'})`, async (t) => {
      const spec = './enforcement-target.ts';
      const realm = Realm.fromSource(dynamic ? `await import('${spec}');` : `import '${spec}';`, {
        specifier: entry,
        overrides: new ImportMap([{ pattern: target.href, directive: 'block' }]),
      });
      t.ok(
        (await rejection(realm)).includes('blocked'),
        'canonical URL denial applies to relative aliases',
      );
    });
    it(`blocks remap targets (${dynamic ? 'dynamic' : 'static'})`, async (t) => {
      const realm = Realm.fromSource(
        dynamic ? "await import('virtual:blocked');" : "import 'virtual:blocked';",
        {
          specifier: entry,
          overrides: new ImportMap([
            { pattern: 'virtual:blocked', directive: { type: 'remap', target: target.href } },
            { pattern: target.href, directive: 'block' },
          ]),
        },
      );
      t.ok((await rejection(realm)).includes('blocked'), 'remapping cannot bypass target policy');
    });
  }
  it('allows a builtin-named remap to an authorized filesystem module', async (t) => {
    for (const dynamic of [false, true]) {
      await Realm.fromSource(
        dynamic ? "await import('fino:enforcement-alias');" : "import 'fino:enforcement-alias';",
        {
          specifier: entry,
          overrides: new ImportMap([
            {
              pattern: 'fino:enforcement-alias',
              directive: { type: 'remap', target: target.href },
            },
          ]),
        },
      ).run();
    }
    t.ok(true, 'authorized file remaps compose with builtin resolution');
  });
  it('enforces package names and canonical package targets', async (t) => {
    const fs = new DiskFileSystem();
    const temporaryRoot = `/tmp/fino-import-enforcement-${crypto.randomUUID()}`;
    await fs.mkdir(temporaryRoot);
    const root = await fs.realpath(temporaryRoot);
    await fs.mkdir(root + '/.fino');
    const write = (path: string, value: string) =>
      fs.writeFile(path, new TextEncoder().encode(value));
    await write(root + '/pkg.ts', 'export const marker = true;');
    await write(
      root + '/.fino/package-map.json',
      JSON.stringify({
        root,
        rootDependencies: { pkg: 'pkg@1' },
        packages: { 'pkg@1': { dir: '.', entrypoints: { '.': 'pkg.ts' }, dependencies: {} } },
      }),
    );
    try {
      for (const dynamic of [false, true]) {
        const code = dynamic ? "await import('pkg');" : "import 'pkg';";
        await Realm.fromSource(code, { root, specifier: root + '/entry.ts' }).run();
        for (const pattern of ['pkg', new URL('file://' + root + '/pkg.ts').href]) {
          const realm = Realm.fromSource(code, {
            root,
            specifier: root + '/entry.ts',
            overrides: new ImportMap([{ pattern, directive: 'block' }]),
          });
          t.ok((await rejection(realm)).includes('blocked'), `${pattern} is denied`);
        }
      }
    } finally {
      await fs.unlink(root + '/pkg.ts');
      await fs.unlink(root + '/.fino/package-map.json');
      await fs.rmdir(root + '/.fino');
      await fs.rmdir(root);
    }
  });
  it('preserves public builtin composition and allowed file imports', async (t) => {
    await Realm.fromSource("import 'fino:realm'; import './enforcement-target.ts';", {
      specifier: entry,
    }).run();
    t.ok(true);
  });
});
