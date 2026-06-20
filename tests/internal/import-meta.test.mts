/**
 * Tests for import.meta enrichment.
 *
 * import.meta provides per-module metadata:
 *   url       — file:// URL of the module
 *   filename  — absolute filesystem path
 *   dirname   — parent directory of the module
 *   resolve() — resolves a specifier relative to this module's location
 */

import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process, env, execPath } from 'fino:process';

const meta = import.meta as ImportMeta & {
  filename: string;
  dirname: string;
  resolve(specifier: string): string;
};

// The test file itself is the module under test — import.meta refers to this file.
const thisFile = meta.filename;
const thisDir  = meta.dirname;
const thisUrl  = meta.url;

async function exists(fs: DiskFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
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

async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of reader) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  const proc = new Process(execPath, args, { cwd, env: childEnv });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return { stdout, stderr, code: result.code };
}

describe('properties', () => {
  it('import.meta.url is a file:// URL', (t) => {
    t.ok(typeof thisUrl === 'string', 'url is a string');
    t.ok(thisUrl.startsWith('file://'), 'url starts with file://');
    t.ok(thisUrl.endsWith('import-meta.test.mts'), 'url ends with module filename');
  });

  it('import.meta.filename is an absolute path', (t) => {
    t.ok(typeof thisFile === 'string', 'filename is a string');
    t.ok(thisFile.startsWith('/'), 'filename is absolute');
    t.ok(thisFile.endsWith('import-meta.test.mts'), 'filename ends with module filename');
  });

  it('import.meta.dirname is the parent directory', (t) => {
    t.ok(typeof thisDir === 'string', 'dirname is a string');
    t.ok(thisDir.startsWith('/'), 'dirname is absolute');
    // dirname should not include the filename
    t.ok(!thisDir.endsWith('import-meta.test.mjs'), 'dirname does not include filename');
    // filename should start with dirname
    t.ok(thisFile.startsWith(thisDir + '/'), 'filename is inside dirname');
  });

  it('import.meta.url matches file:// + filename', (t) => {
    t.equal(thisUrl, 'file://' + thisFile, 'url == file:// + filename');
  });
});

describe('resolve()', () => {
  it('import.meta.resolve is a function', (t) => {
    t.ok(typeof meta.resolve === 'function', 'resolve is a function');
  });

  it('import.meta.resolve resolves a relative path', (t) => {
    const resolved = meta.resolve('./typescript.test.mts');
    t.ok(resolved.startsWith('file://'), 'resolved URL starts with file://');
    t.ok(resolved.endsWith('typescript.test.mts'), 'resolved URL ends with typescript.test.mts');
  });

  it('import.meta.resolve probes extensions in normal import order', (t) => {
    const resolved = meta.resolve('./typescript.test');
    t.ok(resolved.startsWith('file://'), 'resolved URL starts with file://');
    t.ok(resolved.endsWith('typescript.test.mts'), 'resolved extension matches normal imports');
  });

  it('import.meta.resolve resolves an absolute path', (t) => {
    const resolved = meta.resolve(thisFile);
    t.equal(resolved, 'file://' + thisFile, 'absolute path resolves to file:// URL');
  });

  it('import.meta.resolve passes through fino: specifiers', (t) => {
    const resolved = meta.resolve('fino:test/test');
    t.equal(resolved, 'fino:test/test', 'fino: specifier returned as-is');
  });

  it('import.meta.resolve resolves file URL inputs', (t) => {
    const resolved = meta.resolve(thisUrl);
    t.equal(resolved, thisUrl, 'file URL resolves to canonical file URL');
  });

  it('import.meta.resolve throws on non-existent path', async (t) => {
    await t.rejects(
      async () => meta.resolve('./definitely-does-not-exist-xyz.mjs'),
      /Cannot resolve/,
      'throws on missing file',
    );
  });

  it('import.meta.resolve resolves package-map bare imports and exported subpaths', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-import-meta-package-map-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    await ensureDir(fs, root + '/.fino/packages/pkg/dist');
    await fs.writeFile(root + '/package.json', JSON.stringify({ type: 'module' }, null, 2));
    await fs.writeFile(root + '/.fino/packages/pkg/index.js', 'export default "pkg";\n');
    await fs.writeFile(root + '/.fino/packages/pkg/dist/feature.js', 'export default "feature";\n');
    await fs.writeFile(root + '/.fino/package-map.json', JSON.stringify({
      version: 1,
      root,
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
            './feature': 'dist/feature.js',
          },
        },
      },
    }, null, 2));
    await fs.writeFile(root + '/resolve-ok.mts', [
      'const rootUrl = import.meta.resolve("pkg");',
      'const featureUrl = import.meta.resolve("pkg/feature");',
      'const fileUrl = import.meta.resolve(new URL("./resolve-ok.mts", import.meta.url).href);',
      'console.log([rootUrl, featureUrl, fileUrl].join("\\n"));',
      '',
    ].join('\n'));
    await fs.writeFile(root + '/resolve-missing-record.mts', 'import.meta.resolve("missing");\n');

    const ok = await runCli(['resolve-ok.mts'], root);
    t.equal(ok.code, 0, 'package-map resolve script exits successfully');
    t.equal(ok.stderr, '', 'package-map resolve script has no stderr');
    const lines = ok.stdout.trim().split('\n');
    t.ok(lines[0]!.startsWith('file://'), 'bare package import resolves to a file URL');
    t.ok(lines[0]!.endsWith('/.fino/packages/pkg/index.js'), 'bare package import resolves to mapped root entrypoint');
    t.ok(lines[1]!.startsWith('file://'), 'exported package subpath resolves to a file URL');
    t.ok(lines[1]!.endsWith('/.fino/packages/pkg/dist/feature.js'), 'exported package subpath resolves to mapped entrypoint');
    t.ok(lines[2]!.startsWith('file://'), 'file URL input resolves to a file URL');
    t.ok(lines[2]!.endsWith('/resolve-ok.mts'), 'file URL input resolves through import.meta.resolve');

    const missing = await runCli(['resolve-missing-record.mts'], root);
    t.equal(missing.code, 1, 'missing package-map record exits nonzero');
    t.ok(missing.stderr.includes("missing package-map record for 'missing@1.0.0'"), 'missing package-map record is reported');
  });
});
