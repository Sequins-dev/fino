---
weight: 34
---
# coverage

`fino coverage` reads the canonical JSON artifact created by
`fino test --coverage`. With no subcommand it prints aggregate totals and Realm
completeness:

```sh
fino coverage
fino coverage --input artifacts/unit.json
```

The default input is `coverage/coverage.json`. When selecting a subcommand, put
`--input` after its name:

```sh
fino coverage files --input artifacts/unit.json
fino coverage lines src/config.ts --input artifacts/unit.json
```

Output uses deterministic paths, labels, percentages, and source ranges so it
can be consumed directly by a person or supplied to a language model.

## Exploration commands

| Command | Description |
| --- | --- |
| `summary` | Show aggregate line, function, and branch totals plus Realm completeness. |
| `files` | List one compact coverage record per source file. |
| `lines <file>` | Show uncovered line ranges and source text for one file. |
| `functions [file]` | List covered and uncovered original-source functions. |
| `branches [file]` | List V8 block-derived branch ranges. |
| `realms` | List Realm ids, parent relationships, status, entries, and totals. |
| `realm <id>` | Show the files and totals contributed by one Realm. |

The JSON artifact uses union semantics: a source location covered in multiple
Realms counts once in aggregate totals, while its `coveredIn` list retains the
Realm attribution.

## Gating

`check` exits non-zero when a requested threshold is not met or when a Realm
did not submit a complete snapshot:

```sh
fino coverage check --lines 90 --functions 85 --branches 80
fino coverage check --lines 90 --per-file --input artifacts/unit.json
```

Thresholds are percentages from 0 through 100. `--per-file` applies every
threshold to each file as well as the aggregate.

## LCOV export

JSON remains canonical because LCOV cannot retain Realm attribution or
incomplete-run diagnostics. Export an aggregate original-source trace file when
another tool requires LCOV:

```sh
fino coverage export lcov
fino coverage export lcov --input artifacts/unit.json --output artifacts/lcov.info
```

The default output is `coverage/lcov.info`.
