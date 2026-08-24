# Design Map

Use the smallest subset of this map that exposes the important choices. A short change may need only a few rows; a new subsystem may need all of them.

| Concern | Questions to resolve |
| --- | --- |
| Capability | What observable problem is solved, for whom, and what is explicitly out of scope? |
| Existing system | Which primitives, contracts, call sites, and tests already cover part of the problem? |
| Decomposition | What is the reusable mechanism, and which policy remains in thin adapters? |
| Placement | Why does the code belong in TypeScript or require an irreducible Rust primitive? Is it public `fino:*`, private `internal:*`, or ordinary source? |
| Contract | What data, ordering, errors, unsupported cases, state transitions, and compatibility promises are observable? |
| Ownership | Who creates, retains, closes, cancels, and disposes each resource? Is cleanup idempotent? |
| Bounds | Which queues, buffers, retries, tasks, logs, and retained values are bounded? What happens at the limit? |
| Effects | How are time, randomness, I/O, environment, capabilities, and other nondeterministic inputs supplied? |
| Observability | Which inputs, transitions, failures, and resource-use signals can be inspected without changing semantics? |
| Realms | What crosses the boundary, what must serialize, and which behavior differs across scheduled, sandbox, process, and remote modes? |
| Evolution | How can another implementation or caller be added without weakening the contract? Does persisted or wire data need a version? |
| Proof | Which generic, conformance, integration, failure, concurrency, cleanup, security, and performance tests establish the design? |

## Decision tests

- If a proposed lower layer mentions one protocol, product feature, platform backend, or caller unnecessarily, move that policy outward.
- If a proposed abstraction has no stable contract or evidence beyond hypothetical reuse, keep it local until the mechanism becomes clear.
- If higher layers still need to understand the lower layer's internal states, narrow or raise the boundary.
- If production and simulation require different caller logic, reconsider the shared contract before adding conditionals.
- If correctness depends on ambient global state, thread affinity, wall-clock timing, or cleanup timing, make the dependency explicit.
