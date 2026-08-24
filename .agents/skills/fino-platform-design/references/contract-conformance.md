# Internal Contract Conformance

Use this review for interchangeable implementations of a Fino-owned contract. External protocol conformance belongs to `$fino-spec-conformance`.

## Define the contract above implementations

- Express operations in domain-level values rather than one backend's handles, syscalls, wire objects, or storage representation.
- Specify success, rejection, unsupported behavior, ordering, partial progress, closure, cancellation, and recovery.
- Distinguish required behavior from optional capabilities. Unsupported operations must have an explicit and tested outcome.
- Keep implementation discovery or feature availability separate from ordinary operation when callers need to choose safely.

## Prove substitutability

- Build a common conformance harness or reusable test cases when two or more implementations claim the same behavior.
- Run the same observable assertions against production, simulated, fallback, and platform implementations where locally possible.
- Add implementation-specific tests only for real boundary differences such as platform availability, native error translation, or optimized paths.
- Include lifecycle and failure semantics: duplicate close, pending operation during close, cancellation, overload, malformed input, and recovery after failure.

Do not call implementations conformant merely because their happy paths share a type. Record each claimed operation as `covered`, `partial`, `unsupported`, `platform-gated`, or `missing`, with its test evidence.

## Simulation

A simulator should implement the same caller-facing contract as production while making nondeterministic effects controllable. Prefer manual clocks, seeded decisions, scripted faults, and inspectable traces. Do not imitate low-level details, such as file descriptors, when they are not part of the real abstraction.
