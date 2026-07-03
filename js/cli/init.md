---
weight: 36
---
# Init Command

`fino init` creates a `package.json` in the current working directory:

```sh
fino init --yes
```

Set fields explicitly when defaults are not enough:

```sh
fino init \
  --name my-app \
  --version 0.1.0 \
  --license MIT
```

The command defaults `type` to `module`, derives the package name from the
directory, and can read author/repository defaults from Git configuration when
available. `--force` replaces an existing package file:

```sh
fino init --yes --force
```

Import the default task from `fino:commands/init` to reuse the initializer.
