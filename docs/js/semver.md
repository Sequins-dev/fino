# semver

fino:semver — semantic version parsing, comparison, and range matching.

Implements the SemVer 2.0.0 precedence rules plus the npm-style range forms
used by the Fino package installer: comparators, hyphen ranges, wildcards,
tilde ranges, caret ranges, and `||` disjunctions. Build metadata is parsed
and preserved but ignored for precedence comparisons.

## parse

```ts
function parse(version: string): SemVer
```

Parse a version string and return its structured components.

```ts
import { parse } from 'fino:semver';

parse('1.2.3-beta.1+build.5').prerelease; // ['beta', 1]
```

## valid

```ts
function valid(version: string): string | null
```

Return the normalized version string, or `null` when the input is invalid.

## compare

```ts
function compare(a: string, b: string): number
```

Compare two versions using SemVer precedence.

Returns a negative number when `a < b`, zero when they are equal, and a
positive number when `a > b`.

## satisfies

```ts
function satisfies(version: string, range: string | null | undefined): boolean
```

Test whether a version satisfies a range expression.

```ts
import { satisfies } from 'fino:semver';

satisfies('1.4.2', '^1.2.0'); // true
satisfies('2.0.0', '^1.2.0'); // false
```

## maxSatisfying

```ts
function maxSatisfying(versions: string[], range: string | null | undefined): string | null
```

Return the highest version in `versions` that satisfies `range`.

## validRange

```ts
function validRange(range: string | null | undefined): string | null
```

Validate a range expression and return its trimmed form, or `null`.
