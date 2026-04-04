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

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const XRANGE_RE = /^(0|[1-9]\d*|x|X|\*)(?:\.(0|[1-9]\d*|x|X|\*))?(?:\.(0|[1-9]\d*|x|X|\*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMPARATOR_RE = /^(<=|>=|<|>)?\s*([^\s]+)$/;

function isWildcard(part: string | undefined): boolean {
  return part == null || part === '' || part === 'x' || part === 'X' || part === '*';
}

function parseIdentifier(id: string): string | number {
  if (/^(0|[1-9]\d*)$/.test(id)) return Number(id);
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
  const match = String(input).trim().match(XRANGE_RE);
  if (!match) throw new Error(`Invalid semver range version '${input}'`);
  const major = match[1];
  if (major === undefined) throw new Error(`Invalid semver range version '${input}'`);
  return {
    major,
    ...(match[2] !== undefined ? { minor: match[2] } : {}),
    ...(match[3] !== undefined ? { patch: match[3] } : {}),
    prerelease: match[4] ? match[4].split('.') : [],
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
  const match = token.match(COMPARATOR_RE);
  if (!match) throw new Error(`Invalid semver comparator '${token}'`);
  const op = (match[1] ?? '') as '' | '>' | '>=' | '<' | '<=';
  const value = match[2];
  if (value === undefined) throw new Error(`Invalid semver comparator '${token}'`);
  return comparatorFromParts(op, value);
}

function parseRangeSet(text: string): ComparatorSet {
  const comparators: Comparator[] = [];
  const prereleaseBases = new Set<string>();
  for (const rawToken of text.trim().split(/\s+/)) {
    if (!rawToken) continue;
    for (const comparator of expandToken(rawToken)) {
      comparators.push(comparator);
      if (comparator.version.prerelease.length > 0) prereleaseBases.add(baseKey(comparator.version));
    }
  }
  return { comparators, prereleaseBases };
}

function normalizeHyphenRanges(input: string): string {
  return input.replace(
    /([^\s]+)\s+-\s+([^\s]+)/g,
    (_, lower, upper) => `>=${lower} <=${upper}`,
  );
}

function parseRange(input: string | null | undefined): ComparatorSet[] {
  const text = String(input ?? '').trim();
  if (text === '' || text === '*' || text.toLowerCase() === 'latest') return [{ comparators: [], prereleaseBases: new Set() }];
  return normalizeHyphenRanges(text)
    .split('||')
    .map((part) => parseRangeSet(part))
    .filter((set) => set.comparators.length > 0 || partIsWildcard(input));
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

export function parse(version: string): SemVer {
  const match = String(version).trim().match(VERSION_RE);
  if (!match) throw new Error(`Invalid semver version '${version}'`);
  const prerelease = match[4] ? match[4].split('.').map(parseIdentifier) : [];
  const build = match[5] ? match[5].split('.') : [];
  const parsed: SemVer = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    build,
    version: '',
  };
  parsed.version = formatSemVer(parsed);
  return parsed;
}

export function valid(version: string): string | null {
  try {
    return parse(version).version;
  } catch (_) {
    return null;
  }
}

export function compare(a: string, b: string): number {
  return compareParsed(parse(a), parse(b));
}

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

export function maxSatisfying(versions: string[], range: string | null | undefined): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!satisfies(version, range)) continue;
    if (best === null || compare(version, best) > 0) best = version;
  }
  return best;
}

export function validRange(range: string | null | undefined): string | null {
  try {
    parseRange(range);
    return String(range ?? '').trim() || '*';
  } catch (_) {
    return null;
  }
}
