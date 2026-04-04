/**
 * internal:file/glob — Glob pattern matching and async directory walker.
 *
 * All I/O is injected via the `listDir` callback rather than imported
 * at the top level, keeping this module free of top-level dependencies.
 *
 * The `glob()` function returns a custom async iterable backed by a
 * push-queue / pull-iterator pattern: a fire-and-forget async walk pushes
 * matching entries into a queue; the async iterator's `next()` pulls from the
 * queue or waits until an entry (or done) arrives.
 *
 * Supported glob syntax:
 *   *       any characters except /
 *   **      zero or more path segments (directory wildcard)
 *   ?       any single character except /
 *   [abc]   character class
 *   [!abc]  negated character class
 *   {a,b}   alternation (brace expansion, may be nested)
 *   \*      escaped literal
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escClass(ch: string): string {
  return ch.replace(/[\\^\]]/g, '\\$&');
}

function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

// ---------------------------------------------------------------------------
// Pattern compilation
// ---------------------------------------------------------------------------

function compileSegment(pat: string): string {
  let re = '';
  let i = 0;

  while (i < pat.length) {
    const ch = pat[i]!;

    if (ch === '\\' && i + 1 < pat.length) {
      re += escRe(pat[i + 1]!);
      i += 2;
      continue;
    }

    if (ch === '*' && pat[i + 1] === '*') {
      const prevSlash = i === 0 || pat[i - 1] === '/';
      const afterStar = i + 2;
      const nextSlash = pat[afterStar] === '/';
      const atEnd = afterStar >= pat.length;

      if (prevSlash && nextSlash) {
        re += '(?:[^/]+/)*';
        i += 3;
      } else if (prevSlash && atEnd) {
        re += '(?:[^/]+/)*[^/]*';
        i += 2;
      } else {
        re += '.*';
        i += 2;
      }
      continue;
    }

    if (ch === '*') { re += '[^/]*'; i++; continue; }
    if (ch === '?') { re += '[^/]';  i++; continue; }

    if (ch === '[') {
      let j = i + 1;
      let cls = '[';
      if (j < pat.length && (pat[j] === '!' || pat[j] === '^')) { cls += '^'; j++; }
      if (j < pat.length && pat[j] === ']')                      { cls += '\\]'; j++; }
      while (j < pat.length && pat[j] !== ']') {
        if (pat[j] === '\\' && j + 1 < pat.length) { cls += escClass(pat[j + 1]!); j += 2; }
        else                                        { cls += escClass(pat[j]!);     j++;     }
      }
      cls += ']';
      re += cls;
      i = j + 1;
      continue;
    }

    if (ch === '{') {
      let j = i + 1;
      let depth = 1;
      while (j < pat.length && depth > 0) {
        if (pat[j] === '{') depth++;
        else if (pat[j] === '}') depth--;
        j++;
      }
      const content = pat.slice(i + 1, j - 1);
      const alts = splitTop(content, ',');
      re += '(?:' + alts.map(compileSegment).join('|') + ')';
      i = j;
      continue;
    }

    re += escRe(ch);
    i++;
  }

  return re;
}

// ---------------------------------------------------------------------------
// Glob class (public API)
// ---------------------------------------------------------------------------

/**
 * Compiled glob pattern for path matching.
 *
 * @example
 * const g = new Glob('**\/*.mts');
 * g.test('src/index.mts');       // true
 * g.test('src/lib/util.mts');    // true
 * g.test('README.md');            // false
 */
export class Glob {
  #pattern: string;
  #re: RegExp;
  #dot: boolean;
  #segPatterns: RegExp[] | null;

  constructor(pattern: string, options?: { dot?: boolean }) {
    this.#pattern = pattern;
    this.#dot = options?.dot ?? false;
    this.#re = new RegExp('^' + compileSegment(pattern) + '$');
    const segs = pattern.split('/');
    this.#segPatterns = segs.includes('**')
      ? null
      : segs.map(s => new RegExp('^' + compileSegment(s) + '$'));
  }

  get pattern(): string { return this.#pattern; }

  test(path: string): boolean {
    const s = typeof path === 'string' ? path : String(path);
    if (!this.#dot) {
      const pathSegs = s.split('/');
      const patSegs = this.#pattern.split('/');
      for (let i = 0; i < pathSegs.length; i++) {
        if (!pathSegs[i]!.startsWith('.')) continue;
        const pat = patSegs[i] ?? '';
        if (!pat.startsWith('.')) return false;
      }
    }
    return this.#re.test(s);
  }

  /** Return true if a dir at `dirRel` could contain matching entries. */
  couldMatch(dirRel: string): boolean {
    if (!this.#segPatterns) return true;
    const patSegs = this.#pattern.split('/');
    const dirSegs = dirRel.split('/');
    if (dirSegs.length >= patSegs.length) return false;
    for (let i = 0; i < dirSegs.length; i++) {
      if (!this.#segPatterns[i]!.test(dirSegs[i]!)) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Directory walker (push queue / pull iterator pattern)
// ---------------------------------------------------------------------------

export interface GlobEntry {
  name: string;
  path: any;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymlink(): boolean;
}

export type ListDir = (path: string) => Promise<GlobEntry[]>;

export interface GlobOptions {
  cwd?: string;
  dot?: boolean;
  onlyFiles?: boolean;
  onlyDirectories?: boolean;
  signal?: AbortSignal;
}

/**
 * Walk the filesystem via `listDir`, yielding entries matching `pattern`.
 *
 * Uses a push-queue / pull-iterator pattern: a fire-and-forget async walk
 * pushes results into a queue; the iterator's `next()` pulls from the queue
 * or waits for the next push.
 */
export function glob(listDir: ListDir, pattern: string, options: GlobOptions = {}): AsyncIterable<GlobEntry> {
  const dot       = options.dot            ?? false;
  const onlyFiles = options.onlyFiles      ?? false;
  const onlyDirs  = options.onlyDirectories ?? false;
  const signal    = options.signal;
  const cwd       = options.cwd ?? '.';

  const g = new Glob(pattern, { dot });

  // Find the longest fixed prefix to determine the start directory.
  const patSegs = pattern.split('/');
  let fixedCount = 0;
  for (const seg of patSegs) {
    if (/[*?{[]/.test(seg) || seg === '**') break;
    fixedCount++;
  }
  const relPrefix = patSegs.slice(0, fixedCount).join('/');
  const startDir  = relPrefix
    ? (cwd === '.' ? relPrefix : `${cwd}/${relPrefix}`)
    : cwd;

  // Push-queue state
  const queue: GlobEntry[] = [];
  const waiters: Array<(r: IteratorResult<GlobEntry>) => void> = [];
  let isDone = false;

  function emit(entry: GlobEntry): void {
    if (waiters.length > 0) {
      waiters.shift()!({ value: entry, done: false });
    } else {
      queue.push(entry);
    }
  }

  function finish(): void {
    isDone = true;
    for (const resolve of waiters) {
      resolve({ value: undefined as any, done: true });
    }
    waiters.length = 0;
  }

  // Start the walk immediately (fire and forget).
  walkDir(listDir, startDir, relPrefix, g, dot, onlyFiles, onlyDirs, signal, emit)
    .then(finish, finish);

  // Return an async iterable.
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<GlobEntry>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (isDone) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise(function parkGlobNext(resolve) { waiters.push(resolve); });
        },
      };
    },
  };
}

async function walkDir(
  listDir: ListDir,
  dirPath: string,
  relDir: string,
  g: Glob,
  dot: boolean,
  onlyFiles: boolean,
  onlyDirs: boolean,
  signal: AbortSignal | undefined,
  emit: (entry: GlobEntry) => void,
): Promise<void> {
  if (signal?.aborted) return;

  let entries: GlobEntry[];
  try {
    entries = await listDir(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (signal?.aborted) return;

    const name = entry.name;
    if (!dot && name.startsWith('.')) continue;

    const entryRel = relDir ? `${relDir}/${name}` : name;

    if (entry.isDirectory()) {
      if (g.test(entryRel) && !onlyFiles) emit(entry);
      if (g.couldMatch(entryRel)) {
        const childPath = dirPath === '.' ? name : `${dirPath}/${name}`;
        await walkDir(listDir, childPath, entryRel, g, dot, onlyFiles, onlyDirs, signal, emit);
      }
    } else {
      if (g.test(entryRel) && !onlyDirs) emit(entry);
    }
  }
}
