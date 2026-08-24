---
name: fino-platform-design
description: Design or review nontrivial Fino subsystems, shared mechanisms, providers, transports, schedulers, state machines, public APIs, and cross-cutting refactors for reusable layering, coherent contracts, and reliable Realm behavior. Skip localized fixes that preserve an established design.
---

# Fino Platform Design

Use this skill before an architectural choice becomes expensive to reverse. Apply the durable principles in `AGENTS.md`; this workflow turns them into explicit design decisions without copying them into another source of truth.

## Workflow

1. Define the capability in observable terms.
   - State intended consumers, non-goals, compatibility constraints, and the stable behavior callers may rely on.
   - Search existing mechanisms, adjacent modules, call sites, tests, and planning notes before introducing a new abstraction.

2. Produce a compact design map.
   - Read [references/design-map.md](references/design-map.md) when proposing or reviewing a nontrivial design.
   - Separate the reusable mechanism from protocol, platform, product, and call-site policy.
   - Decide ownership, lifecycle, bounds, effects, observability, public/internal placement, and evolution strategy.
   - Generalize only a stable mechanism supported by current behavior and credible uses; do not invent extension points without a contract.

3. Audit interchangeable implementations.
   - For providers, adapters, backends, stores, sinks, codecs, or transports, read [references/contract-conformance.md](references/contract-conformance.md).
   - Define the contract without leaking one implementation's representation.
   - Prove shared behavior with a common conformance harness where practical, then test implementation-specific boundaries separately.

4. Audit execution and resource behavior.
   - For async resources, concurrency, capabilities, serialization, or Realm execution, read [references/realm-reliability.md](references/realm-reliability.md).
   - Make ordering, cancellation, shutdown, cleanup, overload, and cross-mode differences explicit.

5. Connect design decisions to evidence.
   - Test a generic mechanism directly and each adapter's composition with it.
   - Prefer deterministic simulators or injected effects for failure, timing, and concurrency behavior.
   - Use `$fino-test-coverage-gaps` for the behavior map, `$fino-spec-conformance` for externally specified behavior, `$fino-documentation-standards` for public JS surfaces, and `$fino-performance-engineering` when performance affects the design.

## Output

For a design review, report the chosen decomposition, rejected alternatives that materially affect the decision, contract and lifecycle invariants, Realm-mode differences, and proof plan. For implementation work, keep that map in working notes and summarize only decisions that help reviewers verify the result.

Surface unresolved contract conflicts before committing to a public or cross-boundary shape. Do not require a standalone design document for a small or already-established change.
