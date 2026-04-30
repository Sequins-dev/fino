# Realms — Remaining Work

## Lifecycle & Advanced Isolation

- **Process Realms**: Implementing `fork(2)` + `execve(2)` based Realms for hard crash isolation and OS-level separation.
- **Remote Realms**: Integration with the `RealmPoolServer` for distributed execution.
- **Structured Concurrency**: Recursive termination is not fully propagated for deeply nested embedded Realms. `terminate_all_children` sets `terminated` and steps each direct child once, but the child's teardown (which would call `terminate_all_children` on its own children) only runs if the child's host loop has a full exit cycle. Grandchildren of a terminating Realm do not receive the termination signal.

## Open Questions

- **Q4**: Integration of embedded Realms with `fino:profiler`. The CPU profiler is created per-Isolate; embedded Realms share the parent's Isolate and would profile into the same profiler. Whether this is the right behaviour (aggregate profile across embedded Realms) or whether each embedded Realm should get its own profiler context needs to be decided.
