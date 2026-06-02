# semver

fino:semver — semantic version parsing, comparison, and range matching.

Implements the SemVer 2.0.0 precedence rules plus the npm-style range forms
used by the Fino package installer: comparators, hyphen ranges, wildcards,
tilde ranges, caret ranges, and `||` disjunctions. Build metadata is parsed
and preserved but ignored for precedence comparisons.

```ts
import { parse, satisfies, maxSatisfying } from 'fino:semver';

const version = parse('1.2.3-beta.1+build.5');
const ok = satisfies(version.version, '^1.0.0');
const selected = maxSatisfying(['1.0.0', '1.4.0', '2.0.0'], '^1');
```

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

This is the non-throwing companion to `parse()`. It trims input, validates
strict SemVer syntax, normalizes prerelease numeric identifiers, and returns
`null` instead of raising when the string is not a version.

```ts
import { valid } from 'fino:semver';

valid('1.2.3+build.5'); // '1.2.3+build.5'
valid('01.2.3');        // null
```

## compare

```ts
function compare(a: string, b: string): number
```

Compare two versions using SemVer precedence.

Returns a negative number when `a < b`, zero when they are equal, and a
positive number when `a > b`.

Build metadata is ignored by SemVer precedence, so `1.0.0+one` and
`1.0.0+two` compare as equal. Invalid inputs throw.

```ts
import { compare } from 'fino:semver';

compare('1.0.0-alpha', '1.0.0'); // negative
compare('2.0.0', '1.9.9');       // positive
```

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

Invalid versions or ranges throw because this helper delegates to
`satisfies()` and `compare()`. The returned string is the original matching
entry from `versions`, not a normalized copy.

```ts
import { maxSatisfying } from 'fino:semver';

maxSatisfying(['1.0.0', '1.5.0', '2.0.0'], '^1.0.0'); // '1.5.0'
```

## validRange

```ts
function validRange(range: string | null | undefined): string | null
```

Validate a range expression and return its trimmed form, or `null`.

Empty ranges, `*`, and `latest` are accepted as wildcard ranges. Other
ranges may use comparators, wildcards, tilde, caret, hyphen ranges, and `||`
disjunctions. The return value is suitable for display or reuse.

```ts
import { validRange } from 'fino:semver';

validRange(' ^1.2.3 '); // '^1.2.3'
validRange('bad range'); // null
```
