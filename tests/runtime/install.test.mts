/**
 * Integration tests for `fino install` and package-map-backed bare imports.
 */

import { before, after, describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { createArchive } from 'fino:archive';
import { serveHttp } from 'fino:net/http/server';
import { Process, execPath, env } from 'fino:process';

const TEST_DIR = '/tmp/fino-install-test-' + Math.floor(Math.random() * 1_000_000);
const BASE_PORT = 30000 + Math.floor(Math.random() * 20000);

type ArchiveInput = string | Uint8Array | ArrayBuffer;

interface PackageMapShape {
  rootDependencies: Record<string, string>;
  packages: Record<string, { dir?: string; entrypoints?: Record<string, string>; dependencies: Record<string, string> }>;
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
  if (!path || path === '/') return;
  if (await exists(fs, path)) return;
  const idx = path.lastIndexOf('/');
  if (idx > 0) await ensureDir(fs, path.slice(0, idx));
  if (!(await exists(fs, path))) await fs.mkdir(path);
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

async function createPackageTarball(fs: DiskFileSystem, tarballPath: string, files: Record<string, ArchiveInput>): Promise<void> {
  await ensureDir(fs, tarballPath.slice(0, tarballPath.lastIndexOf('/')));
  const archive = await createArchive(tarballPath);
  for (const [name, value] of Object.entries(files)) {
    await archive.write(name, value);
  }
  await archive.close();
}

async function runCli(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; result: Awaited<ReturnType<Process['wait']>> }> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...env, ...extraEnv })) {
    if (value !== undefined) childEnv[key] = value;
  }
  const proc = new Process(execPath, args, {
    cwd,
    env: childEnv,
  });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return { stdout, stderr, result };
}

describe('fino install', () => {
  let fs: DiskFileSystem;
  let server: ReturnType<typeof serve> | null = null;
  let appDir: string;
  let registryDir: string;
  let port: number;

  before(async () => {
    fs = new DiskFileSystem();
    await fs.mkdir(TEST_DIR);
    appDir = TEST_DIR + '/app';
    registryDir = TEST_DIR + '/registry';
    await fs.mkdir(appDir);
    await fs.mkdir(registryDir);

    await createPackageTarball(fs, registryDir + '/dep-1.0.0.tgz', {
      'package/package.json': JSON.stringify({
        name: 'dep',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
        },
      }, null, 2),
      'package/index.js': 'export default "dep-value";\n',
    });

    await createPackageTarball(fs, registryDir + '/dep-1.5.0.tgz', {
      'package/package.json': JSON.stringify({
        name: 'dep',
        version: '1.5.0',
        type: 'module',
        exports: {
          '.': './index.js',
        },
      }, null, 2),
      'package/index.js': 'export default "dep-1.5.0";\n',
    });

    await createPackageTarball(fs, registryDir + '/pkg-1.0.0.tgz', {
      'package/package.json': JSON.stringify({
        name: 'pkg',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
          './feature': './feature.js',
        },
        dependencies: {
          dep: '^1.0.0',
        },
      }, null, 2),
      'package/index.js': 'import dep from "dep"; export const value = dep + "+pkg"; export default value;\n',
      'package/feature.js': 'export default "feature-ok";\n',
    });

    await createPackageTarball(fs, registryDir + '/optional-parent-1.0.0.tgz', {
      'package/package.json': JSON.stringify({
        name: 'optional-parent',
        version: '1.0.0',
        type: 'module',
        main: './index.js',
        optionalDependencies: {
          'missing-optional': '^1.0.0',
        },
        peerDependencies: {
          'peer-missing': '^2.0.0',
        },
      }, null, 2),
      'package/index.js': 'export default "optional-parent-ok";\n',
    });

    await createPackageTarball(fs, registryDir + '/exports-pkg-1.0.0.tgz', {
      'package/package.json': JSON.stringify({
        name: 'exports-pkg',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
          './features/*': './dist/*.js',
          './conditional': {
            default: './default.js',
            import: './import.js',
          },
        },
      }, null, 2),
      'package/index.js': 'export default "exports-root";\n',
      'package/dist/alpha.js': 'export default "pattern-alpha";\n',
      'package/import.js': 'export default "import-condition";\n',
      'package/default.js': 'export default "default-condition";\n',
    });

    await createPackageTarball(fs, registryDir + '/fallback-pkg-1.0.0.tgz', {
      'package/package.json': JSON.stringify({
        name: 'fallback-pkg',
        version: '1.0.0',
        type: 'module',
        module: './module.js',
        main: './main.js',
      }, null, 2),
      'package/module.js': 'export default "module-entry";\n',
      'package/main.js': 'export default "main-entry";\n',
    });

    await createPackageTarball(fs, registryDir + '/deep-pkg-1.0.0.tgz', {
      'package/package.json': JSON.stringify({
        name: 'deep-pkg',
        version: '1.0.0',
        type: 'module',
      }, null, 2),
      'package/index.js': 'export default "deep-root";\n',
      'package/lib/tool.js': 'export default "deep-tool";\n',
    });

    await createPackageTarball(fs, registryDir + '/imports-pkg-1.0.0.tgz', {
      'package/package.json': JSON.stringify({
        name: 'imports-pkg',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
        },
        imports: {
          '#internal': './internal.js',
        },
      }, null, 2),
      'package/index.js': 'import value from "#internal"; export default value;\n',
      'package/internal.js': 'export default "internal-import";\n',
    });

    for (let offset = 0; offset < 200; offset++) {
      port = BASE_PORT + offset;
      const packuments: Record<string, unknown> = {
        '/pkg': {
          name: 'pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'pkg',
              version: '1.0.0',
              dist: { tarball: `http://127.0.0.1:${port}/tarballs/pkg-1.0.0.tgz` },
            },
          },
        },
        '/dep': {
          name: 'dep',
          'dist-tags': { latest: '1.5.0' },
          versions: {
            '1.0.0': {
              name: 'dep',
              version: '1.0.0',
              dist: { tarball: `http://127.0.0.1:${port}/tarballs/dep-1.0.0.tgz` },
            },
            '1.5.0': {
              name: 'dep',
              version: '1.5.0',
              dist: { tarball: `http://127.0.0.1:${port}/tarballs/dep-1.5.0.tgz` },
            },
          },
        },
        '/optional-parent': {
          name: 'optional-parent',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'optional-parent',
              version: '1.0.0',
              dist: { tarball: `http://127.0.0.1:${port}/tarballs/optional-parent-1.0.0.tgz` },
            },
          },
        },
        '/exports-pkg': {
          name: 'exports-pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'exports-pkg',
              version: '1.0.0',
              dist: { tarball: `http://127.0.0.1:${port}/tarballs/exports-pkg-1.0.0.tgz` },
            },
          },
        },
        '/fallback-pkg': {
          name: 'fallback-pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'fallback-pkg',
              version: '1.0.0',
              dist: { tarball: `http://127.0.0.1:${port}/tarballs/fallback-pkg-1.0.0.tgz` },
            },
          },
        },
        '/deep-pkg': {
          name: 'deep-pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'deep-pkg',
              version: '1.0.0',
              dist: { tarball: `http://127.0.0.1:${port}/tarballs/deep-pkg-1.0.0.tgz` },
            },
          },
        },
        '/imports-pkg': {
          name: 'imports-pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'imports-pkg',
              version: '1.0.0',
              dist: { tarball: `http://127.0.0.1:${port}/tarballs/imports-pkg-1.0.0.tgz` },
            },
          },
        },
        '/corrupt-pkg': {
          name: 'corrupt-pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'corrupt-pkg',
              version: '1.0.0',
              dist: { tarball: `http://127.0.0.1:${port}/tarballs/corrupt-pkg-1.0.0.tgz` },
            },
          },
        },
      };

      try {
        server = serveHttp({ port, hostname: '127.0.0.1' }, async (req) => {
          const url = new URL(req.url);
          if (packuments[url.pathname]) {
            return Response.json(packuments[url.pathname], {});
          }
          if (url.pathname === '/tarballs/pkg-1.0.0.tgz') {
            const file = await fs.open(registryDir + '/pkg-1.0.0.tgz', 'r');
            try {
              return new Response(await file.bytes(), {
                headers: { 'content-type': 'application/octet-stream' },
              });
            } finally {
              await file.close();
            }
          }
          if (url.pathname === '/tarballs/dep-1.0.0.tgz') {
            const file = await fs.open(registryDir + '/dep-1.0.0.tgz', 'r');
            try {
              return new Response(await file.bytes(), {
                headers: { 'content-type': 'application/octet-stream' },
              });
            } finally {
              await file.close();
            }
          }
          if (url.pathname === '/tarballs/dep-1.5.0.tgz') {
            const file = await fs.open(registryDir + '/dep-1.5.0.tgz', 'r');
            try {
              return new Response(await file.bytes(), {
                headers: { 'content-type': 'application/octet-stream' },
              });
            } finally {
              await file.close();
            }
          }
          if (url.pathname === '/tarballs/optional-parent-1.0.0.tgz') {
            const file = await fs.open(registryDir + '/optional-parent-1.0.0.tgz', 'r');
            try {
              return new Response(await file.bytes(), {
                headers: { 'content-type': 'application/octet-stream' },
              });
            } finally {
              await file.close();
            }
          }
          if (url.pathname === '/tarballs/exports-pkg-1.0.0.tgz') {
            const file = await fs.open(registryDir + '/exports-pkg-1.0.0.tgz', 'r');
            try {
              return new Response(await file.bytes(), {
                headers: { 'content-type': 'application/octet-stream' },
              });
            } finally {
              await file.close();
            }
          }
          if (url.pathname === '/tarballs/fallback-pkg-1.0.0.tgz') {
            const file = await fs.open(registryDir + '/fallback-pkg-1.0.0.tgz', 'r');
            try {
              return new Response(await file.bytes(), {
                headers: { 'content-type': 'application/octet-stream' },
              });
            } finally {
              await file.close();
            }
          }
          if (url.pathname === '/tarballs/deep-pkg-1.0.0.tgz') {
            const file = await fs.open(registryDir + '/deep-pkg-1.0.0.tgz', 'r');
            try {
              return new Response(await file.bytes(), {
                headers: { 'content-type': 'application/octet-stream' },
              });
            } finally {
              await file.close();
            }
          }
          if (url.pathname === '/tarballs/imports-pkg-1.0.0.tgz') {
            const file = await fs.open(registryDir + '/imports-pkg-1.0.0.tgz', 'r');
            try {
              return new Response(await file.bytes(), {
                headers: { 'content-type': 'application/octet-stream' },
              });
            } finally {
              await file.close();
            }
          }
          if (url.pathname === '/tarballs/corrupt-pkg-1.0.0.tgz') {
            return new Response('this is not a tarball', {
              headers: { 'content-type': 'application/octet-stream' },
            });
          }
          return new Response('not found', { status: 404 });
        });
        break;
      } catch (error) {
        if (offset === 199) throw error;
      }
    }
  });

  after(async () => {
    if (server) await server.close();
    await removeTree(fs, TEST_DIR);
  });

  it('installs explicit packages, writes package.json, and resolves bare imports via package map', async (t) => {
    await fs.writeFile(appDir + '/package.json', JSON.stringify({
      name: 'fixture-app',
      type: 'module',
    }, null, 2));
    await fs.writeFile(appDir + '/index.mts', [
      'import pkgValue, { value } from "pkg";',
      'import feature from "pkg/feature";',
      'console.log(pkgValue);',
      'console.log(value);',
      'console.log(feature);',
      '',
    ].join('\n'));

    const install = await runCli([
      'install',
      'pkg@^1.0.0',
    ], appDir, {
      FINO_NPM_REGISTRY: `http://127.0.0.1:${port}`,
    });

    t.equal(install.result.code, 0, 'install exits successfully');
    t.equal(install.stderr, '', 'install has no stderr');

    const packageJson = JSON.parse(await fs.readFile(appDir + '/package.json'));
    t.equal(packageJson.dependencies.pkg, '^1.0.0', 'requested range preserved in package.json');

    const packageMap = JSON.parse(await fs.readFile(appDir + '/.fino/package-map.json')) as PackageMapShape;
    t.equal(packageMap.rootDependencies.pkg, 'pkg@1.0.0', 'root dependency locked in package map');
    t.equal(packageMap.packages['pkg@1.0.0']!.dependencies.dep, 'dep@1.0.0', 'transitive dependency locked');

    const run = await runCli([
      'index.mts',
    ], appDir, {
      FINO_NPM_REGISTRY: `http://127.0.0.1:${port}`,
    });

    t.equal(run.result.code, 0, 'script using bare imports exits successfully');
    t.equal(run.stderr, '', 'script import run has no stderr');
    t.ok(run.stdout.includes('dep-value+pkg'), 'package default export resolved');
    t.ok(run.stdout.includes('feature-ok'), 'package subpath export resolved');
  });

  it('supports comparator ranges when resolving transitive dependencies', async (t) => {
    await fs.writeFile(appDir + '/package.json', JSON.stringify({
      name: 'fixture-app',
      type: 'module',
      dependencies: {
        pkg: '1.0.0',
      },
    }, null, 2));

    const pkgTarball = registryDir + '/pkg-1.0.0.tgz';
    await createPackageTarball(fs, pkgTarball, {
      'package/package.json': JSON.stringify({
        name: 'pkg',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
        },
        dependencies: {
          dep: '>=1.0.0 <2.0.0',
        },
      }, null, 2),
      'package/index.js': 'import dep from "dep"; export default dep;\n',
    });

    const install = await runCli([
      'install',
    ], appDir, {
      FINO_NPM_REGISTRY: `http://127.0.0.1:${port}`,
    });

    t.equal(install.result.code, 0, 'install exits successfully');

    const packageMap = JSON.parse(await fs.readFile(appDir + '/.fino/package-map.json')) as PackageMapShape;
    t.equal(packageMap.packages['pkg@1.0.0']!.dependencies.dep, 'dep@1.5.0', 'highest comparator match selected');
  });

  it('resolves package-map entrypoints and reports missing records/subpaths', async (t) => {
    const manualDir = TEST_DIR + '/manual-map';
    await fs.mkdir(manualDir);
    await ensureDir(fs, manualDir + '/.fino/packages/pkg');
    await fs.writeFile(manualDir + '/package.json', JSON.stringify({ type: 'module' }, null, 2));
    await fs.writeFile(manualDir + '/.fino/packages/pkg/index.js', 'export default "pkg-index";\n');
    await fs.writeFile(manualDir + '/.fino/packages/pkg/package-json.js', 'export default "pkg-package-json";\n');
    await fs.writeFile(manualDir + '/.fino/packages/pkg/deep.js', 'export default "pkg-deep";\n');
    await fs.writeFile(manualDir + '/.fino/package-map.json', JSON.stringify({
      version: 1,
      root: manualDir,
      rootDependencies: {
        pkg: 'pkg@1.0.0',
        missing: 'missing@1.0.0',
      },
      packages: {
        'pkg@1.0.0': {
          dir: '.fino/packages/pkg',
          dependencies: {},
          entrypoints: {
            '.': 'index.js',
            './package.json': 'package-json.js',
            './deep': 'deep.js',
          },
        },
      },
    }, null, 2));
    await fs.writeFile(manualDir + '/ok.mts', [
      'import pkg from "pkg";',
      'import packageJson from "pkg/package.json";',
      'import deep from "pkg/deep";',
      'console.log(pkg + "|" + packageJson + "|" + deep);',
      '',
    ].join('\n'));
    await fs.writeFile(manualDir + '/missing-record.mts', 'import "missing";\n');
    await fs.writeFile(manualDir + '/missing-subpath.mts', 'import "pkg/not-exported";\n');

    const ok = await runCli(['ok.mts'], manualDir);
    t.equal(ok.result.code, 0, 'manual package map script exits successfully');
    t.equal(ok.stderr, '', 'manual package map script has no stderr');
    t.ok(ok.stdout.includes('pkg-index|pkg-package-json|pkg-deep'), 'bare, package JSON, and deep entrypoints resolved');

    const missingRecord = await runCli(['missing-record.mts'], manualDir);
    t.equal(missingRecord.result.code, 1, 'missing package record exits nonzero');
    t.ok(missingRecord.stderr.includes("missing package-map record for 'missing@1.0.0'"), 'missing record is reported');

    const missingSubpath = await runCli(['missing-subpath.mts'], manualDir);
    t.equal(missingSubpath.result.code, 1, 'missing package subpath exits nonzero');
    t.ok(missingSubpath.stderr.includes("Cannot resolve package subpath 'pkg/not-exported'"), 'missing subpath is reported');
  });

  it('warns for optional and peer dependencies without installing peers', async (t) => {
    await fs.writeFile(appDir + '/package.json', JSON.stringify({
      name: 'fixture-app',
      type: 'module',
      dependencies: {
        'optional-parent': '1.0.0',
      },
    }, null, 2));

    const install = await runCli(['install'], appDir, {
      FINO_NPM_REGISTRY: `http://127.0.0.1:${port}`,
    });

    t.equal(install.result.code, 0, 'optional failure does not fail install');
    t.ok(install.stderr.includes('optional dependency failed: missing-optional@^1.0.0'), 'optional failure warning is printed');
    t.ok(install.stderr.includes('peer dependency not installed automatically: optional-parent -> peer-missing'), 'peer warning is printed');

    const packageMap = JSON.parse(await fs.readFile(appDir + '/.fino/package-map.json')) as PackageMapShape;
    t.equal(packageMap.rootDependencies['optional-parent'], 'optional-parent@1.0.0', 'parent package is installed');
    t.equal(packageMap.packages['optional-parent@1.0.0']!.dependencies['missing-optional'], undefined, 'failed optional dependency is omitted');
    t.equal(packageMap.packages['optional-parent@1.0.0']!.dependencies['peer-missing'], undefined, 'peer dependency is not installed');
  });

  it('generates package-map entries for export patterns, conditional exports, fallback entries, and deep imports', async (t) => {
    await fs.writeFile(appDir + '/package.json', JSON.stringify({
      name: 'fixture-app',
      type: 'module',
      dependencies: {
        'exports-pkg': '1.0.0',
        'fallback-pkg': '1.0.0',
        'deep-pkg': '1.0.0',
      },
    }, null, 2));
    await fs.writeFile(appDir + '/entrypoints.mts', [
      'import root from "exports-pkg";',
      'import pattern from "exports-pkg/features/alpha";',
      'import conditional from "exports-pkg/conditional";',
      'import fallback from "fallback-pkg";',
      'import deep from "deep-pkg/lib/tool";',
      'console.log([root, pattern, conditional, fallback, deep].join("|"));',
      '',
    ].join('\n'));

    const install = await runCli(['install'], appDir, {
      FINO_NPM_REGISTRY: `http://127.0.0.1:${port}`,
    });
    t.equal(install.result.code, 0, 'install exits successfully');
    t.equal(install.stderr, '', 'entrypoint install has no warnings');

    const packageMap = JSON.parse(await fs.readFile(appDir + '/.fino/package-map.json')) as PackageMapShape;
    t.equal(packageMap.packages['exports-pkg@1.0.0']!.entrypoints!['./features/alpha'], 'dist/alpha.js', 'exports pattern is expanded');
    t.equal(packageMap.packages['exports-pkg@1.0.0']!.entrypoints!['./conditional'], 'import.js', 'import condition wins over default');
    t.equal(packageMap.packages['fallback-pkg@1.0.0']!.entrypoints!['.'], 'module.js', 'module fallback wins over main');
    t.equal(packageMap.packages['deep-pkg@1.0.0']!.entrypoints!['./lib/tool'], 'lib/tool.js', 'deep import without exports is mapped');

    const run = await runCli(['entrypoints.mts'], appDir);
    t.equal(run.result.code, 0, 'script using generated entrypoints exits successfully');
    t.equal(run.stderr, '', 'entrypoint script has no stderr');
    t.ok(run.stdout.includes('exports-root|pattern-alpha|import-condition|module-entry|deep-tool'), 'all generated entrypoints resolve at runtime');
  });

  it('does not implement package imports or # specifiers from installed package metadata', async (t) => {
    await fs.writeFile(appDir + '/package.json', JSON.stringify({
      name: 'fixture-app',
      type: 'module',
      dependencies: {
        'imports-pkg': '1.0.0',
      },
    }, null, 2));
    await fs.writeFile(appDir + '/imports-entry.mts', [
      'import value from "imports-pkg";',
      'console.log(value);',
      '',
    ].join('\n'));

    const install = await runCli(['install'], appDir, {
      FINO_NPM_REGISTRY: `http://127.0.0.1:${port}`,
    });
    t.equal(install.result.code, 0, 'install succeeds even when package metadata has imports');

    const packageMap = JSON.parse(await fs.readFile(appDir + '/.fino/package-map.json')) as PackageMapShape;
    t.equal(packageMap.packages['imports-pkg@1.0.0']!.entrypoints!['.'], 'index.js', 'root export is mapped');
    t.equal(packageMap.packages['imports-pkg@1.0.0']!.entrypoints!['#internal'], undefined, 'package imports are not added to package map');

    const run = await runCli(['imports-entry.mts'], appDir);
    t.equal(run.result.code, 1, 'package # import fails at runtime');
    t.ok(run.stderr.includes("Cannot resolve package '#internal'") || run.stderr.includes("Cannot resolve module '#internal'"), 'unsupported # specifier is reported');
  });

  it('cleans up temporary archive and package directories after corrupt tarball extraction failure', async (t) => {
    await fs.writeFile(appDir + '/package.json', JSON.stringify({
      name: 'fixture-app',
      type: 'module',
      dependencies: {
        'corrupt-pkg': '1.0.0',
      },
    }, null, 2));

    const install = await runCli(['install'], appDir, {
      FINO_NPM_REGISTRY: `http://127.0.0.1:${port}`,
    });

    t.equal(install.result.code, 1, 'corrupt tarball install fails');
    t.equal(await exists(fs, appDir + '/.fino/tmp/corrupt-pkg@1.0.0.tgz'), false, 'temporary tarball is removed');
    t.equal(await exists(fs, appDir + '/.fino/tmp/corrupt-pkg@1.0.0-extract'), false, 'temporary extract directory is removed');
    t.equal(await exists(fs, appDir + '/.fino/packages/corrupt-pkg@1.0.0'), false, 'final package directory is not left behind');
  });
});
