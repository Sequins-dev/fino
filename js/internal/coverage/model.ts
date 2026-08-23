/**
 * internal:coverage/model — original-source coverage processing.
 *
 * This module owns the data plane for Fino coverage: V8 UTF-16 offset
 * normalization, source-map projection, Realm shards, deterministic
 * aggregation, metrics, and artifact I/O. The only native operation used by
 * normalization is a batched lookup into the source maps already parsed and
 * retained by the module loader.
 *
 * V8 ranges come from the precise-coverage subset of the
 * [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/).
 * Generated positions are zero-based UTF-16 line/column pairs and their
 * mappings follow [ECMA-426](https://tc39.es/ecma426/).
 *
 * @internal
 */
import { DiskFileSystem } from 'fino:file';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'fino:file/path';
import { cwd, pid } from '../../process.ts';
import { setTimeout } from '../../globals/time.ts';
import { TextDecoder, TextEncoder } from '../../globals/encoding.ts';
import { mapCoveragePositions } from 'internal:coverage/bindings';

export interface CoverageMetric {
  covered: number;
  total: number;
  percent: number;
}

export interface CoverageTotals {
  lines: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface LocalLine {
  line: number;
  hits: number;
}

export interface LocalFunction {
  name: string;
  range: SourceRange;
  hits: number;
}

export interface LocalBranch {
  range: SourceRange;
  hits: number;
}

export interface LocalFile {
  path: string;
  sourceHash: string;
  lines: LocalLine[];
  functions: LocalFunction[];
  branches: LocalBranch[];
}

export interface CoverageRealm {
  id: string;
  parentId: string | null;
  kind: string;
  entry: string | null;
  status: string;
  totals: CoverageTotals;
}

export interface RealmShard {
  realm: CoverageRealm;
  files: LocalFile[];
  warnings: string[];
}

export interface CoverageLine extends LocalLine {
  coveredIn: string[];
}

export interface CoverageFunction extends LocalFunction {
  id: string;
  coveredIn: string[];
}

export interface CoverageBranch extends LocalBranch {
  id: string;
  coveredIn: string[];
}

export interface CoverageFile {
  path: string;
  sourceHash: string;
  realmIds: string[];
  totals: CoverageTotals;
  lines: CoverageLine[];
  functions: CoverageFunction[];
  branches: CoverageBranch[];
}

export interface CoverageArtifact {
  schemaVersion: number;
  tool: { name: string; version: string };
  run: { root: string; id: string; complete: boolean };
  totals: CoverageTotals;
  realms: CoverageRealm[];
  files: CoverageFile[];
  warnings: string[];
}

export interface CoverageSummary {
  path: string;
  complete: boolean;
  totals: CoverageTotals;
  realmCount: number;
  incompleteRealmCount: number;
  warnings: string[];
}

export interface CoverageRunConfig {
  outputPath: string;
  shardDir: string;
  root: string;
  runId: string;
  ownerPid: number;
}

export interface CoverageRealmContext {
  run: CoverageRunConfig;
  realm: CoverageRealm;
  toolVersion: string;
}

export interface CoverageSnapshot {
  result: RawScript[];
  timestamp?: number;
  sources: Record<string, string>;
}

export interface RawRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface RawFunction {
  functionName: string;
  ranges: RawRange[];
  isBlockCoverage: boolean;
}

export interface RawScript {
  scriptId: string;
  url: string;
  functions: RawFunction[];
}

interface GeneratedPosition {
  line: number;
  column: number;
}

interface OriginalPosition extends GeneratedPosition {
  source: string;
}

interface PositionMap {
  hasMap: boolean;
  positions: Array<OriginalPosition | null>;
}

interface GeneratedLine {
  number: number;
  start: number;
  end: number;
  text: string;
}

interface MappedPosition {
  path: string;
  line: number;
  column: number;
}

interface AggregatedPoint {
  hits: number;
  coveredIn: Set<string>;
}

interface AggregatedFile {
  sourceHash: string;
  realmIds: Set<string>;
  lines: Map<number, AggregatedPoint>;
  functions: Map<string, AggregatedPoint & { name: string; range: SourceRange }>;
  branches: Map<string, AggregatedPoint & { range: SourceRange }>;
}

const fs = new DiskFileSystem();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const emptyMetric = (): CoverageMetric => ({ covered: 0, total: 0, percent: 0 });
const emptyTotals = (): CoverageTotals => ({
  lines: emptyMetric(),
  functions: emptyMetric(),
  branches: emptyMetric(),
});
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
let runSequence = 0;

async function ensureDirectory(path: string): Promise<void> {
  if (path === '.' || path === '/') return;
  try {
    const stat = await fs.stat(path);
    if (!stat.isDirectory()) throw new Error(`${path} is not a directory`);
    return;
  } catch {
    const parent = String(dirname(path));
    if (parent !== path) await ensureDirectory(parent);
    try {
      await fs.mkdir(path);
    } catch {
      const stat = await fs.stat(path);
      if (!stat.isDirectory()) throw new Error(`${path} is not a directory`);
    }
  }
}

/** Prepare the filesystem paths and identity for a native run registration. @internal */
export async function prepareCoverageRun(path: string): Promise<CoverageRunConfig> {
  if (path.length === 0) throw new Error('--coverage path must not be empty');
  const root = await fs.realpath(cwd());
  const outputPath = String(resolve(root, path));
  const outputDirectory = String(dirname(outputPath));
  await ensureDirectory(outputDirectory);
  const runId = `${pid}-${Date.now()}-${runSequence++}`;
  const shardDir = String(join(outputDirectory, `.fino-coverage-${runId}`));
  await fs.mkdir(shardDir);
  return { outputPath, shardDir, root, runId, ownerPid: pid };
}

/** Split generated source into end-exclusive UTF-16 line ranges. @internal */
export function generatedLines(source: string): GeneratedLine[] {
  const lines: GeneratedLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const next = newline === -1 ? source.length : newline + 1;
    let end = newline === -1 ? source.length : newline;
    if (end > start && source[end - 1] === '\r') end--;
    lines.push({ number: lines.length, start, end, text: source.slice(start, end) });
    start = next;
  }
  if (source.length === 0) lines.push({ number: 0, start: 0, end: 0, text: '' });
  return lines;
}

/** Convert a V8 UTF-16 offset to a zero-based generated position. @internal */
export function offsetToLineColumn(source: string, target: number): GeneratedPosition {
  let offset = 0;
  let line = 0;
  let column = 0;
  for (const character of source) {
    if (offset >= target) break;
    const width = character.length;
    if (offset + width > target) break;
    offset += width;
    if (character === '\n') {
      line++;
      column = 0;
    } else {
      column += width;
    }
  }
  return { line, column };
}

/** Compute the stable content hash stored in coverage artifacts. @internal */
export function sourceHash(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv64:${hash.toString(16).padStart(16, '0')}`;
}

/** Construct a two-decimal coverage metric. @internal */
export function coverageMetric(covered: number, total: number): CoverageMetric {
  return {
    covered,
    total,
    percent: total === 0 ? 0 : Math.round((covered / total) * 10_000) / 100,
  };
}

function fileUrlToPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'file:' ||
      (parsed.hostname !== '' && parsed.hostname !== 'localhost')
    ) {
      return null;
    }
    return decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
}

function resolveSourcePath(generatedPath: string, source: string): string | null {
  if (source.startsWith('file://')) return fileUrlToPath(source);
  if (isAbsolute(source)) return String(normalize(source));
  return String(resolve(dirname(generatedPath), source));
}

function excludedProjectPath(root: string, path: string): boolean {
  const display = String(relative(root, path)).replaceAll('\\', '/');
  if (display === '..' || display.startsWith('../') || display.startsWith('/')) return true;
  if (display.startsWith('.fino/') || display.includes('/node_modules/')) return true;
  return ['.test.ts', '.test.tsx', '.test.mts', '.test.js', '.test.mjs'].some((suffix) =>
    display.endsWith(suffix),
  );
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return String(normalize(path));
  }
}

function displayPath(root: string, path: string): string {
  const display = String(relative(root, path)).replaceAll('\\', '/');
  return display === '..' || display.startsWith('../') ? path.replaceAll('\\', '/') : display;
}

function collectGeneratedPositions(
  source: string,
  lines: GeneratedLine[],
  functions: RawFunction[],
): GeneratedPosition[] {
  const positions = new Map<string, GeneratedPosition>();
  const add = (position: GeneratedPosition) =>
    positions.set(`${position.line}:${position.column}`, position);
  for (const line of lines) {
    if (line.text.trim().length === 0 || line.text.trimStart().startsWith('//')) continue;
    add({ line: line.number, column: line.text.match(/^\s*/)?.[0].length ?? 0 });
  }
  for (const fn of functions) {
    const ranges = fn.isBlockCoverage ? fn.ranges : fn.ranges.slice(0, 1);
    for (const range of ranges) {
      add(offsetToLineColumn(source, range.startOffset));
      add(offsetToLineColumn(source, Math.max(0, range.endOffset - 1)));
    }
  }
  return [...positions.values()];
}

function nativePositionMap(url: string, positions: GeneratedPosition[]): PositionMap {
  return JSON.parse(mapCoveragePositions(url, JSON.stringify(positions))) as PositionMap;
}

async function normalizeScript(
  context: CoverageRealmContext,
  script: RawScript,
  generatedPath: string,
  source: string,
  files: Map<string, LocalFile>,
  warnings: string[],
): Promise<void> {
  const lines = generatedLines(source);
  const positions = collectGeneratedPositions(source, lines, script.functions);
  const mapped = nativePositionMap(script.url, positions);
  const extension = extname(generatedPath);
  if (['.ts', '.tsx', '.mts', '.jsx'].includes(extension) && !mapped.hasMap) {
    warnings.push(`excluded ${generatedPath} because its transform has no valid source map`);
    return;
  }
  const mappedByPosition = new Map<string, OriginalPosition | null>();
  positions.forEach((position, index) => {
    mappedByPosition.set(`${position.line}:${position.column}`, mapped.positions[index] ?? null);
  });
  const canonical = new Map<string, Promise<string>>();
  const canonicalize = (path: string): Promise<string> => {
    let result = canonical.get(path);
    if (result === undefined) {
      result = canonicalPath(path);
      canonical.set(path, result);
    }
    return result;
  };
  const mapPosition = async (position: GeneratedPosition): Promise<MappedPosition | null> => {
    if (!mapped.hasMap) {
      const path = await canonicalize(generatedPath);
      return excludedProjectPath(context.run.root, path)
        ? null
        : { path, line: position.line + 1, column: position.column };
    }
    const original = mappedByPosition.get(`${position.line}:${position.column}`);
    if (!original) return null;
    const unresolved = resolveSourcePath(generatedPath, original.source);
    if (unresolved === null) return null;
    const path = await canonicalize(unresolved);
    return excludedProjectPath(context.run.root, path)
      ? null
      : { path, line: original.line + 1, column: original.column };
  };
  const localFile = async (path: string): Promise<LocalFile> => {
    const display = displayPath(context.run.root, path);
    let file = files.get(display);
    if (file === undefined) {
      let bytes = new Uint8Array();
      try {
        bytes = await fs.readFile(path);
      } catch {}
      file = {
        path: display,
        sourceHash: sourceHash(bytes),
        lines: [],
        functions: [],
        branches: [],
      };
      files.set(display, file);
    }
    return file;
  };
  const ranges = script.functions
    .flatMap((fn) => fn.ranges)
    .sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
  const lineHits: Array<number | null> = lines.map(() => null);
  for (const range of ranges) {
    lines.forEach((line, index) => {
      if (range.startOffset <= line.start && range.endOffset >= line.end) {
        lineHits[index] = range.count;
      }
    });
  }
  let producedLocation = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const hits = lineHits[index];
    if (hits === null || line.text.trim().length === 0 || line.text.trimStart().startsWith('//')) {
      continue;
    }
    const position = await mapPosition({
      line: line.number,
      column: line.text.match(/^\s*/)?.[0].length ?? 0,
    });
    if (position === null) continue;
    producedLocation = true;
    const file = await localFile(position.path);
    const existing = file.lines.find((line) => line.line === position.line);
    if (existing) existing.hits = Math.max(existing.hits, hits);
    else file.lines.push({ line: position.line, hits });
  }
  const mapRange = async (
    range: RawRange,
  ): Promise<{ path: string; range: SourceRange } | null> => {
    const start = await mapPosition(offsetToLineColumn(source, range.startOffset));
    const end = await mapPosition(offsetToLineColumn(source, Math.max(0, range.endOffset - 1)));
    if (start === null || end === null || start.path !== end.path) return null;
    return {
      path: start.path,
      range: {
        startLine: start.line,
        startColumn: start.column,
        endLine: end.line,
        endColumn: end.line === start.line ? end.column + 1 : end.column,
      },
    };
  };
  for (const fn of script.functions) {
    const first = fn.ranges[0];
    if (first !== undefined && fn.functionName.length > 0) {
      const location = await mapRange(first);
      if (location !== null) {
        producedLocation = true;
        (await localFile(location.path)).functions.push({
          name: fn.functionName,
          range: location.range,
          hits: first.count,
        });
      }
    }
    if (fn.isBlockCoverage) {
      for (const branch of fn.ranges) {
        const location = await mapRange(branch);
        if (location !== null) {
          producedLocation = true;
          (await localFile(location.path)).branches.push({
            range: location.range,
            hits: branch.count,
          });
        }
      }
    }
  }
  if (mapped.hasMap && !producedLocation) {
    warnings.push(`source map for ${generatedPath} did not produce project source locations`);
  }
}

/** Normalize one Realm's V8 snapshot into an original-source shard. @internal */
export async function normalizeCoverageSnapshot(
  context: CoverageRealmContext,
  snapshot: CoverageSnapshot,
): Promise<RealmShard> {
  if (!snapshot.sources || typeof snapshot.sources !== 'object') {
    throw new Error('coverage snapshot omitted generated sources');
  }
  const files = new Map<string, LocalFile>();
  const warnings: string[] = [];
  for (const script of snapshot.result ?? []) {
    const rawPath = fileUrlToPath(script.url);
    if (rawPath === null) continue;
    const generatedPath = await canonicalPath(rawPath);
    if (excludedProjectPath(context.run.root, generatedPath)) continue;
    const extension = extname(generatedPath);
    if (extension === '.mdx' || extension === '.sql') {
      warnings.push(
        `excluded ${generatedPath} because original-source coverage for ${extension} transforms is not yet validated`,
      );
      continue;
    }
    const source = snapshot.sources[script.scriptId];
    if (typeof source !== 'string') {
      warnings.push(`missing generated source for ${script.url}`);
      continue;
    }
    await normalizeScript(context, script, generatedPath, source, files, warnings);
  }
  for (const file of files.values()) file.lines.sort((a, b) => a.line - b.line);
  return {
    realm: { ...context.realm, status: 'complete', totals: emptyTotals() },
    files: [...files.values()].sort((a, b) => compareText(a.path, b.path)),
    warnings,
  };
}

function shardPath(config: CoverageRunConfig, realmId: string): string {
  return String(join(config.shardDir, `${realmId}.json`));
}

async function atomicWrite(path: string, value: string, suffix: string): Promise<void> {
  const temporary = `${path}.tmp-${suffix}`;
  await fs.writeFile(temporary, encoder.encode(value));
  await fs.rename(temporary, path);
}

/** Atomically replace a Realm's native crash placeholder with its final shard. @internal */
export async function writeCoverageShard(
  config: CoverageRunConfig,
  shard: RealmShard,
): Promise<void> {
  await atomicWrite(shardPath(config, shard.realm.id), JSON.stringify(shard), shard.realm.id);
}

async function readShards(config: CoverageRunConfig): Promise<RealmShard[]> {
  const directory = await fs.dir(config.shardDir);
  const shards: RealmShard[] = [];
  for (const entry of await directory.entries()) {
    if (!entry.name.endsWith('.json')) continue;
    shards.push(JSON.parse(decoder.decode(await fs.readFile(entry.path))) as RealmShard);
  }
  return shards.sort((a, b) => compareText(a.realm.id, b.realm.id));
}

/** Wait briefly for registered child Realms, leaving crashed ones missing. @internal */
export async function waitForCoverageShards(config: CoverageRunConfig): Promise<RealmShard[]> {
  const deadline = Date.now() + 1_000;
  while (true) {
    const shards = await readShards(config);
    if (!shards.some((shard) => shard.realm.status === 'missing') || Date.now() >= deadline) {
      return shards;
    }
    await new Promise<void>((done) => setTimeout(done, 10));
  }
}

function totalsFor(files: CoverageFile[], realmId?: string): CoverageTotals {
  const lines = files.flatMap((file) => file.lines);
  const functions = files.flatMap((file) => file.functions);
  const branches = files.flatMap((file) => file.branches);
  const covered = (value: { hits: number; coveredIn: string[] }): boolean =>
    realmId === undefined ? value.hits > 0 : value.coveredIn.includes(realmId);
  return {
    lines: coverageMetric(lines.filter(covered).length, lines.length),
    functions: coverageMetric(functions.filter(covered).length, functions.length),
    branches: coverageMetric(branches.filter(covered).length, branches.length),
  };
}

async function normalizeRealmEntry(root: string, entry: string | null): Promise<string | null> {
  if (entry === null || entry.startsWith('internal:') || entry.startsWith('fino:')) return entry;
  const path = entry.startsWith('file://') ? fileUrlToPath(entry) : String(resolve(root, entry));
  if (path === null) return entry;
  return displayPath(root, await canonicalPath(path));
}

/** Aggregate all Realm shards into the stable, versioned coverage artifact. @internal */
export async function aggregateCoverageShards(
  config: CoverageRunConfig,
  toolVersion: string,
  shards: RealmShard[],
): Promise<CoverageArtifact> {
  const aggregate = new Map<string, AggregatedFile>();
  const warnings: string[] = [];
  for (const shard of shards) {
    warnings.push(...shard.warnings.map((warning) => `${shard.realm.id}: ${warning}`));
    for (const file of shard.files) {
      let target = aggregate.get(file.path);
      if (target === undefined) {
        target = {
          sourceHash: file.sourceHash,
          realmIds: new Set(),
          lines: new Map(),
          functions: new Map(),
          branches: new Map(),
        };
        aggregate.set(file.path, target);
      } else if (target.sourceHash !== file.sourceHash) {
        warnings.push(
          `${file.path} was loaded with conflicting source hashes ${target.sourceHash} and ${file.sourceHash}`,
        );
      }
      target.realmIds.add(shard.realm.id);
      for (const line of file.lines) {
        let point = target.lines.get(line.line);
        if (point === undefined) {
          point = { hits: 0, coveredIn: new Set() };
          target.lines.set(line.line, point);
        }
        point.hits += line.hits;
        if (line.hits > 0) point.coveredIn.add(shard.realm.id);
      }
      for (const fn of file.functions) {
        const key = JSON.stringify([
          fn.name,
          fn.range.startLine,
          fn.range.startColumn,
          fn.range.endLine,
          fn.range.endColumn,
        ]);
        let point = target.functions.get(key);
        if (point === undefined) {
          point = { name: fn.name, range: fn.range, hits: 0, coveredIn: new Set() };
          target.functions.set(key, point);
        }
        point.hits += fn.hits;
        if (fn.hits > 0) point.coveredIn.add(shard.realm.id);
      }
      for (const branch of file.branches) {
        const key = JSON.stringify([
          branch.range.startLine,
          branch.range.startColumn,
          branch.range.endLine,
          branch.range.endColumn,
        ]);
        let point = target.branches.get(key);
        if (point === undefined) {
          point = { range: branch.range, hits: 0, coveredIn: new Set() };
          target.branches.set(key, point);
        }
        point.hits += branch.hits;
        if (branch.hits > 0) point.coveredIn.add(shard.realm.id);
      }
    }
  }
  const files: CoverageFile[] = [...aggregate.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([path, file]) => {
      const lines = [...file.lines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([line, point]) => ({
          line,
          hits: point.hits,
          coveredIn: [...point.coveredIn].sort(compareText),
        }));
      const functions = [...file.functions.entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([, point], index) => ({
          id: `function-${index}`,
          name: point.name,
          range: point.range,
          hits: point.hits,
          coveredIn: [...point.coveredIn].sort(compareText),
        }));
      const branches = [...file.branches.entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([, point], index) => ({
          id: `branch-${index}`,
          range: point.range,
          hits: point.hits,
          coveredIn: [...point.coveredIn].sort(compareText),
        }));
      const result: CoverageFile = {
        path,
        sourceHash: file.sourceHash,
        realmIds: [...file.realmIds].sort(compareText),
        totals: emptyTotals(),
        lines,
        functions,
        branches,
      };
      result.totals = totalsFor([result]);
      return result;
    });
  const realms = await Promise.all(
    shards.map(async (shard) => ({
      ...shard.realm,
      entry: await normalizeRealmEntry(config.root, shard.realm.entry),
      totals: totalsFor(files, shard.realm.id),
    })),
  );
  realms.sort((a, b) => compareText(a.id, b.id));
  const complete =
    realms.every((realm) => realm.status === 'complete') &&
    !warnings.some((warning) => warning.includes('conflicting source hashes'));
  return {
    schemaVersion: 1,
    tool: { name: 'fino', version: toolVersion },
    run: { root: config.root, id: config.runId, complete },
    totals: totalsFor(files),
    realms,
    files,
    warnings,
  };
}

async function removeShardDirectory(config: CoverageRunConfig): Promise<void> {
  const directory = await fs.dir(config.shardDir);
  for (const entry of await directory.entries()) await fs.unlink(entry.path);
  await fs.rmdir(config.shardDir);
}

/** Aggregate, publish, and summarize the complete run artifact. @internal */
export async function finishCoverageArtifact(
  config: CoverageRunConfig,
  toolVersion: string,
): Promise<CoverageSummary> {
  const shards = await waitForCoverageShards(config);
  const artifact = await aggregateCoverageShards(config, toolVersion, shards);
  await atomicWrite(config.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, config.runId);
  if (artifact.run.complete) {
    try {
      await removeShardDirectory(config);
    } catch {}
  }
  const incompleteRealmCount = artifact.realms.filter(
    (realm) => realm.status !== 'complete',
  ).length;
  return {
    path: displayPath(config.root, config.outputPath),
    complete: artifact.run.complete,
    totals: artifact.totals,
    realmCount: artifact.realms.length,
    incompleteRealmCount,
    warnings: artifact.warnings,
  };
}
