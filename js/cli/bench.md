---
weight: 34
---
# bench

`fino bench` runs benchmark modules that register measurements with
`fino:bench`. Use it when you need a quick throughput comparison for parser
changes, protocol code, runtime primitives, or other performance-sensitive
paths:

```sh
fino bench benchmarks/app.bench.ts
fino bench benchmarks
fino bench 'benchmarks/**/*.bench.ts'
```

Direct file inputs are imported as given. Directory inputs expand to descendant
`.bench.ts` files. Glob inputs are resolved from the current working directory.
Benchmark modules are imported for registration side effects, then the benchmark
runner executes adaptive measurement loops and prints human-readable throughput
results.

## Command Reference

| Name | Value | Description |
| --- | --- | --- |
| `files...` | strings | Required. Benchmark files, directories, or glob patterns to import and run. |
| `--filter` | string | Run only benchmark groups whose full path contains the filter text. |

Keep machines, ports, input data, and release/debug builds stable when
comparing numbers. The command does not emit JSON in normal text mode, provide
a public fixed-iteration mode, or act as a CI regression gate.

Use `--filter` to narrow a benchmark file or directory to one group while
iterating:

```sh
fino bench --filter parse benchmarks
```
