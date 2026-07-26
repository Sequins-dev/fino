/**
 * fino:file/path — POSIX path manipulation.
 *
 * Provides an immutable `Path` class and a set of module-level functions for
 * working with filesystem path strings. All operations are purely in-memory
 * string transformations — no filesystem access, no stat() calls. For actual
 * filesystem I/O, see `fino:file`.
 *
 * The separator and absolute-path rules are chosen once at startup from the
 * host platform (via `internal:process`). Fino runs on POSIX systems (macOS,
 * Linux), where the separator is `/` and backslashes are ordinary filename
 * characters — the Windows branches in this module are inert on POSIX hosts.
 *
 *
 * ## Immutability
 *
 * `Path` instances are immutable: `normalize()`, `join()`, `resolve()`, and
 * `relative()` all return new `Path` instances. The internal `#path` string
 * is never modified after construction. This makes Path objects safe to pass
 * around without defensive copies.
 *
 * `Path.from(input)` is a coercion helper: if the input is already a `Path`,
 * it returns it directly (no allocation). If it's a string, it wraps it in a
 * new `Path`. Use `Path.from()` in hot paths to avoid unnecessary wrapping.
 *
 *
 * ## Path normalization
 *
 * `normalize()` collapses repeated separators and resolves `.` and `..`
 * segments. Key behavior:
 *
 * - Empty string → `'.'` (current directory, like POSIX realpath)
 * - Leading slash is preserved (path stays absolute)
 * - Trailing slash is preserved (caller's intent to refer to a directory)
 * - `..` at the root of an absolute path is silently ignored (can't go above
 *   root)
 * - `..` at the start of a relative path is preserved (we can't resolve it
 *   without knowing the current directory)
 *
 *
 * ## Path resolution vs. joining
 *
 * `join(...segments)` concatenates segments with the separator and normalizes
 * the result. It does not produce absolute paths from relative ones.
 *
 * `resolve(...segments)` processes segments from right to left, stopping at
 * the first absolute segment. This mirrors Node.js `path.resolve` and POSIX
 * shell path building: `resolve('/a', 'b', '/c', 'd')` → `/c/d` (starts over
 * at `/c`).
 *
 * `relative(from, to)` computes a relative path from `from` to `to` by
 * finding the longest common prefix of normalized segments, then emitting
 * `..` for each diverging segment in `from` followed by the remaining
 * segments of `to`.
 *
 *
 * ## Module-level functions vs. Path methods
 *
 * Both exist for ergonomic reasons. The class methods operate on an existing
 * `Path` instance. The module-level functions accept `string|Path` and
 * delegate to the class, covering the common case where callers have raw
 * strings and don't want to construct a `Path` just to call one method.
 *
 *
 * ```ts no_run
 * import { Path, join, resolve, relative, dirname, basename } from 'fino:file/path';
 *
 * const p = new Path('/usr/local/bin');
 * p.dirname()       // Path('/usr/local')
 * p.basename()      // 'bin'
 * p.join('node')    // Path('/usr/local/bin/node')
 *
 * const rel = new Path('./src/../lib/index.mjs');
 * rel.normalize()   // Path('lib/index.mjs')
 * rel.extname()     // '.mjs'
 *
 * resolve('/home', 'user', 'docs')  // Path('/home/user/docs')
 * relative('/a/b', '/a/b/c/d')      // Path('c/d')
 * ```
 */
import { os } from 'internal:process';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SEP = os === 'windows' ? '\\' : '/';
const SEP_RE = os === 'windows' ? /[\\/]+/ : /\/+/;
const IS_ABS_RE = os === 'windows' ? /^(?:[a-zA-Z]:[\\/]|[\\/])/ : /^\//;
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Normalize a path string: collapse separators and resolve `.` / `..`.
 * Does NOT make a relative path absolute.
 */
function _normalize(p: string): string {
  if (p.length === 0) return '.';
  const isAbsolute = IS_ABS_RE.test(p);
  const trailingSlash = p.endsWith('/') || (os === 'windows' && p.endsWith('\\'));
  const segments = p.split(SEP_RE);
  const out = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (!isAbsolute) {
        out.push('..');
      }
    } else {
      out.push(seg);
    }
  }
  let result = out.join(SEP);
  if (isAbsolute) result = SEP + result;
  if (trailingSlash && result !== SEP) result += SEP;
  if (result === '') return '.';
  return result;
}
/**
 * Join path segments with the platform separator.
 */
function _join(parts: (string | Path)[]): string {
  if (parts.length === 0) return '.';
  let joined = '';
  for (const part of parts) {
    const s = typeof part === 'string' ? part : part.toString();
    if (s.length === 0) continue;
    if (joined.length === 0) {
      joined = s;
    } else {
      joined += SEP + s;
    }
  }
  if (joined.length === 0) return '.';
  return _normalize(joined);
}
/**
 * Resolve a sequence of paths into an absolute path, processing from right
 * to left until an absolute path is found.
 */
function _resolve(parts: (string | Path)[]): string {
  let resolved = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part === undefined) continue;
    const s = typeof part === 'string' ? part : part.toString();
    if (s.length === 0) continue;
    resolved = resolved.length === 0 ? s : s + SEP + resolved;
    if (IS_ABS_RE.test(s)) break;
  }
  return _normalize(resolved);
}
// ---------------------------------------------------------------------------
// Path class
// ---------------------------------------------------------------------------
/**
 * An immutable representation of a filesystem path. All mutation methods
 * return new Path instances.
 *
 * Constructor accepts a string or another Path. Use `Path.from()` for
 * coercion that passes Path instances through without allocating.
 *
 * Paths are normalized only when a method such as `normalize()`, `join()`, or
 * `resolve()` asks for normalization. Constructing a `Path` preserves the raw
 * input string, including relative segments and repeated separators.
 *
 * ```ts no_run
 * import { Path } from 'fino:file/path';
 *
 * const source = new Path('./src/../src/main.ts');
 * const normalized = source.normalize();
 * console.log(source.toString());      // ./src/../src/main.ts
 * console.log(normalized.toString());  // src/main.ts
 * ```
 */
export class Path {
  /**
   * The raw path string exactly as supplied at construction. Never mutated;
   * every manipulation method builds a new `Path` around a new string.
   *
   * @internal
   */
  #path: string;
  /**
   * Create a path wrapper from a raw path string or another `Path`.
   *
   * The constructor does not touch the filesystem and does not normalize the
   * input. Passing another `Path` copies its stored string. Use `Path.from()`
   * when you want to avoid allocating a new wrapper for existing `Path`
   * instances.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * const raw = new Path('/tmp//cache');
   * const copy = new Path(raw);
   * console.log(copy.toString()); // /tmp//cache
   * ```
   */
  constructor(input: string | Path) {
    if (input instanceof Path) {
      this.#path = input.#path;
    } else {
      this.#path = String(input);
    }
  }
  // -------------------------------------------------------------------------
  // Coercion
  // -------------------------------------------------------------------------
  /**
   * Convert a string or Path to a Path. If the input is already a Path,
   * returns it directly (no copy).
   *
   * This is useful for APIs that accept `string | Path` and want a stable
   * object form. The returned object preserves the raw input string and may be
   * the same object that was passed in.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * const existing = new Path('/var/log');
   * console.log(Path.from(existing) === existing); // true
   * console.log(Path.from('tmp').join('out').toString()); // tmp/out
   * ```
   */
  static from(input: string | Path): Path {
    if (input instanceof Path) return input;
    return new Path(input);
  }
  // -------------------------------------------------------------------------
  // Component extraction
  // -------------------------------------------------------------------------
  /**
   * Return the directory portion of the path (everything before the last
   * separator). Equivalent to POSIX `dirname`.
   *
   * The result is a new `Path`. Relative paths with no separator return `.`.
   * Trailing separators are ignored except when the path is the root
   * separator.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * console.log(new Path('/usr/local/bin/').dirname().toString()); // /usr/local
   * console.log(new Path('README.md').dirname().toString()); // .
   * ```
   */
  dirname(): Path {
    const p = this.#path;
    // Strip trailing slashes (but not if path is just '/')
    let end = p.length;
    while (end > 1 && (p[end - 1] === '/' || (os === 'windows' && p[end - 1] === '\\'))) {
      end--;
    }
    const idx = Math.max(
      p.lastIndexOf('/', end - 1),
      os === 'windows' ? p.lastIndexOf('\\', end - 1) : -1,
    );
    if (idx < 0) return new Path('.');
    if (idx === 0) return new Path(SEP);
    return new Path(p.slice(0, idx));
  }
  /**
   * Return the final component of the path. If `suffix` is provided and
   * matches the end of the basename, it is removed.
   *
   * The method performs string manipulation only. It strips trailing
   * separators before finding the final component, and it removes `suffix`
   * only when the full basename ends with that exact string. The root path
   * `/` returns an empty string.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * console.log(new Path('/tmp/archive.tar.gz').basename('.gz')); // archive.tar
   * console.log(new Path('/tmp/build/').basename()); // build
   * ```
   */
  basename(suffix?: string): string {
    let p = this.#path;
    // Strip trailing slashes
    while (p.length > 1 && (p.endsWith('/') || (os === 'windows' && p.endsWith('\\')))) {
      p = p.slice(0, -1);
    }
    const idx = Math.max(p.lastIndexOf('/'), os === 'windows' ? p.lastIndexOf('\\') : -1);
    let base = idx >= 0 ? p.slice(idx + 1) : p;
    if (suffix && base.endsWith(suffix)) {
      base = base.slice(0, base.length - suffix.length);
    }
    return base;
  }
  /**
   * Return the file extension (including the leading dot), or an empty
   * string if there is none.
   *
   * Leading-dot names such as `.env` are treated as having no extension.
   * Compound extensions are not special-cased; only the substring after the
   * final dot is returned.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * console.log(new Path('server.test.ts').extname()); // .ts
   * console.log(new Path('.env').extname()); // ''
   * ```
   */
  extname(): string {
    const base = this.basename();
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return '';
    return base.slice(dot);
  }
  // -------------------------------------------------------------------------
  // Predicates
  // -------------------------------------------------------------------------
  /**
   * True if the path is absolute.
   *
   * On POSIX, an absolute path starts with `/`. The check does not verify that
   * the path exists.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * console.log(new Path('/tmp').isAbsolute()); // true
   * console.log(new Path('./tmp').isAbsolute()); // false
   * ```
   */
  isAbsolute(): boolean {
    return IS_ABS_RE.test(this.#path);
  }
  // -------------------------------------------------------------------------
  // Manipulation
  // -------------------------------------------------------------------------
  /**
   * Return a normalized version of this path: collapse multiple separators,
   * resolve `.` and `..` segments.
   *
   * Normalization is lexical. It does not resolve symlinks, inspect the
   * filesystem, or make relative paths absolute. A trailing separator is
   * preserved when present.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * const path = new Path('/tmp//cache/../logs/');
   * console.log(path.normalize().toString()); // /tmp/logs/
   * ```
   */
  normalize(): Path {
    return new Path(_normalize(this.#path));
  }
  /**
   * Join this path with one or more additional segments.
   *
   * Segments are concatenated with the platform separator and normalized. Empty
   * segments are ignored. Absolute later segments are not treated as a reset;
   * use `resolve()` for right-to-left absolute path resolution.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * const output = new Path('/tmp').join('build', '..', 'dist/app.js');
   * console.log(output.toString()); // /tmp/dist/app.js
   * ```
   */
  join(...segments: (string | Path)[]): Path {
    return new Path(_join([this.#path, ...segments]));
  }
  /**
   * Resolve this path against one or more base paths, producing an absolute
   * path. Processes from right to left; the first absolute path wins.
   *
   * Bases are listed outermost first: the leftmost base is consulted only when
   * nothing to its right is absolute. If no segment is absolute at all, the
   * result stays relative.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * const path = new Path('app.js').resolve('/srv/www', 'assets');
   * console.log(path.toString()); // /srv/www/assets/app.js
   * ```
   */
  resolve(...bases: (string | Path)[]): Path {
    return new Path(_resolve([...bases, this.#path]));
  }
  /**
   * Return a relative path from `from` to this path.
   * Both paths are normalized before computing the relation.
   *
   * The calculation is lexical and does not verify either path. When both
   * normalized paths are the same, the result is `.`.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * const target = new Path('/repo/src/app.ts');
   * console.log(target.relative('/repo/tests').toString()); // ../src/app.ts
   * ```
   */
  relative(from: string | Path): Path {
    const fromParts = _normalize(String(from)).split(SEP_RE).filter(Boolean);
    const toParts = _normalize(this.#path).split(SEP_RE).filter(Boolean);
    // Find the common prefix length.
    let common = 0;
    const len = Math.min(fromParts.length, toParts.length);
    while (common < len && fromParts[common] === toParts[common]) {
      common++;
    }
    const ups = fromParts.length - common;
    const tail = toParts.slice(common);
    const parts = [];
    for (let i = 0; i < ups; i++) parts.push('..');
    parts.push(...tail);
    return new Path(parts.length === 0 ? '.' : parts.join(SEP));
  }
  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------
  /**
   * Return the raw stored path string.
   *
   * This does not normalize or resolve the path, so it may include repeated
   * separators, `.` segments, or `..` segments exactly as supplied.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * console.log(new Path('./a/../b').toString()); // ./a/../b
   * ```
   */
  toString(): string {
    return this.#path;
  }
  /**
   * Serialize the path as its raw string for `JSON.stringify()`.
   *
   * The returned value matches `toString()` and is not normalized.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * console.log(JSON.stringify({ file: new Path('src/main.ts') }));
   * ```
   */
  toJSON(): string {
    return this.#path;
  }
  /**
   * Convert the path to a primitive string for template literals and coercion.
   *
   * This hook returns the same raw value as `toString()`.
   *
   * ```ts no_run
   * import { Path } from 'fino:file/path';
   *
   * const path = new Path('/tmp/file.txt');
   * console.log(`${path}`);
   * ```
   */
  [Symbol.toPrimitive](): string {
    return this.#path;
  }
}
// ---------------------------------------------------------------------------
// Module-level convenience functions
// ---------------------------------------------------------------------------
/**
 * Join path segments.
 *
 * This is the module-level form of `Path#join()`. It ignores empty segments,
 * joins the remaining segments with the platform separator, and normalizes the
 * result. With no usable segments, it returns `Path('.')`.
 *
 * ```ts no_run
 * import { join } from 'fino:file/path';
 *
 * console.log(join('src', '..', 'dist', 'app.js').toString()); // dist/app.js
 * ```
 */
export function join(...segments: (string | Path)[]): Path {
  return new Path(_join(segments));
}
/**
 * Resolve a sequence of paths into an absolute path.
 *
 * Segments are processed from right to left until an absolute segment is
 * found, then the result is normalized. If no absolute segment is present, the
 * returned path remains relative.
 *
 * ```ts no_run
 * import { resolve } from 'fino:file/path';
 *
 * console.log(resolve('/srv', 'app', '/tmp', 'file.txt').toString()); // /tmp/file.txt
 * ```
 */
export function resolve(...segments: (string | Path)[]): Path {
  return new Path(_resolve(segments));
}
/**
 * Normalize a path string.
 *
 * This is a lexical operation. It collapses repeated separators and resolves
 * `.` and `..` segments without inspecting the filesystem or resolving
 * symlinks.
 *
 * ```ts no_run
 * import { normalize } from 'fino:file/path';
 *
 * console.log(normalize('/tmp//a/../b').toString()); // /tmp/b
 * ```
 */
export function normalize(p: string | Path): Path {
  return new Path(_normalize(String(p)));
}
/**
 * Return the directory name of a path.
 *
 * The input is coerced with `Path.from()` and handled like `Path#dirname()`.
 * Relative paths with no separator return `Path('.')`.
 *
 * ```ts no_run
 * import { dirname } from 'fino:file/path';
 *
 * console.log(dirname('/var/log/system.log').toString()); // /var/log
 * ```
 */
export function dirname(p: string | Path): Path {
  return Path.from(p).dirname();
}
/**
 * Return the basename of a path, optionally stripping a suffix.
 *
 * Trailing separators are ignored. The suffix is removed only when it exactly
 * matches the end of the final path component.
 *
 * ```ts no_run
 * import { basename } from 'fino:file/path';
 *
 * console.log(basename('/tmp/report.csv', '.csv')); // report
 * ```
 */
export function basename(p: string | Path, suffix?: string): string {
  return Path.from(p).basename(suffix);
}
/**
 * Return the extension of a path.
 *
 * The extension includes the leading dot. Names without a dot, and leading-dot
 * names such as `.env`, return an empty string.
 *
 * ```ts no_run
 * import { extname } from 'fino:file/path';
 *
 * console.log(extname('server.test.ts')); // .ts
 * ```
 */
export function extname(p: string | Path): string {
  return Path.from(p).extname();
}
/**
 * Check if a path is absolute.
 *
 * This is a string predicate only and does not check whether the path exists.
 *
 * ```ts no_run
 * import { isAbsolute } from 'fino:file/path';
 *
 * console.log(isAbsolute('/tmp')); // true
 * ```
 */
export function isAbsolute(p: string | Path): boolean {
  return Path.from(p).isAbsolute();
}
/**
 * Compute a relative path from `from` to `to`.
 *
 * Both paths are normalized before comparison. The calculation is lexical and
 * does not access the filesystem. When both paths normalize to the same
 * location, the result is `Path('.')`.
 *
 * ```ts no_run
 * import { relative } from 'fino:file/path';
 *
 * console.log(relative('/repo/docs', '/repo/src/app.ts').toString()); // ../src/app.ts
 * ```
 */
export function relative(from: string | Path, to: string | Path): Path {
  return Path.from(to).relative(from);
}
/**
 * Platform path separator used by this module.
 *
 * Fino currently runs on POSIX hosts, so this is usually `/`. Code that formats
 * user-visible paths can import this constant instead of hard-coding a
 * separator.
 *
 * ```ts no_run
 * import { sep } from 'fino:file/path';
 *
 * console.log(['tmp', 'cache'].join(sep));
 * ```
 */
export const sep = SEP;
