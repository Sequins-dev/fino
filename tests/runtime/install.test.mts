/**
 * Integration tests for `fino install` and package-map-backed bare imports.
 */

import { before, after, describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { createArchive } from 'fino:archive';
import { serve } from 'fino:net/http/server';
import { Response } from 'fino:net/http';
import { Process, execPath, env } from 'fino:process';

const TEST_DIR = '/tmp/fino-install-test-' + Math.floor(Math.random() * 1_000_000);
const BASE_PORT = 30000 + Math.floor(Math.random() * 20000);

type ArchiveInput = string | Uint8Array | ArrayBuffer;

interface PackageMapShape {
  rootDependencies: Record<string, string>;
  packages: Record<string, { dependencies: Record<string, string> }>;
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
      };

      try {
        server = serve({ port, hostname: '127.0.0.1' }, async (req) => {
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
});
