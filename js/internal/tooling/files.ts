/**
* internal:tooling/files — source discovery for Fino CLI tooling.
*
* This module centralizes the file-selection policy shared by `fino fmt` and
* `fino lint`. Callers pass optional files, directories, or simple glob inputs;
* when no inputs are provided, discovery recursively scans the current working
* directory for JavaScript and TypeScript-family files. Generated, dependency,
* cache, hidden, and build-output directories are skipped by default so the
* commands never wander into `node_modules`, `dist`, `target`, and friends.
*
* The three read/write helpers (`readSourceFile`, `writeSourceFile`) sit on top
* of `DiskFileSystem` so every command shares one file abstraction and one text
* encoding assumption (UTF-8). The two predicate helpers (`isSupportedSource`,
* `isIgnoredDirectory`) encode the extension and directory policy and are
* exported so tests and adjacent tooling can apply the same rules without
* re-deriving them.
*
* This is internal wiring for the CLI, not a public file API: prefer the higher
* level `fino fmt` / `fino lint` commands, or `fino:file` for general file I/O.
*
* ```ts no_run
* import { discoverSourceFiles, readSourceFile } from 'internal:tooling/files';
*
* // No inputs → recursively scan cwd, skipping ignored directories.
* const all = await discoverSourceFiles([]);
*
* // Explicit files, directories, and globs are all accepted.
* const some = await discoverSourceFiles(['src', 'index.ts', 'test/*.ts']);
*
* for (const path of some) {
*   const source = await readSourceFile(path);
*   console.log(path, source.length);
* }
* ```
*
* @internal
*/
import { cwd } from '../../process.ts';
import { DiskFileSystem } from '../../file/fs.ts';
import { resolve } from '../../file/path.ts';
const SOURCE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx'
]);
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
  'vendor'
]);
/**
* Return true when a path looks like a JavaScript or TypeScript source file.
*
* The check is extension-only — it inspects the final `.`-delimited suffix of
* the last path segment and never touches the filesystem. Accepted extensions
* are `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, and `.tsx`. A
* leading-dot filename such as `.eslintrc` has no extension (the dot is at
* index 0) and returns false, as do extensionless names and unknown suffixes.
*
* ```ts no_run
* import { isSupportedSource } from 'internal:tooling/files';
*
* isSupportedSource('src/app.ts');   // true
* isSupportedSource('README.md');    // false
* isSupportedSource('.gitignore');   // false — leading dot is not an extension
* ```
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
* `name` is a single path segment (a directory's own name, not a full path).
* Any hidden directory whose name starts with `.` is ignored, along with a
* fixed set of dependency, generated, cache, and build-output directories:
* `node_modules`, `dist`, `build`, `target`, `vendor`, `coverage`, `docs`, and
* the common VCS/cache directories. The current-directory marker `.` is treated
* specially and is not ignored, so a scan rooted at `.` still descends.
*
* Recursive discovery consults this before entering each subdirectory; callers
* rarely need it directly, but it is exported so custom walks can honor the same
* skip list.
*
* ```ts no_run
* import { isIgnoredDirectory } from 'internal:tooling/files';
*
* isIgnoredDirectory('node_modules'); // true
* isIgnoredDirectory('.git');         // true — hidden
* isIgnoredDirectory('src');          // false
* isIgnoredDirectory('.');            // false — never skip the scan root
* ```
*
* @internal
*/
export function isIgnoredDirectory(name: string): boolean {
  return DEFAULT_IGNORES.has(name) || name.startsWith('.') && name !== '.';
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
* With an empty `inputs` array, discovery walks the current working directory
* recursively, collecting every supported source file and skipping ignored
* directories. With explicit inputs, each entry is classified independently: an
* entry containing glob metacharacters (`*`, `?`, `{`, `[`) is expanded against
* the working directory as a file glob; a directory is walked recursively like
* the default scan; a plain file path is included if it is a supported source.
* Directory and plain-file inputs are resolved against cwd, so relative paths
* are accepted.
*
* The result is always absolute, de-duplicated, sorted lexicographically, and
* restricted to supported source extensions — glob and directory matches that
* land on non-source files (for example a matched `.md`) are dropped silently.
*
* Throws if a glob input matches nothing (`no source files matched <input>`),
* and propagates the underlying filesystem error if a non-glob input path does
* not exist, since it is `lstat`-ed directly. An empty result from the default
* cwd scan is not an error.
*
* ```ts no_run
* import { discoverSourceFiles } from 'internal:tooling/files';
*
* // Recursive scan of cwd.
* const project = await discoverSourceFiles([]);
*
* // Mixed inputs: a directory, an explicit file, and a glob.
* const targets = await discoverSourceFiles(['src', 'main.ts', 'lib/*.ts']);
*
* // A glob that matches nothing throws.
* try {
*   await discoverSourceFiles(['nope/*.ts']);
* } catch (err) {
*   console.error(err.message); // "no source files matched nope/*.ts"
* }
* ```
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
      for await (const entry of fs.glob(input, {
        cwd: base,
        onlyFiles: true
      })) {
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
* Reads the whole file through `DiskFileSystem.readFile()` and decodes the
* bytes as UTF-8. The path is used as given (callers typically pass the
* absolute paths returned by `discoverSourceFiles`). Propagates the underlying
* filesystem error if the file is missing or unreadable.
*
* ```ts no_run
* import { discoverSourceFiles, readSourceFile } from 'internal:tooling/files';
*
* const [first] = await discoverSourceFiles(['src']);
* const source = await readSourceFile(first);
* console.log(source.split('\n').length, 'lines');
* ```
*
* @internal
*/
export async function readSourceFile(path: string): Promise<string> {
  return new TextDecoder().decode(await new DiskFileSystem().readFile(path));
}
/**
* Write a UTF-8 source file.
*
* Encodes `source` as UTF-8 and writes the full contents through
* `DiskFileSystem.writeFile()`, replacing any existing file at `path`. This is
* the write side of the read/format/write loop used by `fino fmt` when applying
* fixes in place. Propagates the underlying filesystem error if the path is not
* writable.
*
* ```ts no_run
* import { readSourceFile, writeSourceFile } from 'internal:tooling/files';
*
* const source = await readSourceFile('src/app.ts');
* const formatted = source.replaceAll('\t', '  ');
* if (formatted !== source) await writeSourceFile('src/app.ts', formatted);
* ```
*
* @internal
*/
export async function writeSourceFile(path: string, source: string): Promise<void> {
  await new DiskFileSystem().writeFile(path, new TextEncoder().encode(source));
}
