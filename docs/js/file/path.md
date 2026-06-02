# path

fino:path — POSIX path manipulation.

Provides an immutable `Path` class and a set of module-level functions for
working with filesystem path strings. All operations are purely in-memory
string transformations — no filesystem access, no stat() calls. For actual
filesystem I/O, see `fino:file`.

The module supports POSIX paths (macOS, Linux) by default and has minimal
Windows stubs (the separator constants and `isAbsolute` regex detect Windows
paths), though Fino itself only runs on POSIX systems today.

## Immutability

`Path` instances are immutable: `normalize()`, `join()`, `resolve()`, and
`relative()` all return new `Path` instances. The internal `#path` string
is never modified after construction. This makes Path objects safe to pass
around without defensive copies.

`Path.from(input)` is a coercion helper: if the input is already a `Path`,
it returns it directly (no allocation). If it's a string, it wraps it in a
new `Path`. Use `Path.from()` in hot paths to avoid unnecessary wrapping.

## Path normalization

`_normalize(p)` collapses repeated separators and resolves `.` and `..`
segments. Key behavior:

- Empty string → `'.'` (current directory, like POSIX realpath)
- Leading slash is preserved (path stays absolute)
- Trailing slash is preserved (caller's intent to refer to a directory)
- `..` at the root of an absolute path is silently ignored (can't go above
  root)
- `..` at the start of a relative path is preserved (we can't resolve it
  without knowing the current directory)

## Path resolution vs. joining

`join(...segments)` concatenates segments with the separator and normalizes
the result. It does not produce absolute paths from relative ones.

`resolve(...segments)` processes segments from right to left, stopping at
the first absolute segment. This mirrors Node.js `path.resolve` and POSIX
shell path building: `resolve('/a', 'b', '/c', 'd')` → `/c/d` (starts over
at `/c`).

`relative(from, to)` computes a relative path from `from` to `to` by
finding the longest common prefix of normalized segments, then emitting
`..` for each diverging segment in `from` followed by the remaining
segments of `to`.

## Module-level functions vs. Path methods

Both exist for ergonomic reasons. The class methods operate on an existing
`Path` instance. The module-level functions accept `string|Path` and
delegate to the class, covering the common case where callers have raw
strings and don't want to construct a `Path` just to call one method.

```ts
import { Path, join, resolve, relative, dirname, basename } from './path.mts';

const p = new Path('/usr/local/bin');
p.dirname()       // Path('/usr/local')
p.basename()      // 'bin'
p.join('node')    // Path('/usr/local/bin/node')

const rel = new Path('./src/../lib/index.mjs');
rel.normalize()   // Path('lib/index.mjs')
rel.extname()     // '.mjs'

resolve('/home', 'user', 'docs')  // Path('/home/user/docs')
relative('/a/b', '/a/b/c/d')      // Path('c/d')
```

## Path

```ts
class Path {
```

An immutable representation of a filesystem path. All mutation methods
return new Path instances.

Constructor accepts a string or another Path. Use `Path.from()` for
coercion that passes Path instances through without allocating.

### constructor

```ts
constructor(input: string | Path)
```

### from

```ts
static from(input: string | Path): Path
```

Convert a string or Path to a Path. If the input is already a Path,
returns it directly (no copy).

### dirname

```ts
dirname(): Path
```

Return the directory portion of the path (everything before the last
separator). Equivalent to POSIX `dirname`.

### basename

```ts
basename(suffix?: string): string
```

Return the final component of the path. If `suffix` is provided and
matches the end of the basename, it is removed.

### extname

```ts
extname(): string
```

Return the file extension (including the leading dot), or an empty
string if there is none.

### isAbsolute

```ts
isAbsolute(): boolean
```

True if the path is absolute.

### normalize

```ts
normalize(): Path
```

Return a normalized version of this path: collapse multiple separators,
resolve `.` and `..` segments.

### join

```ts
join(...segments: (string | Path)[]): Path
```

Join this path with one or more additional segments.

### resolve

```ts
resolve(...bases: (string | Path)[]): Path
```

Resolve this path against one or more base paths, producing an absolute
path. Processes from right to left; the first absolute path wins.

If no segments produce an absolute path, the result is relative.

### relative

```ts
relative(from: string | Path): Path
```

Return a relative path from `from` to this path.
Both paths are normalized before computing the relation.

### toString

```ts
toString(): string
```

Return the raw path string.

### toJSON

```ts
toJSON(): string
```

JSON serialization returns the path string.

## join

```ts
function join(...segments: (string | Path)[]): Path
```

Join path segments.

## resolve

```ts
function resolve(...segments: (string | Path)[]): Path
```

Resolve a sequence of paths into an absolute path.

## normalize

```ts
function normalize(p: string | Path): Path
```

Normalize a path string.

## dirname

```ts
function dirname(p: string | Path): Path
```

Return the directory name of a path.

## basename

```ts
function basename(p: string | Path, suffix?: string): string
```

Return the basename of a path, optionally stripping a suffix.

## extname

```ts
function extname(p: string | Path): string
```

Return the extension of a path.

## isAbsolute

```ts
function isAbsolute(p: string | Path): boolean
```

Check if a path is absolute.

## relative

```ts
function relative(from: string | Path, to: string | Path): Path
```

Compute a relative path from `from` to `to`.

## sep

```ts
const sep
```

Platform path separator.
