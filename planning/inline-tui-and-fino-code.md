# Inline terminal rendering and rebuilding `fino code`

## Purpose

The UI component framework landed on `main` as sixteen reviewed slices
(FIN-226 through FIN-241). This document records what that leaves, so the
`fino code` work in [#34](https://github.com/Sequins-dev/fino/pull/34) can be
rebuilt on the framework instead of on the ad-hoc terminal layer it currently
carries.

It is deliberately narrow. The component catalog, the render-target registry,
the terminal and HTML targets, and the preview are all finished; they are
described here only where the remaining work has to attach to them.

## Implementation status

The framework is complete on `main`. The stack merged as #59, #60, #64–#68,
#70–#72 and #74–#79, and `main` has since gone further than the branch it was
cut from:

- Components are plain functions whose body is their HTML rendering. A render
  target registers a replacement against the component itself, through
  `mapComponentLowering` in `js/ui/components/target.ts`.
- Each family is four modules — `<family>.ts`, `.tui.ts`, `.html.ts` and
  `.preview.ts` — 15 terminal lowerings, 14 HTML lowerings and 14 preview sets.
- `target.ts` also owns a per-family CSS registry (`registerHtmlCss` /
  `registeredHtmlCss`), so the page stylesheet is assembled from the families
  that are actually used rather than from one shared `PAGE_CSS`.
- `fino preview` renders every preview in both targets from one tree, over the
  `fino:test/pty` harness and the `internal:tty/vt` emulator.

### The original branch is superseded

`t3code/ui-component-framework` (#35) should be closed rather than rebased.
Checked before writing this:

- `fino:ui/components` on `main` exports 223 names against the branch's 188.
  Exactly two names exist on the branch and not on `main` — `TextFieldState`
  and `TextAreaState` — and both were replaced there by a unified
  `TextEditState` plus a `TextEditController`, with `createTextField` and
  `createTextArea` unchanged. Nothing else is missing.
- Every component the branch's tests cover exists on `main`, including the ones
  with no directly-named test file there — `FloatingActionBar`, `VirtualScroll`,
  `ToastStack`, `HoverCard`, `Breadcrumbs`, `Steps`, `Timeline`, `FileTree`.
- The late fixes carried across: split escape-sequence reassembly (with
  `tests/tty/input-split.test.ts`), the shared spinner clock, and the FIFO
  stream ordering from FIN-226.

What this comparison does *not* establish is per-component behavioural parity.
It compares exported surface, module layout and named features, not rendered
output. If a specific behaviour is thought to be missing, diff that component's
preview against the branch rather than trusting this summary.

## Required work, in order

### 1. Inline terminal regions — done

`fino:tty/inline` provides `renderInline()`. `render()` still owns the
alternate screen; the inline renderer stays in the primary buffer, pushes
finalized content into the terminal's own scrollback, and repaints a footer
pinned above it.

The footer is a component tree laid out through the same `retainedTerminal`
pipeline `render()` uses, so focus, key dispatch and the whole catalog work
inside it. `render()` and `renderInline()` now differ in viewport ownership and
nothing else.

`InlineApp` gives `fino code` what it needs: `printAbove()` takes a component
tree or pre-wrapped strings, `update()` replaces the footer, `resetHistory()`
rebuilds from the top, `setMouse()` toggles capture, and `focus` exposes the
footer's traversal. Mouse capture is off by default so the terminal keeps
selection, scrolling and find.

Two behaviours are worth knowing when building on it:

- The footer is sized to the height its content asks for, not to the row
  budget. Laying it out at the maximum claims every spare row, which pins the
  footer to the top and leaves the transcript one row — the bug the growth
  test now guards.
- Transcript rows use the full width; footer rows stop one column short. A
  footer row that fills the last column can be recorded as soft-wrapped, and a
  later re-wrap joins it with the row below.

Not carried over from #34: `withInlineApp` and the fullscreen overlay handle.
Overlays should be `Layer`, which the layout engine already supports, rather
than a second out-of-flow mechanism; add it when a caller needs it.

### 2. Rebuild `fino code` on the framework

With inline rendering in place, most of #34's terminal code is deletable:

- `js/tty/components/{box,composer,list,pane,spinner,statusbar,text,theme}.ts`
  — 735 lines across eight modules, all superseded by `fino:ui/components`.
  `composer.ts` and `statusbar.ts` are the two with no direct catalog
  equivalent; they should become application components in the `fino code`
  tree that compose catalog primitives, not new catalog entries.
- `tests/tty/harness/pty_driver.py` and `inline_checks.py` — 720 lines of
  Python, superseded by `fino:test/pty`. The sample apps beside them
  (`sample-app.ts`, `inline-sample-app.ts`) are still useful as fixtures.

That leaves the actual agent: `js/commands/code.ts` (238 lines),
`js/commands/mcp.ts` (200 lines), the ten `js/ai/*` modules, and the
`js/test/bench.ts` and `js/commands/bench.ts` changes, which are unrelated to
the UI work and can land independently.

### 3. Re-land as a stack, not a rebase

#34 is 73 commits behind `main` and 35 ahead, and its `js/tty` files no longer
exist there. A rebase would resolve conflicts against deleted files. Cut it the
way the framework was cut:

1. The bench/test-runner changes, which are independent.
2. Inline rendering plus its pty tests, against the catalog.
3. `js/ai/*`, which is the largest piece and has no UI dependency.
4. `fino code` and `fino mcp` themselves, on top of the three above.

Order 1 and 3 can proceed in parallel with 2; only step 4 needs all of them.

## Risks

- **Scrollback itself is still unasserted.** The pty harness models a screen,
  not scrollback. `tests/tty/inline.test.ts` covers what the screen can show —
  eviction order, the footer never being overwritten, the transcript surviving
  exit — and asserts the DECSTBM region directly through the pure composer. It
  does not prove an evicted row reached the terminal's saved scrollback; that
  needs an emulator addition or a raw-byte test.
- **`fino code`'s value is in the agent, not the chrome.** The catalog rewrite
  is mechanical; the risk is spending the budget there and re-landing the agent
  unreviewed. Keep step 3 reviewable on its own.
