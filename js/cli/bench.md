---
weight: 34
---
# bench

`fino bench` imports benchmark modules and delegates execution to `fino:bench`:

```sh
fino bench benchmarks/app.bench.ts
fino bench benchmarks
fino bench 'benchmarks/**/*.bench.ts'
```

Direct file inputs are imported as given. Directory inputs expand to descendant
`.bench.ts` files. Glob inputs are resolved from the current working directory.
Benchmarks run adaptive measurement loops and print human-readable throughput
results.

## Command Reference

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `files...` | argument | strings | yes | Benchmark files, directories, or glob patterns to import and run. |
| `--filter` | flag | string | no | Run only benchmark groups whose full path contains the filter text. |

Keep machines, ports, input data, and release/debug builds stable when
comparing numbers. The command does not emit JSON in normal text mode, provide
a public fixed-iteration mode, or act as a CI regression gate.

