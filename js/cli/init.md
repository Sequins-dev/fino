---
weight: 36
---
# init

`fino init` creates a `package.json` in the current working directory:

```sh
fino init --yes
```

The command writes `name`, `version`, `type`, `description`, `license`,
`author`, and `repository`. `type` is always `module`. Defaults come from the
directory name and Git configuration when available.

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| none | no | `init` does not accept positional arguments. |

## Flags

| Flag | Value | Description |
| --- | --- | --- |
| `--name` | string | Package name. Defaults to the current directory name. |
| `--version` | string | Package version. Defaults to `1.0.0`. |
| `--description` | string | Package description. Defaults to an empty string. |
| `--license` | string | Package license. Defaults to `MIT`. |
| `--author` | string | Package author. Defaults from `git config user.name` and `user.email` when available. |
| `--repository` | string | Package repository URL. Defaults from `git config remote.origin.url` when available. |
| `--yes`, `-y` | boolean | Accept defaults for promptable values. |
| `--force`, `-f` | boolean | Replace an existing `package.json`. |

Package names must be lowercase and may include numbers, dots, underscores,
hyphens, and an optional npm scope. Existing package files are preserved unless
`--force` is provided.

## Reuse

Import the default task from `fino:commands/init` to reuse the initializer:

```ts no_run
import init from 'fino:commands/init';

await init.parse(['--yes', '--name', 'fino-app']);
```
