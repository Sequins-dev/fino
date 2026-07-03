/**
* internal:loader — JS-side module resolution and import.meta population.
*
* Registers two callbacks with the Rust module loader via `internal:loader-hooks`:
*
*   - `resolve(specifier, referrerDir, root)` → canonical absolute path
*   - `initImportMeta(importMeta, filename, root)` → populates import.meta
*
* This module must remain synchronous (no top-level `await`) so it can be
* statically imported from `internal/main.mjs`.
*
* We open our own libc handle for `realpath` rather than reusing
* `internal:file/bindings` because that module uses `await import(...)`,
* which would make this module (and `internal/main.mjs`) async.
*
* ```js
* import 'internal:loader';
* ```
*
* @internal
*/
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
import { encodeUtf8, decodeUtf8 } from '../globals/encoding.ts';
import { registerResolve, registerInitMeta, registerTranspile, getPackageMap } from 'internal:loader-hooks';
import { transpile as transpileTypeScript } from 'fino:format/typescript';
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
* Call realpath(3) to canonicalize a path.
* Returns the canonical path string, or null if the path does not exist.
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
* Called by the Rust module loader for filesystem imports.
*
* @param {string} specifier  - The import specifier
* @param {string|null} referrerDir - Directory of the importing module (null for builtins/realm)
* @param {string} root - The module loader root directory
* @returns {string} Canonical absolute path
* @throws {Error} If the path cannot be resolved
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
  // Extension probing: try TypeScript, JS, and JSON extensions in order.
  for (const ext of [
    '.ts',
    '.mts',
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
* Populate import.meta for a filesystem module.
*
* Called by the Rust module loader after a filesystem module is parsed.
*
* @param {object} importMeta - The import.meta object to populate
* @param {string} filename   - Absolute canonical path of the module
* @param {string} root       - The module loader root directory
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
      '.mts',
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
function transpile(source: string, filename: string): {
  code: string;
  map: string;
} {
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
