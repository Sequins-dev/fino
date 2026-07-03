---
weight: 34
---
# Bench Command

`fino bench` imports benchmark modules and delegates execution to
`fino:test/bench`:

```sh
fino bench benchmarks/app.bench.ts
fino bench benchmarks
fino bench 'benchmarks/**/*.bench.ts'
```

Directory inputs expand to descendant `.bench.ts` files. Benchmarks run adaptive
measurement loops and print human-readable throughput results. Keep machines,
ports, input data, and release/debug builds stable when comparing numbers.

Use `--filter` to run benchmark groups whose full path contains text:

```sh
fino bench --filter parse benchmarks
```

The command does not emit JSON, provide a public fixed-iteration mode, or act as
a CI regression gate. Import the default task from `fino:commands/bench` to
reuse it.
