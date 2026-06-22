---
name: fino-spec-conformance
description: Audit Fino JavaScript modules against authoritative specifications. Use when working on spec-backed files in js/, adding or reviewing protocol/format/runtime behavior, checking that top-level comments link relevant specs, aligning implementation structure to spec sections, or proving conformance with tests.
---

# Fino Spec Conformance

Use this skill to make spec-backed Fino code auditable: the module comment points to the authoritative text, implementation structure is easy to compare with that text, and tests prove each required behavior or document an intentional limit.

## Workflow

1. Identify whether the changed `js/` file is spec-backed.
   - Treat protocol, wire format, serialization, parsing, crypto/security, web-platform-like globals, and interoperability modules as spec-backed unless inspection proves otherwise.
   - Prefer primary specifications over summaries. Examples: RFCs, WHATWG/W3C specs, ECMA specs, OpenTelemetry specs, or project-adopted upstream conformance documents.
   - If no primary spec exists, record that explicitly in the work summary and do not invent a spec link.

2. Verify the top-level module comment.
   - Ensure every related authoritative spec is linked in the module-level `/** */` comment.
   - Keep links close to the module overview, usually under a `Learn more:` or `Useful references:` markdown list.
   - Mention the implemented subset, compatibility baseline, or intentional limits when the module does not implement the full spec.

3. Read the authoritative spec text before changing behavior.
   - Use the linked spec as the source of truth, not memory or secondary documentation.
   - Compare the relevant sections methodically. For large specs, start from the sections named by the implementation, tests, comments, constants, frame types, algorithms, or error names.
   - When the implementation intentionally supports only part of a spec, define the supported subset precisely before judging conformance.

4. Build a conformance map while working.
   - For each relevant spec section, record: requirement, implementation location, test location, status, and notes.
   - Status should be one of: `covered`, `missing-test`, `missing-implementation`, `intentional-limit`, or `not-applicable`.
   - Include this map in the final response for audits, or encode durable notes in nearby comments/tests when they help future readers.

5. Align code shape with spec shape when it improves clarity.
   - Prefer function boundaries, comments, constants, and test grouping that mirror spec concepts or algorithm steps.
   - Avoid large rewrites only for aesthetics. Restructure when it materially improves correctness review or prevents misreading.
   - Preserve hot-path performance and existing module boundaries.

6. Prove behavior with tests.
   - Use `$fino-test-coverage-gaps` for the coverage audit portion when tests need review or expansion.
   - Put tests in the closest `tests/` domain folder and name them by observable behavior, not implementation detail.
   - For spec-backed behavior, group or comment tests by spec section when that makes traceability clearer.
   - Cover success paths, boundary values, malformed inputs, unsupported features, security limits, and platform-dependent gates.

7. Report deviations precisely.
   - Do not call behavior spec-conformant when it is only compatible with common practice.
   - For intentional gaps, state the reason, user-visible behavior, and test coverage that prevents accidental drift.
   - If a spec requirement cannot be verified locally, state what remains unverified and why.

## Final Response Checklist

- Name the spec links used.
- Summarize implementation and test changes by spec requirement.
- Call out intentional limits or unresolved conformance gaps.
- List the exact tests or checks run.
