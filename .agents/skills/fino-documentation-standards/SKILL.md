---
name: fino-documentation-standards
description: Ensure Fino JavaScript documentation comments are complete and markdown-first. Use when adding or changing public exports in js/, reviewing generated documentation, replacing JSDoc-style prose, checking module comments, or verifying docs with fino doc show/search.
---

# Fino Documentation Standards

Use this skill whenever JS module docs or generated-doc-visible symbols may change. Documentation should explain the contract in markdown prose, not rely on JSDoc tag blocks to carry meaning.

Authored guides live in `js/**/*.md`. Public TypeScript API docs come from markdown-first `/** */` comments, while synthetic Rust-backed public APIs are declared in `runtime-builtins.d.ts`.

Project documentation is intentionally more complete than a symbol reference.
Top-level public module comments should read like compact design notes: a new
user should understand when to reach for the module, what mental model it uses,
how the main pieces fit together, what defaults or limits matter, and where the
module intentionally stops.

## Required Coverage

1. Document every `js/` module with a top-level `/** */` comment.
   - Start with the public specifier and a short purpose line, for example `fino:config — explicit ordered config loading over fino:validate.`
   - Explain what the module does, when to use it, and what problem it does **not** try to solve.
   - Describe the design model: ownership, lifecycle, ordering/precedence rules, mutability, async behavior, storage model, protocol role, or other architecture that users need before reading individual symbols.
   - Mention important defaults, safety limits, unsupported features, platform gates, failure modes, cleanup/disposal requirements, and compatibility constraints.
   - Include at least one realistic `ts no_run` example for each public module unless the module is purely a narrow type barrel.
   - Link authoritative specifications or protocol references for spec-backed files. Use `$fino-spec-conformance` when that link or conformance is part of the task.
   - Use section headings such as `## Design`, `## Storage model`, `## Protocol notes`, or `## Example` when they make the module easier to scan.

2. Document every public or generated-doc-visible symbol.
   - Cover exported functions, classes, interfaces, types, constants, and class members that appear in generated docs.
   - Describe behavior, defaults, parameters by name in prose, return shape, failure or `null` cases, side effects, lifecycle expectations, and security caveats where relevant.
   - Document helper exports that support public APIs but are not application-facing, and mark them with `@internal` only when needed for doc visibility or filtering.

3. Use markdown-first comment content.
   - Prefer paragraphs, bullet lists, fenced `ts` examples, and inline code.
   - Avoid `@param`, `@returns`, and similar JSDoc tags as the normal way to describe behavior.
   - Keep examples realistic and minimal. Use `ts no_run` fences when examples are illustrative rather than executable.
   - For module comments, prefer complete paragraphs over tagline-only summaries. Good module docs in this repo often include a concise overview, a design note, a compatibility/limits note, and an example.

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

4. Run the applicable documentation checks.

   ```sh
   ./target/release/fino doc build --format html --types runtime-builtins.d.ts js
   ./target/release/fino doc test js
   ./target/release/fino doc show <symbol>
   ./target/release/fino doc search <query>
   ./target/release/fino test tests/docs/doc.test.ts
   ./target/release/fino test tests/docs/map.test.ts
   ```

   Generated `docs/` output is ignored. Update `js/documentation.md` whenever a guide is added, removed, or moved. If the release binary is unavailable and documentation behavior is not release-specific, use the current project binary and report the substitution.

## Review Checklist

- Module comment exists and gives enough context for a new maintainer.
- Public module comment has a specifier/purpose line, design model, defaults/limits, and a realistic example when applicable.
- Public exports and generated-doc-visible members have markdown-first comments.
- Spec-backed modules link authoritative references.
- Defaults, failure cases, `null` cases, security caveats, and lifecycle requirements are documented.
- `fino doc search` and `fino doc show` were used for touched public symbols, or the final response explains why not.
- Added, removed, and moved guides remain represented in `js/documentation.md`.
