---
weight: 37
---
# install

`fino install` resolves npm packages into `.fino/` and writes the package map
used by the module loader:

```sh
fino install
fino install semver
```

With package arguments, the command adds them to `package.json` before
installing. With no arguments, it installs dependencies already declared by the
current package.

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `packages...` | no | Package names or specifiers to add before installing. |

## Flags

| Flag | Value | Description |
| --- | --- | --- |
| none | no | `install` has no command-specific flags. |

The installer fetches npm packuments and tarballs, places package contents under
`.fino/packages`, and writes `.fino/package-map.json`. Bare package imports use
that package map at runtime.

## Reuse

Import the default task from `fino:commands/install` to reuse installer
behavior:

```ts no_run
import install from 'fino:commands/install';

await install.parse(['@scope/pkg@^1.2.0']);
```
