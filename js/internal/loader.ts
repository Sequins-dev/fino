/**
* internal:loader — JS-side module resolution, transpilation, and import.meta population.
*
* Importing this module for its side effects installs the runtime's module
* pipeline. It registers three callbacks with the Rust module loader through the
* `internal:loader-hooks` bridge, and the Rust loader calls back into them for
* every filesystem import:
*
*   - a resolve hook that turns an import specifier plus the referrer's directory
*     into a canonical absolute path (handling relative paths, `file://` URLs,
*     absolute paths, bare package specifiers via the package map, and extension
*     probing for `.ts`/`.tsx`/`.mts`/`.mdx`/`.jsx`/`.mjs`/`.js`/`.json`);
*   - an import.meta hook that populates `url`, `filename`, `dirname`, and a
*     module-local `resolve()` on each filesystem module's `import.meta`;
*   - a transpile hook that lowers TypeScript, MDX, and `.sql` modules to
*     executable JavaScript with a source map.
*
* Bare specifiers are resolved against the package map produced by
* `fino install` (surfaced through `internal:loader-hooks`). Resolution is
* referrer-aware: a dependency is looked up first in the owning package's
* `dependencies`, then in the root's, so nested packages can pin their own
* versions. When no package map is present, bare specifiers fall back to being
* resolved relative to the loader root.
*
* This module must remain synchronous — it has no top-level `await` — so it can
* be statically imported from the bootstrap entry (`internal/main`) before the
* event loop exists. For the same reason it opens its own libc handle for
* `realpath`/`opendir`/`closedir` rather than reusing `internal:file/bindings`,
* which is async because it uses dynamic `import()`.
*
* ```ts no_run
* import 'internal:loader';
* ```
*
* @internal
*/
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
import { encodeUtf8, decodeUtf8 } from './encoding.ts';
import { registerResolve, registerInitMeta, registerTranspile, getPackageMap } from 'internal:loader-hooks';
import { transpile as transpileTypeScript } from 'fino:format/typescript';
import { compileMdx } from 'fino:format/mdx';
import { parseSqlModule, toSqlModuleSource } from 'fino:database/sql';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const lib = dlopen(LIBC, {
  realpath: {
    parameters: ['buffer', 'buffer'],
    result: 'pointer'
  },
  opendir: {
    parameters: ['buffer'],
    result: 'pointer'
  },
  closedir: {
    parameters: ['pointer'],
    result: 'i32'
  }
});
interface PackageMapPackage {
  dir: string;
  entrypoints?: Record<string, string>;
  dependencies?: Record<string, string>;
}
interface PackageMap {
  root: string;
  rootDependencies?: Record<string, string>;
  packages: Record<string, PackageMapPackage>;
}
const packageMapJson = getPackageMap();
const packageMap: PackageMap | null = packageMapJson ? JSON.parse(packageMapJson) as PackageMap : null;
const packageOwners = packageMap ? Object.entries(packageMap.packages).map(([id, pkg]) => ({
  id,
  prefix: packageMap.root + '/' + String(pkg.dir).replace(/\\/g, '/'),
  dependencies: pkg.dependencies ?? {}
})).sort((a, b) => b.prefix.length - a.prefix.length) : [];
function cstr(s: string): Uint8Array {
  const enc = encodeUtf8(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}
/**
* Canonicalize a path with realpath(3), resolving symlinks and `.`/`..` segments.
*
* Returns the canonical absolute path, or `null` when the path does not exist
* (any realpath failure, such as `ENOENT`, is reported as `null` rather than
* thrown). The canonical form is read out of the caller-provided 4 KiB buffer up
* to the first NUL byte and decoded as UTF-8.
*/
function realpath(path: string): string | null {
  const buf = new ArrayBuffer(4096);
  const ptr = lib.symbols.realpath(cstr(path), buf);
  if (ptr === null) return null;
  const bytes = new Uint8Array(buf);
  let len = 0;
  while (len < bytes.length && bytes[len] !== 0) len++;
  return decodeUtf8(bytes.subarray(0, len));
}
function isDirectory(path: string): boolean {
  const ptr = lib.symbols.opendir(cstr(path));
  if (ptr === null) return false;
  lib.symbols.closedir(ptr);
  return true;
}
function normalizeFileUrl(specifier: string): string {
  const rest = specifier.slice('file://'.length);
  let path: string;
  if (rest.startsWith('/')) {
    path = rest;
  } else if (rest.startsWith('localhost/')) {
    path = rest.slice('localhost'.length);
  } else {
    throw new Error(`Invalid file URL '${specifier}': non-local hosts are not supported`);
  }
  try {
    return decodeURIComponent(path);
  } catch (_) {
    throw new Error(`Invalid file URL '${specifier}': malformed percent escape`);
  }
}
function fileUrlFromPath(path: string): string {
  const bytes = encodeUtf8(path);
  let encoded = '';
  for (const byte of bytes) {
    if (byte === 47 || byte >= 48 && byte <= 57 || byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte === 45 || byte === 46 || byte === 95 || byte === 126) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return 'file://' + encoded;
}
function normalizeBareSpecifier(specifier: string): {
  packageName: string;
  subpath: string;
} {
  if (specifier.startsWith('@')) {
    const firstSlash = specifier.indexOf('/');
    const secondSlash = specifier.indexOf('/', firstSlash + 1);
    if (secondSlash < 0) return {
      packageName: specifier,
      subpath: '.'
    };
    return {
      packageName: specifier.slice(0, secondSlash),
      subpath: './' + specifier.slice(secondSlash + 1)
    };
  }
  const slash = specifier.indexOf('/');
  if (slash < 0) return {
    packageName: specifier,
    subpath: '.'
  };
  return {
    packageName: specifier.slice(0, slash),
    subpath: './' + specifier.slice(slash + 1)
  };
}
function resolveWithPackageMap(specifier: string, referrerDir: string | null): string | null {
  if (!packageMap) return null;
  const { packageName, subpath } = normalizeBareSpecifier(specifier);
  let packageId = packageMap.rootDependencies?.[packageName] ?? null;
  if (referrerDir) {
    for (const owner of packageOwners) {
      if (referrerDir === owner.prefix || referrerDir.startsWith(owner.prefix + '/')) {
        packageId = owner.dependencies?.[packageName] ?? packageId;
        break;
      }
    }
  }
  if (!packageId) {
    throw new Error(`Cannot resolve package '${specifier}': no package-map entry. Run 'fino install'.`);
  }
  const pkg = packageMap.packages?.[packageId];
  if (!pkg) {
    throw new Error(`Cannot resolve package '${specifier}': missing package-map record for '${packageId}'`);
  }
  const target = pkg.entrypoints?.[subpath];
  if (!target) {
    throw new Error(`Cannot resolve package subpath '${specifier}' from package map`);
  }
  const resolved = realpath(packageMap.root + '/' + pkg.dir + '/' + target);
  if (resolved === null) {
    throw new Error(`Cannot resolve package '${specifier}': mapped file not found`);
  }
  return resolved;
}
/**
* Resolve a module specifier to a canonical absolute path.
*
* This is the resolve hook the Rust module loader invokes for every filesystem
* import. `referrerDir` is the directory of the importing module, or `null` when
* there is no filesystem referrer (built-in or realm entry), in which case
* resolution is anchored at `root`, the loader's root directory.
*
* Relative specifiers (`./`, `../`) resolve against the referrer directory,
* `file://` URLs are normalized to a local path, and absolute specifiers are
* used as-is. Anything else is treated as a bare package specifier and looked up
* in the package map; if that yields nothing, it falls back to being resolved
* relative to `root`. Once a raw path is chosen it is canonicalized, and if that
* names a nonexistent or directory path the loader probes `.ts`, `.mts`, `.mjs`,
* `.tsx`, `.mdx`, `.jsx`, `.js`, and `.json` extensions in that order.
*
* Throws if the specifier cannot be resolved to an existing file, and (via the
* package-map lookup) if a bare specifier has no package-map entry — the error
* message suggests running `fino install`.
*/
function resolve(specifier: string, referrerDir: string | null, root: string): string {
  const base = referrerDir ?? root;
  let raw;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    raw = base + '/' + specifier;
  } else if (specifier.startsWith('file://')) {
    raw = normalizeFileUrl(specifier);
  } else if (specifier.startsWith('/')) {
    raw = specifier;
  } else {
    const packageResolved = resolveWithPackageMap(specifier, referrerDir);
    if (packageResolved !== null) return packageResolved;
    raw = root + '/' + specifier;
  }
  const canonical = realpath(raw);
  if (canonical !== null && !isDirectory(canonical)) return canonical;
  // Extension probing: try TypeScript, MDX, JS, and JSON extensions in order.
  for (const ext of [
    '.ts',
    '.tsx',
    '.mts',
    '.mdx',
    '.jsx',
    '.mjs',
    '.js',
    '.json'
  ]) {
    const probed = realpath(raw + ext);
    if (probed !== null) return probed;
  }
  throw new Error(`Cannot resolve module '${specifier}': No such file or directory`);
}
/**
* Populate `import.meta` for a filesystem module.
*
* This is the import.meta hook the Rust module loader invokes after a filesystem
* module is parsed, with `filename` set to the module's absolute canonical path
* and `root` the loader root. It sets `import.meta.url` to the module's
* `file://` URL, `import.meta.filename` to the canonical path, and
* `import.meta.dirname` to the containing directory (falling back to `root` for
* a path with no parent directory).
*
* It also installs `import.meta.resolve(specifier)`, a synchronous resolver
* scoped to this module. Built-in specifiers (`fino:*`, `internal:*`) are
* returned unchanged; every other specifier is resolved with the same rules as
* the loader's resolve hook — relative to the module's own directory — and the
* result is returned as a `file://` URL. The scoped resolver throws if the
* specifier cannot be resolved to an existing file.
*/
function initImportMeta(importMeta: ImportMeta & {
  url?: string;
  filename?: string;
  dirname?: string;
  resolve?: (spec: string) => string;
}, filename: string, root: string): void {
  importMeta.url = fileUrlFromPath(filename);
  importMeta.filename = filename;
  const lastSlash = filename.lastIndexOf('/');
  const dirname = lastSlash > 0 ? filename.slice(0, lastSlash) : root;
  importMeta.dirname = dirname;
  importMeta.resolve = function resolve(spec) {
    if (spec.startsWith('fino:') || spec.startsWith('internal:')) {
      return spec;
    }
    let raw;
    if (spec.startsWith('./') || spec.startsWith('../')) {
      raw = dirname + '/' + spec;
    } else if (spec.startsWith('file://')) {
      raw = normalizeFileUrl(spec);
    } else if (spec.startsWith('/')) {
      raw = spec;
    } else {
      const packageResolved = resolveWithPackageMap(spec, dirname);
      if (packageResolved !== null) return fileUrlFromPath(packageResolved);
      raw = root + '/' + spec;
    }
    const canonical = realpath(raw);
    if (canonical !== null && !isDirectory(canonical)) return fileUrlFromPath(canonical);
    for (const ext of [
      '.ts',
      '.tsx',
      '.mts',
      '.mdx',
      '.jsx',
      '.mjs',
      '.js',
      '.json'
    ]) {
      const probed = realpath(raw + ext);
      if (probed !== null) return fileUrlFromPath(probed);
    }
    throw new Error(`Cannot resolve '${spec}': No such file or directory`);
  };
}
/**
* Lower a module's source to executable JavaScript with a source map.
*
* This is the transpile hook the Rust module loader invokes for source it cannot
* run directly. `filename` selects the pipeline: a `.sql` path is first parsed as
* a SQL module and rewritten to a TypeScript wrapper, and everything else is
* transpiled as TypeScript. Both paths run through `fino:format/typescript`, so
* the returned `code` is JavaScript and `map` is its source map.
*
* Throws if compilation fails, joining the underlying diagnostic messages into
* the error (with a generic fallback message when none are reported).
*/
function transpile(source: string, filename: string): {
  code: string;
  map: string;
} {
  if (filename.endsWith('.mdx')) {
    const result = compileMdx(source, { filename });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((diagnostic) => `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`).join('\n') || `Unable to compile MDX module ${filename}`);
    }
    return {
      code: result.code,
      map: result.map
    };
  }
  if (filename.endsWith('.sql')) {
    const generated = toSqlModuleSource(parseSqlModule(source, { source: filename }));
    const result = transpileTypeScript(generated, { filename: filename + '.ts' });
    if (!result.ok) {
      throw new Error(result.errors.map((error) => error.message).join('\n') || `Unable to compile SQL module ${filename}`);
    }
    return {
      code: result.code,
      map: result.map
    };
  }
  const result = transpileTypeScript(source, { filename });
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join('\n') || `Unable to transpile ${filename}`);
  }
  return {
    code: result.code,
    map: result.map
  };
}
registerResolve(resolve);
registerInitMeta(initImportMeta);
registerTranspile(transpile);
