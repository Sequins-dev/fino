/**
 * internal/tooling/files — source discovery for Fino CLI tooling.
 *
 * This module centralizes the file selection policy shared by `fino fmt` and
 * `fino lint`. Callers pass optional files, directories, or simple glob inputs;
 * when no inputs are provided, discovery recursively scans the current working
 * directory for JavaScript and TypeScript-family files. Generated, dependency,
 * cache, hidden, and build-output directories are skipped by default.
 *
 * ```ts no_run
 * import { discoverSourceFiles } from 'internal:tooling/files';
 *
 * const files = await discoverSourceFiles(['src/*.ts']);
 * ```
 *
 * @internal
 */

import { cwd } from '../../process.mts';
import { DiskFileSystem } from '../../file/fs.mts';
import { resolve } from '../../file/path.mts';

const SOURCE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);
const DEFAULT_IGNORES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.next',
  'coverage',
  'dist',
  'build',
  'docs',
  'node_modules',
  'target',
  'vendor',
]);

/**
 * Return true when a path looks like a JavaScript or TypeScript source file.
 *
 * The check is extension-only and accepts `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
 * `.mts`, `.cts`, and `.tsx`.
 *
 * @internal
 */
export function isSupportedSource(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1));
}

/**
 * Return true when the directory should not be traversed by default tooling.
 *
 * Hidden directories and common dependency, generated, cache, and build-output
 * directories are ignored. The current-directory marker `.` is not ignored.
 *
 * @internal
 */
export function isIgnoredDirectory(name: string): boolean {
  return DEFAULT_IGNORES.has(name) || (name.startsWith('.') && name !== '.');
}

function hasGlobSyntax(path: string): boolean {
  return path.includes('*') || path.includes('?') || path.includes('{') || path.includes('[');
}

async function walkSourceFiles(fs: DiskFileSystem, root: string, out: string[]): Promise<void> {
  const dir = await fs.dir(root);
  for await (const entry of dir) {
    const path = entry.path.toString();
    if (entry.isDirectory()) {
      if (!isIgnoredDirectory(entry.name)) await walkSourceFiles(fs, path, out);
    } else if (entry.isFile() && isSupportedSource(path)) {
      out.push(path);
    }
  }
}

/**
 * Discover source files from explicit CLI inputs or recursively from cwd.
 *
 * Explicit inputs may be files, directories, or glob patterns. Returned paths
 * are absolute, de-duplicated, sorted, and limited to supported source
 * extensions.
 *
 * @internal
 */
export async function discoverSourceFiles(inputs: string[]): Promise<string[]> {
  const fs = new DiskFileSystem();
  const base = cwd();
  const files = new Set<string>();

  if (inputs.length === 0) {
    const discovered: string[] = [];
    await walkSourceFiles(fs, base, discovered);
    for (const file of discovered) files.add(file);
    return [...files].sort();
  }

  for (const input of inputs) {
    if (hasGlobSyntax(input)) {
      let matched = 0;
      for await (const entry of fs.glob(input, { cwd: base, onlyFiles: true })) {
        const path = entry.path.toString();
        if (isSupportedSource(path)) {
          files.add(path);
          matched++;
        }
      }
      if (matched === 0) throw new Error(`no source files matched ${input}`);
      continue;
    }

    const path = resolve(base, input).toString();
    const stat = await fs.lstat(path);
    if (stat.isDirectory()) {
      const discovered: string[] = [];
      await walkSourceFiles(fs, path, discovered);
      for (const file of discovered) files.add(file);
    } else if (stat.isFile() && isSupportedSource(path)) {
      files.add(path);
    }
  }

  return [...files].sort();
}

/**
 * Read a UTF-8 source file.
 *
 * This wraps `DiskFileSystem.readFile()` so command implementations share the
 * same file abstraction.
 *
 * @internal
 */
export async function readSourceFile(path: string): Promise<string> {
  return new DiskFileSystem().readFile(path);
}

/**
 * Write a UTF-8 source file.
 *
 * This writes the full source text through `DiskFileSystem.writeFile()`.
 *
 * @internal
 */
export async function writeSourceFile(path: string, source: string): Promise<void> {
  await new DiskFileSystem().writeFile(path, source);
}
