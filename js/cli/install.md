---
weight: 37
---
# install

`fino install` prepares npm dependencies for Fino's package-map loader. Use it
after editing dependencies in `package.json`, or pass packages on the command
line to add them and install in one step:

```sh
fino install
fino install semver
```

With package arguments, the command adds them to `package.json` before
installing. With no arguments, it installs dependencies already declared by the
current package. The result is local runtime state under `.fino/`, not a
`node_modules` tree.

## Command Reference

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `packages...` | argument | strings | no | Package names or specifiers to add before installing. |

The installer fetches npm packuments and tarballs, places package contents under
`.fino/packages`, and writes `.fino/package-map.json`. Bare package imports use
that package map at runtime.

Run `fino install` again whenever declared dependencies change so the package
map stays aligned with `package.json`.
