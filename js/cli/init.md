---
weight: 36
---
# init

`fino init` creates a minimal `package.json` for a Fino project. Use it when
starting a new package or when turning a script directory into a package that
can declare dependencies for `fino install` and bare package imports:

```sh
fino init --yes
```

The command writes `name`, `version`, `type`, `description`, `license`,
`author`, and `repository`. `type` is always `module`. Defaults come from the
directory name and Git configuration when available. In an interactive context,
unset fields can be prompted; `--yes` accepts defaults without prompting.

## Command Reference

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `--name` | flag | string | no | Package name. Defaults to the current directory name. |
| `--version` | flag | string | no | Package version. Defaults to `1.0.0`. |
| `--description` | flag | string | no | Package description. Defaults to an empty string. |
| `--license` | flag | string | no | Package license. Defaults to `MIT`. |
| `--author` | flag | string | no | Package author. Defaults from `git config user.name` and `user.email` when available. |
| `--repository` | flag | string | no | Package repository URL. Defaults from `git config remote.origin.url` when available. |
| `--yes`, `-y` | flag | boolean | no | Accept defaults for promptable values. |
| `--force`, `-f` | flag | boolean | no | Replace an existing `package.json`. |

Package names must be lowercase and may include numbers, dots, underscores,
hyphens, and an optional npm scope. Existing package files are preserved unless
`--force` is provided.

Use explicit flags for repeatable project scaffolding:

```sh
fino init --yes --name api-service --license MIT
```
