# Realms — Remaining Work

## Open Questions

- **Q4**: Integration of embedded Realms with `fino:profiler`. The CPU profiler is created per-Isolate; embedded Realms share the parent's Isolate and would profile into the same profiler. Whether this is the right behaviour (aggregate profile across embedded Realms) or whether each embedded Realm should get its own profiler context needs to be decided.
