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
*
* ## Example
*
* ```typescript no_run
* import { glob } from 'internal:file/glob';
*
* for await (const entry of glob(listDir, 'src/**\/*.ts', { cwd: '.', dot: false })) {
*   if (entry.isFile()) console.log(entry.path);
* }
* ```
*
* @internal
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
    if (ch === '*') {
      re += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      let cls = '[';
      if (j < pat.length && (pat[j] === '!' || pat[j] === '^')) {
        cls += '^';
        j++;
      }
      if (j < pat.length && pat[j] === ']') {
        cls += '\\]';
        j++;
      }
      while (j < pat.length && pat[j] !== ']') {
        if (pat[j] === '\\' && j + 1 < pat.length) {
          cls += escClass(pat[j + 1]!);
          j += 2;
        } else {
          cls += escClass(pat[j]!);
          j++;
        }
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
* ```ts no_run
* const g = new Glob('**\/*.ts');
* g.test('src/index.ts');       // true
* g.test('src/lib/util.ts');    // true
* g.test('README.md');            // false
* ```
*
* @internal
*/
export class Glob {
  /**
  * Private property `#pattern` used by `Glob`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #pattern = undefined;
  *
  *   readInternalState() {
  *     return this.#pattern;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #pattern: string;
  /**
  * Private property `#re` used by `Glob`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #re = undefined;
  *
  *   readInternalState() {
  *     return this.#re;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #re: RegExp;
  /**
  * Private property `#dot` used by `Glob`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #dot = undefined;
  *
  *   readInternalState() {
  *     return this.#dot;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #dot: boolean;
  /**
  * Private property `#segPatterns` used by `Glob`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #segPatterns = undefined;
  *
  *   readInternalState() {
  *     return this.#segPatterns;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #segPatterns: RegExp[] | null;
  /**
  * Compile a glob pattern.
  *
  * Hidden dot segments are excluded by default unless `options.dot` is true
  * or the pattern segment itself starts with a dot.
  *
  * ```typescript no_run
  * import { Glob } from 'internal:file/glob';
  * const g = new Glob('src/**\/*.ts', { dot: false });
  * ```
  */
  constructor(pattern: string, options?: {
    dot?: boolean;
  }) {
    this.#pattern = pattern;
    this.#dot = options?.dot ?? false;
    this.#re = new RegExp('^' + compileSegment(pattern) + '$');
    const segs = pattern.split('/');
    this.#segPatterns = segs.includes('**') ? null : segs.map((s) => new RegExp('^' + compileSegment(s) + '$'));
  }
  /**
  * Original pattern string.
  *
  * ```typescript no_run
  * const pattern = g.pattern;
  * ```
  */
  get pattern(): string {
    return this.#pattern;
  }
  /**
  * Return true when `path` matches the compiled pattern.
  *
  * Paths are matched with `/` separators. Hidden dot segments are rejected by
  * default unless enabled in the constructor options or matched explicitly.
  *
  * ```typescript no_run
  * const ok = g.test('src/index.ts');
  * ```
  */
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
  /**
  * Return true if a directory could contain matching entries.
  *
  * This is a pruning helper for patterns without `**`. Patterns with `**`
  * return true because any subtree may match.
  *
  * ```typescript no_run
  * const shouldDescend = g.couldMatch('src/internal');
  * ```
  */
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
/**
* Directory entry shape consumed and yielded by the glob walker.
*
* Providers adapt their concrete entries to this interface so glob traversal
* does not import the disk filesystem directly.
*
* ```typescript no_run
* import type { GlobEntry } from 'internal:file/glob';
* const entry: GlobEntry = {
*   name: 'file.txt',
*   path: '/tmp/file.txt',
*   isDirectory: () => false,
*   isFile: () => true,
*   isSymlink: () => false,
* };
* ```
*
* @internal
*/
export interface GlobEntry {
  /**
  * Basename of the entry within the listed directory.
  *
  * ```typescript no_run
  * const name = entry.name;
  * ```
  */
  name: string;
  /**
  * Provider-specific path object or string.
  *
  * The glob walker passes this through unchanged to consumers.
  *
  * ```typescript no_run
  * const path = entry.path;
  * ```
  */
  path: any;
  /**
  * Return true when this entry is a directory.
  *
  * ```typescript no_run
  * if (entry.isDirectory()) void entry.path;
  * ```
  */
  isDirectory(): boolean;
  /**
  * Return true when this entry is a regular file.
  *
  * ```typescript no_run
  * const file = entry.isFile();
  * ```
  */
  isFile(): boolean;
  /**
  * Return true when this entry is a symbolic link.
  *
  * ```typescript no_run
  * const link = entry.isSymlink();
  * ```
  */
  isSymlink(): boolean;
}
/**
* Async directory listing callback used by provider-specific globbing.
*
* The callback receives a path string and returns entries for that directory.
* Throwing from the callback causes the walker to skip that subtree.
*
* ```typescript no_run
* import type { ListDir } from 'internal:file/glob';
* const listDir: ListDir = async (_path) => [];
* ```
*
* @internal
*/
export type ListDir = (path: string) => Promise<GlobEntry[]>;
/**
* Options for provider-backed glob traversal.
*
* Defaults are `cwd: '.'`, `dot: false`, `onlyFiles: false`, and
* `onlyDirectories: false`.
*
* ```typescript no_run
* import type { GlobOptions } from 'internal:file/glob';
* const options: GlobOptions = { cwd: 'src', onlyFiles: true };
* ```
*
* @internal
*/
export interface GlobOptions {
  /**
  * Directory used as the traversal root.
  *
  * ```typescript no_run
  * import type { GlobOptions } from 'internal:file/glob';
  * const options: GlobOptions = { cwd: 'js' };
  * ```
  */
  cwd?: string;
  /**
  * Include dot-prefixed path segments when true.
  *
  * ```typescript no_run
  * import type { GlobOptions } from 'internal:file/glob';
  * const options: GlobOptions = { dot: true };
  * ```
  */
  dot?: boolean;
  /**
  * Yield only regular files when true.
  *
  * ```typescript no_run
  * import type { GlobOptions } from 'internal:file/glob';
  * const options: GlobOptions = { onlyFiles: true };
  * ```
  */
  onlyFiles?: boolean;
  /**
  * Yield only directories when true.
  *
  * ```typescript no_run
  * import type { GlobOptions } from 'internal:file/glob';
  * const options: GlobOptions = { onlyDirectories: true };
  * ```
  */
  onlyDirectories?: boolean;
  /**
  * Abort signal checked before directory reads and between entries.
  *
  * Aborting stops traversal without throwing to the iterator consumer.
  *
  * ```typescript no_run
  * const controller = new AbortController();
  * import type { GlobOptions } from 'internal:file/glob';
  * const options: GlobOptions = { signal: controller.signal };
  * ```
  */
  signal?: AbortSignal;
}
/**
* Walk the filesystem via `listDir`, yielding entries matching `pattern`.
*
* Uses a push-queue / pull-iterator pattern: a fire-and-forget async walk
* pushes results into a queue; the iterator's `next()` pulls from the queue
* or waits for the next push.
*
* Missing or unreadable subdirectories are skipped. The iterable finishes when
* traversal completes or the abort signal is observed.
*
* ```typescript no_run
* import { glob } from 'internal:file/glob';
* const listDir = async (_path: string) => [];
* for await (const entry of glob(listDir, '**\/*.ts', { onlyFiles: true })) {
*   void entry.name;
* }
* ```
*/
export function glob(listDir: ListDir, pattern: string, options: GlobOptions = {}): AsyncIterable<GlobEntry> {
  const dot = options.dot ?? false;
  const onlyFiles = options.onlyFiles ?? false;
  const onlyDirs = options.onlyDirectories ?? false;
  const signal = options.signal;
  const cwd = options.cwd ?? '.';
  const g = new Glob(pattern, { dot });
  // Find the longest fixed prefix to determine the start directory.
  const patSegs = pattern.split('/');
  let fixedCount = 0;
  for (const seg of patSegs) {
    if (/[*?{[]/.test(seg) || seg === '**') break;
    fixedCount++;
  }
  const relPrefix = patSegs.slice(0, fixedCount).join('/');
  const startDir = relPrefix ? cwd === '.' ? relPrefix : `${cwd}/${relPrefix}` : cwd;
  // Push-queue state
  const queue: GlobEntry[] = [];
  const waiters: Array<(r: IteratorResult<GlobEntry>) => void> = [];
  let isDone = false;
  function emit(entry: GlobEntry): void {
    if (waiters.length > 0) {
      waiters.shift()!({
        value: entry,
        done: false
      });
    } else {
      queue.push(entry);
    }
  }
  function finish(): void {
    isDone = true;
    for (const resolve of waiters) {
      resolve({
        value: undefined as any,
        done: true
      });
    }
    waiters.length = 0;
  }
  // Start the walk immediately (fire and forget).
  walkDir(listDir, startDir, relPrefix, g, dot, onlyFiles, onlyDirs, signal, emit).then(finish, finish);
  // Return an async iterable.
  return { [Symbol.asyncIterator]() {
    return { next(): Promise<IteratorResult<GlobEntry>> {
      if (queue.length > 0) {
        return Promise.resolve({
          value: queue.shift()!,
          done: false
        });
      }
      if (isDone) {
        return Promise.resolve({
          value: undefined as any,
          done: true
        });
      }
      return new Promise(function parkGlobNext(resolve) {
        waiters.push(resolve);
      });
    } };
  } };
}
async function walkDir(listDir: ListDir, dirPath: string, relDir: string, g: Glob, dot: boolean, onlyFiles: boolean, onlyDirs: boolean, signal: AbortSignal | undefined, emit: (entry: GlobEntry) => void): Promise<void> {
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
