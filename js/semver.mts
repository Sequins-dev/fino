/**
 * fino:semver — semantic version parsing, comparison, and range matching.
 *
 * Implements the SemVer 2.0.0 precedence rules plus the npm-style range forms
 * used by the Fino package installer: comparators, hyphen ranges, wildcards,
 * tilde ranges, caret ranges, and `||` disjunctions. Build metadata is parsed
 * and preserved but ignored for precedence comparisons.
 */

import { Scanner } from 'fino:parsing/scanner';

/** Parsed SemVer components with prerelease identifiers split by segment. */
interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  build: string[];
  version: string;
}

interface Comparator {
  op: '' | '>' | '>=' | '<' | '<=';
  version: SemVer;
}

interface ComparatorSet {
  comparators: Comparator[];
  prereleaseBases: Set<string>;
}

function isWildcard(part: string | undefined): boolean {
  return part == null || part === '' || part === 'x' || part === 'X' || part === '*';
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAlphaNumHyphen(code: number): boolean {
  return isDigit(code) ||
    (code >= 0x41 && code <= 0x5A) ||
    (code >= 0x61 && code <= 0x7A) ||
    code === 0x2D;
}

function readNumericIdentifier(sc: Scanner, input: string, name: string): string {
  const value = sc.eatWhile(isDigit);
  if (value === '') throw new Error(`Invalid semver ${name} '${input}'`);
  if (value.length > 1 && value.startsWith('0')) throw new Error(`Invalid semver ${name} '${input}'`);
  return value;
}

function readXRangePart(sc: Scanner, input: string): string {
  const code = sc.peekCode();
  if (code === 0x78 || code === 0x58 || code === 0x2A) return sc.eat();
  return readNumericIdentifier(sc, input, 'range version');
}

function readIdentifier(sc: Scanner, input: string, name: string, strictNumeric: boolean): string {
  const value = sc.eatWhile(isAlphaNumHyphen);
  if (value === '') throw new Error(`Invalid semver ${name} '${input}'`);
  if (strictNumeric && value.length > 1 && value.startsWith('0') && [...value].every((ch) => ch >= '0' && ch <= '9')) {
    throw new Error(`Invalid semver ${name} '${input}'`);
  }
  return value;
}

function readIdentifierList(sc: Scanner, input: string, name: string, strictNumeric: boolean): string[] {
  const out = [readIdentifier(sc, input, name, strictNumeric)];
  while (sc.eatChar('.')) out.push(readIdentifier(sc, input, name, strictNumeric));
  return out;
}

function parseIdentifier(id: string): string | number {
  if ([...id].every((ch) => ch >= '0' && ch <= '9')) return Number(id);
  return id;
}

function compareIdentifier(a: string | number, b: string | number): number {
  const aNum = typeof a === 'number';
  const bNum = typeof b === 'number';
  if (aNum && bNum) return a - b;
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneSemVer(version: SemVer): SemVer {
  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    prerelease: [...version.prerelease],
    build: [...version.build],
    version: version.version,
  };
}

function formatSemVer(version: Pick<SemVer, 'major' | 'minor' | 'patch' | 'prerelease' | 'build'>): string {
  let value = `${version.major}.${version.minor}.${version.patch}`;
  if (version.prerelease.length > 0) value += `-${version.prerelease.join('.')}`;
  if (version.build.length > 0) value += `+${version.build.join('.')}`;
  return value;
}

function baseKey(version: Pick<SemVer, 'major' | 'minor' | 'patch'>): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function compareParsed(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const result = compareIdentifier(left, right);
    if (result !== 0) return result;
  }
  return 0;
}

function parsePartialVersion(input: string): {
  major: string;
  minor?: string;
  patch?: string;
  prerelease: string[];
} {
  const text = String(input).trim();
  const sc = new Scanner(text, { encoding: 'ascii', format: 'semver' });
  let major: string;
  let minor: string | undefined;
  let patch: string | undefined;
  let prerelease: string[] = [];
  try {
    major = readXRangePart(sc, input);
    if (sc.eatChar('.')) {
      minor = readXRangePart(sc, input);
      if (sc.eatChar('.')) patch = readXRangePart(sc, input);
    }
    if (sc.eatChar('-')) prerelease = readIdentifierList(sc, input, 'range version', true);
    if (!sc.done) throw new Error();
  } catch (_) {
    throw new Error(`Invalid semver range version '${input}'`);
  }
  return {
    major,
    ...(minor !== undefined ? { minor } : {}),
    ...(patch !== undefined ? { patch } : {}),
    prerelease,
  };
}

function toSemVer(parts: {
  major: string;
  minor?: string;
  patch?: string;
  prerelease?: string[];
}): SemVer {
  const major = isWildcard(parts.major) ? 0 : Number(parts.major);
  const minor = isWildcard(parts.minor) ? 0 : Number(parts.minor);
  const patch = isWildcard(parts.patch) ? 0 : Number(parts.patch);
  const prerelease = (parts.prerelease ?? []).map(parseIdentifier);
  const build: string[] = [];
  return {
    major,
    minor,
    patch,
    prerelease,
    build,
    version: formatSemVer({ major, minor, patch, prerelease, build }),
  };
}

function increment(version: SemVer, part: 'major' | 'minor' | 'patch'): SemVer {
  const next = cloneSemVer(version);
  next.prerelease = [];
  next.build = [];
  if (part === 'major') {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (part === 'minor') {
    next.minor += 1;
    next.patch = 0;
  } else {
    next.patch += 1;
  }
  next.version = formatSemVer(next);
  return next;
}

function hasWildcard(parts: { major: string; minor?: string; patch?: string }): boolean {
  return isWildcard(parts.major) || isWildcard(parts.minor) || isWildcard(parts.patch);
}

function xRangeToComparators(input: string): Comparator[] {
  const parts = parsePartialVersion(input);
  if (isWildcard(parts.major)) return [];
  const lower = toSemVer(parts);
  if (isWildcard(parts.minor)) {
    return [{ op: '>=', version: lower }, { op: '<', version: increment(lower, 'major') }];
  }
  if (isWildcard(parts.patch)) {
    return [{ op: '>=', version: lower }, { op: '<', version: increment(lower, 'minor') }];
  }
  return [{ op: '', version: lower }];
}

function tildeComparators(input: string): Comparator[] {
  const parts = parsePartialVersion(input);
  const lower = toSemVer(parts);
  let upper: SemVer;
  if (isWildcard(parts.minor)) {
    upper = increment(lower, 'major');
  } else {
    upper = increment(lower, 'minor');
  }
  return [{ op: '>=', version: lower }, { op: '<', version: upper }];
}

function caretComparators(input: string): Comparator[] {
  const parts = parsePartialVersion(input);
  const lower = toSemVer(parts);
  let upper: SemVer;
  if (lower.major > 0) {
    upper = increment(lower, 'major');
  } else if (lower.minor > 0) {
    upper = increment(lower, 'minor');
  } else {
    upper = increment(lower, 'patch');
  }
  return [{ op: '>=', version: lower }, { op: '<', version: upper }];
}

function comparatorFromParts(op: '' | '>' | '>=' | '<' | '<=', input: string): Comparator[] {
  const parts = parsePartialVersion(input);
  if (hasWildcard(parts)) {
    const comparators = xRangeToComparators(input);
    if (comparators.length === 0) return [];
    if (op === '') return comparators;
    const lower = comparators[0];
    const upper = comparators[1];
    if (!lower || !upper) return [];
    if (op === '>=') return [lower];
    if (op === '>') return [{ op: '>=', version: upper.version }];
    if (op === '<') return [{ op: '<', version: lower.version }];
    if (op === '<=') return [upper];
  }
  return [{ op, version: toSemVer(parts) }];
}

function expandToken(token: string): Comparator[] {
  if (token === '' || token === '*' || token.toLowerCase() === 'x') return [];
  if (token.startsWith('^')) return caretComparators(token.slice(1));
  if (token.startsWith('~')) return tildeComparators(token.slice(1));
  const sc = new Scanner(token, { encoding: 'ascii', format: 'semver' });
  let op: '' | '>' | '>=' | '<' | '<=' = '';
  if (sc.match('<=')) op = '<=';
  else if (sc.match('>=')) op = '>=';
  else if (sc.match('<')) op = '<';
  else if (sc.match('>')) op = '>';
  const start = sc.mark();
  sc.eatWhile((code) => code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D);
  const value = sc.text(start);
  if (value === '' || !sc.done) throw new Error(`Invalid semver comparator '${token}'`);
  return comparatorFromParts(op, value);
}

function tokenizeRangeSet(text: string): string[] {
  const sc = new Scanner(text, { encoding: 'ascii', format: 'semver' });
  const tokens: string[] = [];
  while (!sc.done) {
    sc.skipWhitespace();
    if (sc.done) break;
    const start = sc.mark();
    sc.eatWhile((code) => code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D);
    tokens.push(sc.text(start));
  }
  return tokens;
}

function parseRangeSet(text: string): ComparatorSet {
  const comparators: Comparator[] = [];
  const prereleaseBases = new Set<string>();
  for (const rawToken of tokenizeRangeSet(text.trim())) {
    if (!rawToken) continue;
    for (const comparator of expandToken(rawToken)) {
      comparators.push(comparator);
      if (comparator.version.prerelease.length > 0) prereleaseBases.add(baseKey(comparator.version));
    }
  }
  return { comparators, prereleaseBases };
}

function normalizeHyphenRanges(input: string): string {
  const tokens = tokenizeRangeSet(input);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i + 2 < tokens.length && tokens[i + 1] === '-') {
      out.push(`>=${tokens[i]}`, `<=${tokens[i + 2]}`);
      i += 2;
    } else {
      out.push(tokens[i]!);
    }
  }
  return out.join(' ');
}

function parseRange(input: string | null | undefined): ComparatorSet[] {
  const text = String(input ?? '').trim();
  if (text === '' || text === '*' || text.toLowerCase() === 'latest') return [{ comparators: [], prereleaseBases: new Set() }];
  const sc = new Scanner(text, { encoding: 'ascii', format: 'semver' });
  const sets: ComparatorSet[] = [];
  let branchStart = sc.mark();
  while (!sc.done) {
    if (sc.peek(2) === '||') {
      const branchEnd = sc.mark();
      const branch = sc.text(branchStart).trim();
      if (branch === '') throw new Error(`Invalid semver range '${input}'`);
      sets.push(parseRangeSet(normalizeHyphenRanges(branch)));
      sc.restore(branchEnd);
      sc.expect('||');
      branchStart = sc.mark();
      continue;
    }
    sc.eat();
  }
  const branch = sc.text(branchStart).trim();
  if (branch === '') throw new Error(`Invalid semver range '${input}'`);
  sets.push(parseRangeSet(normalizeHyphenRanges(branch)));
  return sets.filter((set) => set.comparators.length > 0 || partIsWildcard(input));
}

function partIsWildcard(input: string | null | undefined): boolean {
  const text = String(input ?? '').trim();
  return text === '' || text === '*' || text.toLowerCase() === 'latest';
}

function testComparator(version: SemVer, comparator: Comparator): boolean {
  const result = compareParsed(version, comparator.version);
  if (comparator.op === '') return result === 0;
  if (comparator.op === '>') return result > 0;
  if (comparator.op === '>=') return result >= 0;
  if (comparator.op === '<') return result < 0;
  return result <= 0;
}

/**
 * Parse a version string and return its structured components.
 *
 * ```ts no_run
 * import { parse } from 'fino:semver';
 *
 * parse('1.2.3-beta.1+build.5').prerelease; // ['beta', 1]
 * ```
 */
export function parse(version: string): SemVer {
  const input = String(version).trim();
  const sc = new Scanner(input, { encoding: 'ascii', format: 'semver' });
  try {
    const major = Number(readNumericIdentifier(sc, version, 'version'));
    sc.expect('.');
    const minor = Number(readNumericIdentifier(sc, version, 'version'));
    sc.expect('.');
    const patch = Number(readNumericIdentifier(sc, version, 'version'));
    const prerelease = sc.eatChar('-')
      ? readIdentifierList(sc, version, 'version', true).map(parseIdentifier)
      : [];
    const build = sc.eatChar('+')
      ? readIdentifierList(sc, version, 'version', false)
      : [];
    if (!sc.done) throw new Error();
    const parsed: SemVer = { major, minor, patch, prerelease, build, version: '' };
    parsed.version = formatSemVer(parsed);
    return parsed;
  } catch (_) {
    throw new Error(`Invalid semver version '${version}'`);
  }
}

/**
 * Return the normalized version string, or `null` when the input is invalid.
 */
export function valid(version: string): string | null {
  try {
    return parse(version).version;
  } catch (_) {
    return null;
  }
}

/**
 * Compare two versions using SemVer precedence.
 *
 * Returns a negative number when `a < b`, zero when they are equal, and a
 * positive number when `a > b`.
 */
export function compare(a: string, b: string): number {
  return compareParsed(parse(a), parse(b));
}

/**
 * Test whether a version satisfies a range expression.
 *
 * ```ts no_run
 * import { satisfies } from 'fino:semver';
 *
 * satisfies('1.4.2', '^1.2.0'); // true
 * satisfies('2.0.0', '^1.2.0'); // false
 * ```
 */
export function satisfies(version: string, range: string | null | undefined): boolean {
  const parsedVersion = parse(version);
  for (const set of parseRange(range)) {
    let matches = true;
    for (const comparator of set.comparators) {
      if (!testComparator(parsedVersion, comparator)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (parsedVersion.prerelease.length > 0 && !set.prereleaseBases.has(baseKey(parsedVersion)) && set.comparators.length > 0) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Return the highest version in `versions` that satisfies `range`.
 */
export function maxSatisfying(versions: string[], range: string | null | undefined): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!satisfies(version, range)) continue;
    if (best === null || compare(version, best) > 0) best = version;
  }
  return best;
}

/**
 * Validate a range expression and return its trimmed form, or `null`.
 */
export function validRange(range: string | null | undefined): string | null {
  try {
    parseRange(range);
    return String(range ?? '').trim() || '*';
  } catch (_) {
    return null;
  }
}
