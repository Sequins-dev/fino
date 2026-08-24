---
name: fino-performance-engineering
description: Benchmark, load-test, or profile performance-sensitive Fino changes with controlled release-build workloads and correctness-preserving interpretation. Use for throughput, latency, allocation, scaling, regression, benchmark, load-generation, or profiler work.
---

# Fino Performance Engineering

Measure a stated performance question without weakening determinism, capability safety, cleanup, or correctness. Establish functional and failure-path coverage before treating throughput as meaningful.

## Workflow

1. Define the comparison.
   - Name the workload, metric, baseline, expected bottleneck, and correctness invariants.
   - Pin inputs, ports, protocol, connection and stream counts, dependencies, response policy, warmup, and machine conditions.

2. Use an optimized binary.

   ```sh
   cargo build --release
   ./target/release/fino bench benchmarks/net/http/app.bench.ts
   ./target/release/fino bench --filter routing benchmarks/net/http
   FINO_REQUIRE_SQLITE=1 ./target/release/fino bench benchmarks
   ```

   Run the narrowest representative benchmark first. Compare repeated runs and investigate variance; adaptive human-readable output is not by itself a statistical CI regression gate.

3. Exercise failure and stress behavior as well as steady state.
   - Keep queues, histograms, retained samples, and generated state bounded.
   - Check cancellation, overload, cleanup, and recovery under the same conditions that produce high throughput.
   - Add or update a focused benchmark for a performance-sensitive public mechanism, or document why a benchmark would not provide useful evidence.

## HTTP Load Testing

Prefer the built-in load generator so workload semantics and output remain explicit:

```sh
./target/release/fino load --connections 100 --warmup 5s \
  --duration 30s http://127.0.0.1:3000/
./target/release/fino load --protocol h2 --connections 20 --streams 10 \
  --warmup 5s --duration 30s --insecure --json https://localhost:3000/
```

Pin `h1`, `h2`, or `h3` rather than accepting silent fallback. Record response consumption versus headers-only cancellation because they impose different server work. Preserve the JSON output and exact command when comparing runs.

## Profiling

Use `fino:profiler` for V8 CPU profiles and symbolized binaries for native investigation. Instrument only the narrow workload with `startProfiling()` and `stopProfiling()`, and write the returned pprof bytes for inspection. Keep warmup outside the capture window, use a unique port, verify that the workload reached steady state, and retain load output with the profile. Use release builds to explain production throughput and debug builds when native symbol fidelity is the primary need.

```sh
./target/release/fino load --connections 100 --warmup 5s \
  --duration 30s http://127.0.0.1:3000/
go tool pprof profile.pb
```

Report the environment, repetitions, variance, observed bottleneck, and any performance dimension that remains unmeasured. Describe inferences as inferences rather than benchmark facts.
