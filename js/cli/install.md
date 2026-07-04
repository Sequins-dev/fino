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

## Command Reference

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `packages...` | argument | strings | no | Package names or specifiers to add before installing. |

The installer fetches npm packuments and tarballs, places package contents under
`.fino/packages`, and writes `.fino/package-map.json`. Bare package imports use
that package map at runtime.

