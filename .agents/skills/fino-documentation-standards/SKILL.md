---
name: fino-documentation-standards
description: Ensure Fino JavaScript documentation comments are complete and markdown-first. Use when adding or changing public exports in js/, reviewing generated documentation, replacing JSDoc-style prose, checking module comments, or verifying docs with fino doc show/search.
---

# Fino Documentation Standards

Use this skill whenever JS module docs or generated-doc-visible symbols may change. Documentation should explain the contract in markdown prose, not rely on JSDoc tag blocks to carry meaning.

## Required Coverage

1. Document every `js/` module with a top-level `/** */` comment.
   - Explain what the module does, when to use it, important defaults, safety limits, and relevant compatibility constraints.
   - Include short markdown code examples for public modules when useful.
   - Link authoritative specifications or protocol references for spec-backed files. Use `$fino-spec-conformance` when that link or conformance is part of the task.

2. Document every public or generated-doc-visible symbol.
   - Cover exported functions, classes, interfaces, types, constants, and class members that appear in generated docs.
   - Describe behavior, defaults, parameters by name in prose, return shape, failure or `null` cases, side effects, lifecycle expectations, and security caveats where relevant.
   - Document helper exports that support public APIs but are not application-facing, and mark them with `@internal` only when needed for doc visibility or filtering.

3. Use markdown-first comment content.
   - Prefer paragraphs, bullet lists, fenced `ts` examples, and inline code.
   - Avoid `@param`, `@returns`, and similar JSDoc tags as the normal way to describe behavior.
   - Keep examples realistic and minimal. Use `ts no_run` fences when examples are illustrative rather than executable.

4. Keep docs aligned with behavior.
   - Update comments in the same change as implementation and tests.
   - Do not document aspirational behavior. If a feature is partial, platform-gated, or intentionally unsupported, say so plainly.
   - Mention defaults and limits where callers would otherwise need to read implementation details.

## Verification

1. Inspect exports and doc comments directly.
   - Use `rg -n "export |^/\\*\\*|@param|@returns|@internal" js/<area>` to find public symbols and tag-style comments.
   - Check class members as well as top-level exports.

2. Verify generated documentation presence for touched public symbols.
   - Use `fino doc search <symbol>` to confirm the docs generator can find the symbol.
   - Use `fino doc show <symbol>` to inspect rendered content for completeness.
   - If the local command is unavailable, run the project-equivalent binary or state why generated-doc verification could not be completed.

3. Pair docs with tests when behavior changed.
   - Use `$fino-test-coverage-gaps` if changed docs describe new behavior, edge cases, or failure modes that should be tested.

## Review Checklist

- Module comment exists and gives enough context for a new maintainer.
- Public exports and generated-doc-visible members have markdown-first comments.
- Spec-backed modules link authoritative references.
- Defaults, failure cases, `null` cases, security caveats, and lifecycle requirements are documented.
- `fino doc search` and `fino doc show` were used for touched public symbols, or the final response explains why not.
