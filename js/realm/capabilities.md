---
weight: 15
---
# Import Capabilities

Every import a child realm makes is evaluated against an ordered rule list. Rules come from two sources: the parent's own rules (which the child inherits), and child-specific overrides supplied at construction time. The child's overrides are appended after the parent's, so they can narrow permissions but cannot escalate past what the parent already allows.

## Building an import map

`ImportMap.deny()` starts from a block-all baseline and opens specific exceptions:

```ts
import { Realm, ImportMap } from 'fino:realm';

const realm = new Realm({
  entry: './worker.ts',
  overrides: ImportMap.deny([
    { pattern: 'fino:file/path', directive: 'inherit' },
    { pattern: 'fino:context',   directive: 'inherit' },
  ]),
});
```

This child can import `fino:file/path` and `fino:context`. Every other specifier is blocked, including all other `fino:*` modules.

`ImportMap.inherit()` starts from an inherit-all baseline and blocks specifics:

```ts
const realm = new Realm({
  entry: './worker.ts',
  overrides: ImportMap.inherit([
    { pattern: 'fino:process', directive: 'block' },
  ]),
});
```

This child inherits everything the parent can import, except `fino:process`.

Use `deny` when you want a tight allowlist — the child gets only what you explicitly permit. Use `inherit` when the child is trusted and you only need to remove a few capabilities.

## Rule evaluation — last match wins

Rules are evaluated in order and the last matching rule determines the outcome. Put your broad baseline first and specific overrides after it:

```ts
ImportMap.inherit([
  { pattern: 'fino:*',   directive: 'block' },    // block all fino: modules...
  { pattern: 'fino:ffi', directive: 'inherit' },  // ...except ffi (last match wins)
])
```

If you reverse the order, the broad block would apply last and win over the specific inherit.

`ImportMap.deny(overrides)` is equivalent to `new ImportMap([{ pattern: '*', directive: 'block' }, ...overrides])`. `ImportMap.inherit(overrides)` is equivalent to `new ImportMap([{ pattern: '*', directive: 'inherit' }, ...overrides])`. You can construct an `ImportMap` directly when you need precise control over the rule list.

## Directives

The `directive` field in each rule is one of:

- `'inherit'` — fall back to the parent's rule for this specifier. The effective behavior depends on whatever the parent allows.
- `'block'` — reject the import with a module-not-found error.
- `{ type: 'remap', target: string }` — resolve the import as if the child had imported `target` instead. Useful for aliasing a virtual specifier to a real module.
- `{ type: 'source', code: string, source_map: string }` — inject an in-memory module with the given source text as the result of the import.
- A `Facade` instance — expose a parent-backed virtual module. The runtime normalizes the facade to its wire directive automatically.

## Per-importer targeting with `from`

Each rule has an optional `from` field. When present, the rule only applies when the module initiating the import matches the `from` pattern:

```ts
// Block fino:fs only when imported from a specific module
{ from: 'internal:plugin-host', pattern: 'fino:fs', directive: 'block' }
```

Without `from`, the rule applies regardless of which module is doing the importing. The `from` field accepts the same pattern syntax as `pattern`, including `*` and prefix patterns.

## Capability narrowing

The runtime enforces that children cannot escalate past what the parent allows. If the parent has blocked a specifier, the child's override list cannot grant access to it — construction throws:

```ts
// Throws at construction if internal:* is blocked in the parent
new Realm({
  overrides: ImportMap.deny([
    { pattern: 'internal:*', directive: { type: 'remap', target: 'internal:realm-native' } },
  ]),
  entry: './worker.ts',
});
```

This is enforced by the Rust-side loader before the child realm is created. There is no way for a JS-level rule to bypass it.

## Import inheritance

Child realms inherit the parent's import rules by default. You do not need to
re-declare filesystem or network facades in every child: the parent's rules flow
down unless the child's import map narrows or replaces them.
