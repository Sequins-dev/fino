---
weight: 37
---
# Install Command

`fino install` resolves npm packages into `.fino/` and writes the package map
used by the module loader:

```sh
fino install
fino install semver
```

With package arguments, the command adds them to `package.json` before
installing. With no arguments, it installs the dependencies already declared by
the current package.

The installer fetches npm packuments and tarballs, places package contents under
`.fino/packages`, and writes `.fino/package-map.json`. Bare package imports use
that package map at runtime.

Import the default task from `fino:commands/install` to reuse installer
behavior.
