/**
 * internal:package_manager — npm dependency installer for Fino projects.
 *
 * Backs the `fino install` command. Given a set of package specs (or an
 * existing `package.json`), it resolves versions against an npm-compatible
 * registry, downloads and integrity-checks each tarball, extracts packages into
 * `.fino/packages`, recursively installs their dependencies, and writes a flat
 * `.fino/package-map.json` that the internal module loader consumes to resolve
 * bare specifiers at runtime.
 *
 * Resolution follows npm semantics closely enough to be useful without cloning
 * npm: dist-tags are honored, semver ranges are matched via `fino:semver`, and
 * a package's entrypoints are derived from its `exports` map (including
 * conditional, array, and wildcard `*` forms) with a legacy `main`/`module`
 * fallback and deep-import probing when no `exports` field is present. Regular
 * and optional dependencies are installed transitively; optional failures are
 * downgraded to warnings while required failures propagate. Peer dependencies
 * are only warned about, never auto-installed.
 *
 * The registry defaults to the `FINO_NPM_REGISTRY` environment variable, or
 * `https://registry.npmjs.org` when unset. Builds that install from registries
 * should include OpenSSL so tarball integrity metadata is actually enforced;
 * without it, downloads are extracted unverified. SHA-1 `shasum` metadata is
 * accepted only as a legacy fallback when modern SRI (`sha256`/`sha384`/
 * `sha512`) metadata is absent or uses an unsupported algorithm.
 *
 * This is an `internal:*` module: it is importable only from other built-ins,
 * not from user code, and the public entry point is the `fino install` CLI.
 *
 * ```ts no_run
 *   import { installPackages } from 'internal:package_manager';
 *
 *   // Add packages to package.json and install everything into .fino/packages.
 *   await installPackages(['left-pad@^1.3.0', '@scope/util']);
 *
 *   // With no specs, install exactly what package.json already declares.
 *   await installPackages();
 * ```
 *
 * @internal
 */
import { DiskFileSystem } from 'fino:file';
import { extractArchive } from 'fino:archive';
import { cwd, env } from 'fino:process';
import { compare, maxSatisfying } from 'fino:semver';
import { Scanner } from 'fino:parsing/scanner';
import * as openssl from './openssl.ts';
const fs = new DiskFileSystem();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const DEFAULT_REGISTRY = env.FINO_NPM_REGISTRY ?? 'https://registry.npmjs.org';
const PROBE_EXTENSIONS = ['.mjs', '.js', '.json', '.ts', '.ts'];
const SRI_ALGORITHMS: Record<string, string> = {
  sha256: 'sha-256',
  sha384: 'sha-384',
  sha512: 'sha-512',
};
const SRI_STRENGTH: Record<string, number> = {
  sha256: 1,
  sha384: 2,
  sha512: 3,
};
type SriToken = {
  token: string;
  hashAlias: string;
  expectedB64: string;
};
function isSriAlgorithmCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isBase64Code(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 ||
    code === 47 ||
    code === 61
  );
}
function parseSriToken(token: string): SriToken {
  const sc = new Scanner(token, {
    encoding: 'ascii',
    format: 'sri',
  });
  const tokenStart = sc.mark();
  const hashAlias = sc.eatWhile(isSriAlgorithmCode).toLowerCase();
  if (hashAlias === '' || !sc.eatChar('-')) throw new Error('malformed integrity token');
  const expectedB64 = sc.eatWhile(isBase64Code);
  if (expectedB64 === '') throw new Error('malformed integrity token');
  if (!sc.done) throw new Error('malformed integrity token');
  return {
    token: sc.text(tokenStart),
    hashAlias,
    expectedB64,
  };
}
function parseSriTokens(integrity: string): {
  tokens: SriToken[];
  malformed: boolean;
} {
  const tokens: SriToken[] = [];
  let malformed = false;
  for (const token of integrity.trim().split(/\s+/)) {
    if (token === '') continue;
    try {
      tokens.push(parseSriToken(token));
    } catch (_) {
      malformed = true;
    }
  }
  return {
    tokens,
    malformed,
  };
}
function strongestSupportedSri(tokens: SriToken[]): SriToken | null {
  let strongest: SriToken | null = null;
  for (const token of tokens) {
    if (!SRI_ALGORITHMS[token.hashAlias]) continue;
    if (!strongest || SRI_STRENGTH[token.hashAlias]! > SRI_STRENGTH[strongest.hashAlias]!) {
      strongest = token;
    }
  }
  return strongest;
}
function base64Digest(alg: string, bytes: Uint8Array): string {
  const actual = openssl.digest(alg, bytes);
  let actualB64 = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < actual.length; i += 3) {
    const b0 = actual[i]!;
    const b1 = actual[i + 1] ?? 0;
    const b2 = actual[i + 2] ?? 0;
    actualB64 += chars[b0 >> 2]! + chars[((b0 & 3) << 4) | (b1 >> 4)]!;
    actualB64 += i + 1 < actual.length ? chars[((b1 & 15) << 2) | (b2 >> 6)]! : '=';
    actualB64 += i + 2 < actual.length ? chars[b2 & 63]! : '=';
  }
  return actualB64;
}
/**
 * Verify downloaded tarball bytes against a package's npm integrity metadata.
 *
 * `integrity` holds one or more SRI tokens from the registry's `dist.integrity`
 * field, such as `sha512-base64…`; when several supported tokens are present
 * the strongest algorithm (`sha512` over `sha384` over `sha256`) is the one
 * actually checked. `shasum` is the registry's legacy `dist.shasum` SHA-1 hex
 * value, used only as a fallback. `packageId` (for example `left-pad@1.3.0`) is
 * interpolated into error messages so failures name the offending package.
 *
 * Verification is a no-op when OpenSSL is unavailable — `cryptoAvailable` is
 * false — or when neither metadata field is supplied, so callers must ensure
 * crypto is present for enforcement to mean anything. When a usable SRI token
 * exists it is checked and a `shasum` fallback is ignored; a digest mismatch
 * throws. If the only SRI tokens use unsupported algorithms, or the integrity
 * string is malformed, that is tolerated only when a `shasum` is available to
 * fall back to — otherwise it throws. The SHA-1 fallback throws on mismatch.
 *
 * Throws an `Error` whose message begins `Integrity check failed for <id>` on
 * any digest mismatch, unsupported-only SRI without a shasum, or unparseable
 * integrity string without a shasum.
 *
 * ```ts no_run
 *   import { verifyTarballIntegrity } from 'internal:package_manager';
 *
 *   const bytes = await fetchBytes(dist.tarball);
 *   // Throws if the bytes don't match the registry's advertised digest.
 *   verifyTarballIntegrity(bytes, dist.integrity, dist.shasum, 'left-pad@1.3.0');
 * ```
 *
 * @internal
 */
export function verifyTarballIntegrity(
  bytes: Uint8Array,
  integrity: string | undefined,
  shasum: string | undefined,
  packageId: string,
): void {
  if (!openssl.cryptoAvailable) return;
  if (integrity) {
    const { tokens, malformed } = parseSriTokens(integrity);
    const selected = strongestSupportedSri(tokens);
    if (selected) {
      const { token, hashAlias, expectedB64 } = selected;
      const alg = SRI_ALGORITHMS[hashAlias];
      const actualB64 = base64Digest(alg, bytes);
      if (actualB64 !== expectedB64) {
        throw new Error(`Integrity check failed for ${packageId}: expected ${token.slice(0, 20)}…`);
      }
      return;
    }
    const unsupported = tokens.find((token) => !SRI_ALGORITHMS[token.hashAlias]);
    if (unsupported && !shasum) {
      throw new Error(
        `Integrity check failed for ${packageId}: unsupported integrity algorithm "${unsupported.hashAlias}"`,
      );
    }
    if (malformed && !shasum) {
      throw new Error(
        `Integrity check failed for ${packageId}: unrecognised integrity string "${integrity.slice(0, 30)}"`,
      );
    }
  }
  if (shasum) {
    const actual = openssl.digest('sha-1', bytes);
    const actualHex = Array.from(actual)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (actualHex !== shasum.toLowerCase()) {
      throw new Error(`Integrity check failed for ${packageId}: SHA-1 shasum mismatch`);
    }
  }
}
function splitPackageSpec(input: string): {
  name: string;
  range: string | null;
} {
  const text = String(input).trim();
  if (text.length === 0) throw new Error('Package name must not be empty');
  const scanner = new Scanner(text, {
    encoding: 'utf-8',
    format: 'package-spec',
  });
  if (scanner.eatChar('@')) {
    const scopeStart = scanner.mark();
    scanner.eatUntil((code) => code === 47);
    const scope = scanner.text(scopeStart);
    if (scope === '' || !scanner.eatChar('/'))
      throw new Error(`Invalid scoped package spec '${input}'`);
    const nameStart = scanner.mark();
    scanner.eatUntil((code) => code === 64);
    const packageName = scanner.text(nameStart);
    if (packageName === '') throw new Error(`Invalid scoped package spec '${input}'`);
    if (!scanner.eatChar('@'))
      return {
        name: `@${scope}/${packageName}`,
        range: null,
      };
    const rangeStart = scanner.mark();
    scanner.eatWhile(() => true);
    return {
      name: `@${scope}/${packageName}`,
      range: scanner.text(rangeStart) || null,
    };
  }
  const nameStart = scanner.mark();
  scanner.eatUntil((code) => code === 64);
  const name = scanner.text(nameStart);
  if (name === '') throw new Error(`Invalid package spec '${input}'`);
  if (!scanner.eatChar('@'))
    return {
      name,
      range: null,
    };
  const rangeStart = scanner.mark();
  scanner.eatWhile(() => true);
  return {
    name,
    range: scanner.text(rangeStart) || null,
  };
}
function encodePackageDirName(name: string, version: string): string {
  return `${name.replace(/\//g, '+')}@${version}`;
}
function normalizeRelativePath(path: string): string {
  const parts = [];
  const scanner = new Scanner(String(path).replace(/\\/g, '/'), {
    encoding: 'utf-8',
    format: 'package-path',
  });
  while (!scanner.done) {
    const start = scanner.mark();
    scanner.eatUntil((code) => code === 47);
    const part = scanner.text(start);
    scanner.eatChar('/');
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
  return JSON.parse(textDecoder.decode(await fs.readFile(path)));
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await fs.writeFile(path, textEncoder.encode(JSON.stringify(value, null, 2) + '\n'));
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
function expandPatternEntrypoints(
  entrypoints: Record<string, string>,
  key: string,
  target: string,
  files: string[],
): void {
  const keyParts = splitExportPattern(key);
  const targetParts = splitExportPattern(target);
  if (!keyParts || !targetParts) return;
  let targetPrefix = normalizeRelativePath(targetParts.prefix);
  if (targetPrefix && /[\\/]$/.test(targetParts.prefix)) targetPrefix += '/';
  const targetSuffix = normalizeRelativePath(targetParts.suffix);
  for (const file of files) {
    if (!file.startsWith(targetPrefix) || !file.endsWith(targetSuffix)) continue;
    const matched = file.slice(targetPrefix.length, file.length - targetSuffix.length);
    addEntrypoint(entrypoints, keyParts.prefix + matched + keyParts.suffix, file);
  }
}
function splitExportPattern(pattern: string): {
  prefix: string;
  suffix: string;
} | null {
  const scanner = new Scanner(pattern, {
    encoding: 'utf-8',
    format: 'package-exports',
  });
  const prefixStart = scanner.mark();
  scanner.eatUntil((code) => code === 42);
  const prefix = scanner.text(prefixStart);
  if (!scanner.eatChar('*')) return null;
  const suffixStart = scanner.mark();
  scanner.eatUntil((code) => code === 42);
  const suffix = scanner.text(suffixStart);
  if (!scanner.done) return null;
  return {
    prefix,
    suffix,
  };
}
async function computeEntrypoints(
  packageDir: string,
  pkgJson: any,
): Promise<Record<string, string>> {
  const entrypoints: Record<string, string> = {};
  const files = await walkFiles(packageDir);
  const exportsField = pkgJson.exports;
  if (
    typeof exportsField === 'string' ||
    Array.isArray(exportsField) ||
    (exportsField &&
      typeof exportsField === 'object' &&
      !Object.keys(exportsField).some((key) => key.startsWith('.')))
  ) {
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
  const data = await fetchJson(
    `${ctx.registry.replace(/\/$/, '')}/${encodeRegistryPackageName(name)}`,
  );
  ctx.packumentCache.set(name, data);
  return data;
}
async function resolveAndInstall(
  ctx: InstallContext,
  name: string,
  range: string | null,
  optional: boolean = false,
): Promise<string | null> {
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
    try {
      await extractArchive(tmpArchivePath, tmpExtractDir);
    } catch (err) {
      // Clean up partial extraction so a retry doesn't see corrupt state.
      await removeTree(tmpExtractDir).catch(() => {});
      await fs.unlink(tmpArchivePath).catch(() => {});
      throw err;
    }
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
      ctx.warnings.push(
        `peer dependency not installed automatically: ${pkgJson.name} -> ${depName}`,
      );
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
      ctx.warnings.push(
        `optional dependency failed: ${name}${range ? '@' + range : ''} (${message})`,
      );
      return null;
    }
    throw error;
  }
}
async function loadOrCreateRootPackageJson(root: string): Promise<any> {
  const path = `${root}/package.json`;
  if (await exists(path)) return await readJson(path);
  return {
    name: 'fino-app',
    type: 'module',
  };
}
async function buildInstallPlan(
  root: string,
  packageSpecs: string[],
): Promise<{
  pkgJson: any;
  roots: Record<string, string>;
  explicitRequests: Map<string, string | null>;
}> {
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
  return {
    pkgJson,
    roots,
    explicitRequests,
  };
}
/**
 * Install a project's dependencies and write the Fino package map.
 *
 * This is the entry point behind `fino install`. It operates on the current
 * working directory as the project root. Each entry in `packageSpecs` is a
 * bare name (`left-pad`, `@scope/util`) or a `name@range` spec (`left-pad@^1.3`,
 * `@scope/util@latest`); when any specs are given they are merged into the root
 * `package.json`'s `dependencies` (creating a minimal `package.json` if none
 * exists) before resolution. When `packageSpecs` is empty an existing
 * `package.json` is required, and the union of its `dependencies`,
 * `devDependencies`, and `optionalDependencies` is installed.
 *
 * Resolution walks the dependency graph transitively, downloading and
 * integrity-checking each tarball and extracting it under `.fino/packages`.
 * Newly requested packages are pinned back into `package.json`: a spec given
 * without a range is rewritten to the exact resolved version, while an explicit
 * range is preserved as written. On completion the flat resolution graph is
 * serialized to `.fino/package-map.json` (schema `version: 1`, with the
 * registry, top-level `rootDependencies`, and every installed `packages`
 * record) for the loader to consume.
 *
 * Required-dependency failures propagate: network errors, missing
 * `dist.tarball`, unmatched semver ranges, and integrity mismatches all throw.
 * Optional-dependency and unsatisfiable-optional failures are collected as
 * warnings and printed via `console.warn` at the end rather than aborting the
 * install; peer dependencies are likewise only warned about, never installed.
 *
 * ```ts no_run
 *   import { installPackages } from 'internal:package_manager';
 *
 *   // From a project directory, add and install two packages.
 *   await installPackages(['left-pad@^1.3.0', '@scope/util']);
 *   // .fino/package-map.json and .fino/packages/* now exist; package.json
 *   // has left-pad pinned to its resolved range and @scope/util to a version.
 * ```
 *
 * @internal
 */
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
    packages: Object.fromEntries(
      [...ctx.packageCache.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
  await writeJson(`${root}/.fino/package-map.json`, packageMap);
  if (ctx.warnings.length > 0) {
    for (const warning of ctx.warnings) console.warn(warning);
  }
}
