/**
 * boats:path — POSIX path manipulation.
 *
 * Provides an immutable `Path` class and a set of module-level functions for
 * working with filesystem path strings. All operations are purely in-memory
 * string transformations — no filesystem access, no stat() calls. For actual
 * filesystem I/O, see `boats:file`.
 *
 * The module supports POSIX paths (macOS, Linux) by default and has minimal
 * Windows stubs (the separator constants and `isAbsolute` regex detect Windows
 * paths), though Boats itself only runs on POSIX systems today.
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
 * `_normalize(p)` collapses repeated separators and resolves `.` and `..`
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
 * @example
 * import { Path, join, resolve, relative, dirname, basename } from 'boats:file/path';
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
    const s = typeof parts[i] === 'string' ? parts[i] : parts[i].toString();
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
 */
export class Path {
  #path: string;

  /**
   * @param input  Raw path string or another Path.
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
   * @param {string|Path} input
   * @returns {Path}
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
   * @returns {Path}
   */
  dirname(): Path {
    const p = this.#path;
    // Strip trailing slashes (but not if path is just '/')
    let end = p.length;
    while (end > 1 && (p[end - 1] === '/' || (os === 'windows' && p[end - 1] === '\\'))) {
      end--;
    }
    const idx = Math.max(p.lastIndexOf('/', end - 1),
                         os === 'windows' ? p.lastIndexOf('\\', end - 1) : -1);
    if (idx < 0) return new Path('.');
    if (idx === 0) return new Path(SEP);
    return new Path(p.slice(0, idx));
  }

  /**
   * Return the final component of the path. If `suffix` is provided and
   * matches the end of the basename, it is removed.
   * @param {string} [suffix]
   * @returns {string}
   */
  basename(suffix?: string): string {
    let p = this.#path;
    // Strip trailing slashes
    while (p.length > 1 && (p.endsWith('/') || (os === 'windows' && p.endsWith('\\')))) {
      p = p.slice(0, -1);
    }
    const idx = Math.max(p.lastIndexOf('/'),
                         os === 'windows' ? p.lastIndexOf('\\') : -1);
    let base = idx >= 0 ? p.slice(idx + 1) : p;
    if (suffix && base.endsWith(suffix)) {
      base = base.slice(0, base.length - suffix.length);
    }
    return base;
  }

  /**
   * Return the file extension (including the leading dot), or an empty
   * string if there is none.
   * @returns {string}
   */
  extname(): string {
    const base = this.basename();
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return '';  // no dot, or leading dot (hidden file)
    return base.slice(dot);
  }

  // -------------------------------------------------------------------------
  // Predicates
  // -------------------------------------------------------------------------

  /**
   * True if the path is absolute.
   * @returns {boolean}
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
   * @returns {Path}
   */
  normalize(): Path {
    return new Path(_normalize(this.#path));
  }

  /**
   * Join this path with one or more additional segments.
   * @param {...(string|Path)} segments
   * @returns {Path}
   */
  join(...segments: (string | Path)[]): Path {
    return new Path(_join([this.#path, ...segments]));
  }

  /**
   * Resolve this path against one or more base paths, producing an absolute
   * path. Processes from right to left; the first absolute path wins.
   *
   * If no segments produce an absolute path, the result is relative.
   *
   * @param {...(string|Path)} bases  Base paths (leftmost = most significant).
   * @returns {Path}
   */
  resolve(...bases: (string | Path)[]): Path {
    return new Path(_resolve([...bases, this.#path]));
  }

  /**
   * Return a relative path from `from` to this path.
   * Both paths are normalized before computing the relation.
   * @param {string|Path} from
   * @returns {Path}
   */
  relative(from: string | Path): Path {
    const fromParts = _normalize(String(from)).split(SEP_RE).filter(Boolean);
    const toParts   = _normalize(this.#path).split(SEP_RE).filter(Boolean);

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

  /** Return the raw path string. */
  toString(): string { return this.#path; }

  /** JSON serialization returns the path string. */
  toJSON(): string { return this.#path; }

  /** Template literal support. */
  [Symbol.toPrimitive](): string { return this.#path; }
}

// ---------------------------------------------------------------------------
// Module-level convenience functions
// ---------------------------------------------------------------------------

/**
 * Join path segments.
 * @param {...(string|Path)} segments
 * @returns {Path}
 */
export function join(...segments: (string | Path)[]): Path {
  return new Path(_join(segments));
}

/**
 * Resolve a sequence of paths into an absolute path.
 * @param {...(string|Path)} segments
 * @returns {Path}
 */
export function resolve(...segments: (string | Path)[]): Path {
  return new Path(_resolve(segments));
}

/**
 * Normalize a path string.
 * @param {string|Path} p
 * @returns {Path}
 */
export function normalize(p: string | Path): Path {
  return new Path(_normalize(String(p)));
}

/**
 * Return the directory name of a path.
 */
export function dirname(p: string | Path): Path {
  return Path.from(p).dirname();
}

/**
 * Return the basename of a path, optionally stripping a suffix.
 */
export function basename(p: string | Path, suffix?: string): string {
  return Path.from(p).basename(suffix);
}

/**
 * Return the extension of a path.
 */
export function extname(p: string | Path): string {
  return Path.from(p).extname();
}

/**
 * Check if a path is absolute.
 */
export function isAbsolute(p: string | Path): boolean {
  return Path.from(p).isAbsolute();
}

/**
 * Compute a relative path from `from` to `to`.
 */
export function relative(from: string | Path, to: string | Path): Path {
  return Path.from(to).relative(from);
}

/** Platform path separator. */
export const sep = SEP;
