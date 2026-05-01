import { DiskFileSystem } from '../file/fs.mts';
import { extractArchive } from '../archive.mts';
import { cwd, env } from '../runtime/process.mts';
import { compare, maxSatisfying } from '../semver.mts';
import * as openssl from './openssl.mts';

const fs = new DiskFileSystem();
const DEFAULT_REGISTRY = env.FINO_NPM_REGISTRY ?? 'https://registry.npmjs.org';
const PROBE_EXTENSIONS = ['.mjs', '.js', '.json', '.mts', '.ts'];

/**
 * Verify a tarball's integrity against the npm packument's `dist.integrity`
 * or `dist.shasum` field. Throws if verification fails. No-ops if OpenSSL is
 * not available or if neither field is present.
 *
 * `dist.integrity` is an SRI string like `sha512-<base64>`.
 * `dist.shasum` is a hex-encoded SHA-1 (legacy, lower security).
 */
export function verifyTarballIntegrity(
  bytes: Uint8Array,
  integrity: string | undefined,
  shasum: string | undefined,
  packageId: string,
): void {
  if (!openssl.cryptoAvailable) return;

  if (integrity) {
    // SRI may be multi-value (space-separated); use only the first token.
    const token = (integrity.split(/\s+/)[0] ?? '');
    const dashIdx = token.indexOf('-');
    if (dashIdx >= 0) {
      const hashAlias = token.slice(0, dashIdx).toLowerCase();
      const algMap: Record<string, string> = { sha256: 'sha-256', sha384: 'sha-384', sha512: 'sha-512' };
      const alg = algMap[hashAlias];
      if (alg) {
        // Known SRI algorithm — verify and return (don't fall through to shasum).
        const expectedB64 = token.slice(dashIdx + 1);
        const actual = openssl.digest(alg, bytes);
        let actualB64 = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        for (let i = 0; i < actual.length; i += 3) {
          const b0 = actual[i]!; const b1 = actual[i + 1] ?? 0; const b2 = actual[i + 2] ?? 0;
          actualB64 += chars[b0 >> 2]! + chars[((b0 & 3) << 4) | (b1 >> 4)]!;
          actualB64 += i + 1 < actual.length ? chars[((b1 & 15) << 2) | (b2 >> 6)]! : '=';
          actualB64 += i + 2 < actual.length ? chars[b2 & 63]! : '=';
        }
        if (actualB64 !== expectedB64) {
          throw new Error(
            `Integrity check failed for ${packageId}: expected ${integrity.slice(0, 20)}…`,
          );
        }
        return;
      }
      // Unknown algorithm prefix (e.g. "md5-…") — fall through to shasum.
      // If shasum is also absent, we throw below rather than silently passing.
    }
    // Malformed SRI (no "-") — fall through to shasum.
    // If shasum is also absent, we throw below.
    if (!shasum) {
      throw new Error(
        `Integrity check failed for ${packageId}: unrecognised integrity string "${token.slice(0, 30)}"`,
      );
    }
  }

  if (shasum) {
    const actual = openssl.digest('sha-1', bytes);
    const actualHex = Array.from(actual).map(b => b.toString(16).padStart(2, '0')).join('');
    if (actualHex !== shasum.toLowerCase()) {
      throw new Error(`Integrity check failed for ${packageId}: SHA-1 shasum mismatch`);
    }
  }
}

function splitPackageSpec(input: string): { name: string; range: string | null } {
  const text = String(input).trim();
  if (text.length === 0) throw new Error('Package name must not be empty');
  if (text.startsWith('@')) {
    const idx = text.lastIndexOf('@');
    if (idx > 0) return { name: text.slice(0, idx), range: text.slice(idx + 1) || null };
    return { name: text, range: null };
  }
  const idx = text.indexOf('@');
  if (idx < 0) return { name: text, range: null };
  return { name: text.slice(0, idx), range: text.slice(idx + 1) || null };
}

function encodePackageDirName(name: string, version: string): string {
  return `${name.replace(/\//g, '+')}@${version}`;
}

function normalizeRelativePath(path: string): string {
  const parts = [];
  for (const part of String(path).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

function extname(path: string): string {
  const idx = path.lastIndexOf('.');
  if (idx < 0) return '';
  const slash = path.lastIndexOf('/');
  return idx < slash ? '' : path.slice(idx);
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (_) {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  if (!path || path === '/') return;
  if (await exists(path)) return;
  const parent = dirname(path);
  if (parent && parent !== path) await ensureDir(parent);
  if (!(await exists(path))) await fs.mkdir(path);
}

async function removeTree(path: string): Promise<void> {
  if (!(await exists(path))) return;
  const entry = await fs.entry(path);
  if (entry.isDirectory()) {
    const dir = await fs.dir(path);
    for (const child of await dir.entries()) await removeTree(child.path.toString());
    await fs.rmdir(path);
    return;
  }
  await fs.unlink(path);
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await fs.readFile(path));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await fs.writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

function encodeRegistryPackageName(name: string): string {
  return name.replace(/\//g, '%2f');
}

function chooseVersion(packument: any, range: string | null): string {
  const distTags = packument['dist-tags'] ?? {};
  if (range && distTags[range]) return distTags[range];
  const versions = Object.keys(packument.versions ?? {}).sort(compare);
  if (range == null || range === '' || range === '*' || range === 'latest') {
    const selected = maxSatisfying(versions, range);
    if (selected) return selected;
    throw new Error(`No version of '${packument.name}' matches '${range ?? 'latest'}'`);
  }

  const trimmedRange = range.trim();
  const useLowestMatch = trimmedRange.startsWith('^') || trimmedRange.startsWith('~');
  if (useLowestMatch) {
    for (const version of versions) {
      if (maxSatisfying([version], trimmedRange) === version) return version;
    }
  }

  const selected = maxSatisfying(versions, trimmedRange);
  if (selected) return selected;
  throw new Error(`No version of '${packument.name}' matches '${range ?? 'latest'}'`);
}

async function walkFiles(rootDir: string, relativeDir: string = ''): Promise<string[]> {
  const currentDir = relativeDir ? `${rootDir}/${relativeDir}` : rootDir;
  const dir = await fs.dir(currentDir);
  const out = [];
  for (const child of await dir.entries()) {
    const rel = relativeDir ? `${relativeDir}/${child.name}` : child.name;
    if (child.isDirectory()) {
      const nested = await walkFiles(rootDir, rel);
      for (const entry of nested) out.push(entry);
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

function addEntrypoint(entrypoints: Record<string, string>, subpath: string, target: string): void {
  const cleanSubpath = subpath === '.' ? '.' : subpath;
  const normalizedTarget = normalizeRelativePath(target);
  if (!normalizedTarget) return;
  entrypoints[cleanSubpath] = normalizedTarget;
}

function addDeepImportEntrypoints(entrypoints: Record<string, string>, files: string[]): void {
  for (const file of files) {
    addEntrypoint(entrypoints, './' + file, file);
    const ext = extname(file);
    if (PROBE_EXTENSIONS.includes(ext)) {
      addEntrypoint(entrypoints, './' + file.slice(0, -ext.length), file);
      const withoutExt = file.slice(0, -ext.length);
      if (withoutExt.endsWith('/index')) {
        const dir = withoutExt.slice(0, -'/index'.length);
        addEntrypoint(entrypoints, dir ? './' + dir : '.', file);
      }
    }
  }
}

function resolveExportsTarget(target: any): string | null {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveExportsTarget(item);
      if (resolved) return resolved;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    if (target.import) return resolveExportsTarget(target.import);
    if (target.default) return resolveExportsTarget(target.default);
  }
  return null;
}

function expandPatternEntrypoints(entrypoints: Record<string, string>, key: string, target: string, files: string[]): void {
  const keyParts = key.split('*');
  const targetParts = target.split('*');
  if (keyParts.length !== 2 || targetParts.length !== 2) return;
  const targetPrefix = normalizeRelativePath(targetParts[0]!);
  const targetSuffix = normalizeRelativePath(targetParts[1]!);
  for (const file of files) {
    if (!file.startsWith(targetPrefix) || !file.endsWith(targetSuffix)) continue;
    const matched = file.slice(targetPrefix.length, file.length - targetSuffix.length);
    addEntrypoint(entrypoints, keyParts[0]! + matched + keyParts[1]!, file);
  }
}

async function computeEntrypoints(packageDir: string, pkgJson: any): Promise<Record<string, string>> {
  const entrypoints: Record<string, string> = {};
  const files = await walkFiles(packageDir);
  const exportsField = pkgJson.exports;

  if (typeof exportsField === 'string' || Array.isArray(exportsField) || (exportsField && typeof exportsField === 'object' && !Object.keys(exportsField).some((key) => key.startsWith('.')))) {
    const target = resolveExportsTarget(exportsField);
    if (target) addEntrypoint(entrypoints, '.', target);
  } else if (exportsField && typeof exportsField === 'object') {
    for (const [key, value] of Object.entries(exportsField)) {
      const target = resolveExportsTarget(value);
      if (!target) continue;
      if (key.includes('*') && target.includes('*')) {
        expandPatternEntrypoints(entrypoints, key, target, files);
      } else {
        addEntrypoint(entrypoints, key, target);
      }
    }
  }

  if (!entrypoints['.']) {
    const fallback = pkgJson.module ?? pkgJson.main ?? 'index.js';
    addEntrypoint(entrypoints, '.', fallback);
  }

  if (exportsField == null) addDeepImportEntrypoints(entrypoints, files);
  return entrypoints;
}

interface InstallContext {
  root: string;
  registry: string;
  packageCache: Map<string, any>;
  packumentCache: Map<string, any>;
  warnings: string[];
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.json();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchPackument(ctx: InstallContext, name: string): Promise<any> {
  const cached = ctx.packumentCache.get(name);
  if (cached) return cached;
  const data = await fetchJson(`${ctx.registry.replace(/\/$/, '')}/${encodeRegistryPackageName(name)}`);
  ctx.packumentCache.set(name, data);
  return data;
}

async function resolveAndInstall(ctx: InstallContext, name: string, range: string | null, optional: boolean = false): Promise<string | null> {
  try {
    const packument = await fetchPackument(ctx, name);
    const version = chooseVersion(packument, range);
    const packageId = `${name}@${version}`;
    if (ctx.packageCache.has(packageId)) return packageId;

    const packageDirName = encodePackageDirName(name, version);
    const packageBaseDir = `${ctx.root}/.fino/packages/${packageDirName}`;
    const packageDir = `${packageBaseDir}/package`;

    await ensureDir(`${ctx.root}/.fino/packages`);
    await ensureDir(`${ctx.root}/.fino/tmp`);

    const tmpArchivePath = `${ctx.root}/.fino/tmp/${packageDirName}.tgz`;
    const tmpExtractDir = `${ctx.root}/.fino/tmp/${packageDirName}-extract`;
    await removeTree(tmpExtractDir);
    await ensureDir(tmpExtractDir);
    const versionMeta = packument.versions?.[version];
    const tarball = versionMeta?.dist?.tarball;
    if (!tarball) throw new Error(`Package '${packageId}' has no dist.tarball`);
    const tarballBytes = await fetchBytes(tarball);
    // Verify tarball integrity before extracting to prevent supply-chain attacks.
    verifyTarballIntegrity(
      tarballBytes,
      versionMeta.dist.integrity as string | undefined,
      versionMeta.dist.shasum as string | undefined,
      packageId,
    );
    await fs.writeFile(tmpArchivePath, tarballBytes);
    await extractArchive(tmpArchivePath, tmpExtractDir);
    await fs.unlink(tmpArchivePath);
    if (await exists(packageBaseDir)) await removeTree(packageBaseDir);
    await fs.rename(tmpExtractDir, packageBaseDir);

    const pkgJson = await readJson(`${packageDir}/package.json`);
    const entrypoints = await computeEntrypoints(packageDir, pkgJson);
    const dependencies: Record<string, string> = {};

    for (const [depName, depRange] of Object.entries(pkgJson.dependencies ?? {})) {
      const depId = await resolveAndInstall(ctx, depName, String(depRange));
      if (depId) dependencies[depName] = depId;
    }
    for (const [depName, depRange] of Object.entries(pkgJson.optionalDependencies ?? {})) {
      const depId = await resolveAndInstall(ctx, depName, String(depRange), true);
      if (depId) dependencies[depName] = depId;
    }
    for (const depName of Object.keys(pkgJson.peerDependencies ?? {})) {
      ctx.warnings.push(`peer dependency not installed automatically: ${pkgJson.name} -> ${depName}`);
    }

    const record = {
      name,
      version,
      dir: `.fino/packages/${packageDirName}/package`,
      entrypoints,
      dependencies,
    };
    ctx.packageCache.set(packageId, record);
    return packageId;
  } catch (error) {
    if (optional) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.warnings.push(`optional dependency failed: ${name}${range ? '@' + range : ''} (${message})`);
      return null;
    }
    throw error;
  }
}

async function loadOrCreateRootPackageJson(root: string): Promise<any> {
  const path = `${root}/package.json`;
  if (await exists(path)) return await readJson(path);
  return { name: 'fino-app', type: 'module' };
}

async function buildInstallPlan(root: string, packageSpecs: string[]): Promise<{ pkgJson: any; roots: Record<string, string>; explicitRequests: Map<string, string | null> }> {
  const pkgJson = await loadOrCreateRootPackageJson(root);
  const explicitRequests = new Map<string, string | null>();
  if (packageSpecs.length > 0) {
    const dependencies = { ...(pkgJson.dependencies ?? {}) };
    for (const spec of packageSpecs) {
      const { name, range } = splitPackageSpec(spec);
      dependencies[name] = range ?? '*';
      explicitRequests.set(name, range);
    }
    pkgJson.dependencies = dependencies;
    await writeJson(`${root}/package.json`, pkgJson);
  } else if (!(await exists(`${root}/package.json`))) {
    throw new Error('fino install: package.json not found');
  }

  const roots = {
    ...(pkgJson.dependencies ?? {}),
    ...(pkgJson.devDependencies ?? {}),
    ...(pkgJson.optionalDependencies ?? {}),
  };
  return { pkgJson, roots, explicitRequests };
}

export async function installPackages(packageSpecs: string[] = []): Promise<void> {
  const root = cwd();
  const ctx: InstallContext = {
    root,
    registry: DEFAULT_REGISTRY,
    packageCache: new Map(),
    packumentCache: new Map(),
    warnings: [],
  };

  const { pkgJson, roots, explicitRequests } = await buildInstallPlan(root, packageSpecs);
  await ensureDir(`${root}/.fino`);
  await ensureDir(`${root}/.fino/packages`);
  await ensureDir(`${root}/.fino/tmp`);

  const rootDependencies: Record<string, string> = {};
  for (const [name, rangeValue] of Object.entries(roots)) {
    const packageId = await resolveAndInstall(ctx, name, String(rangeValue));
    if (packageId) rootDependencies[name] = packageId;
  }

  if (explicitRequests.size > 0) {
    const dependencies = { ...(pkgJson.dependencies ?? {}) };
    for (const [name, requestedRange] of explicitRequests.entries()) {
      if (requestedRange == null) {
        const packageId = rootDependencies[name];
        if (packageId) dependencies[name] = packageId.slice(name.length + 1);
      } else {
        dependencies[name] = requestedRange;
      }
    }
    pkgJson.dependencies = dependencies;
    await writeJson(`${root}/package.json`, pkgJson);
  }

  const packageMap = {
    version: 1,
    root,
    registry: ctx.registry,
    rootDependencies,
    packages: Object.fromEntries([...ctx.packageCache.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };

  await writeJson(`${root}/.fino/package-map.json`, packageMap);

  if (ctx.warnings.length > 0) {
    for (const warning of ctx.warnings) console.warn(warning);
  }
}
