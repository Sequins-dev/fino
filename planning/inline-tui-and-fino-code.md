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

### 1. Inline terminal regions

This is the only capability `main` lacks, and everything else here depends on
it. `render()` in `js/tty/tui.ts` is fullscreen: it enters the alternate
screen, hides the cursor and owns the viewport until `stop()`. A coding agent
needs the opposite — a region that paints above the prompt, grows and shrinks
with its content, and leaves the transcript in the terminal's scrollback when
it finishes.

#34 has a working implementation in `js/tty/inline.ts` (828 lines):
`renderInline`, `withInlineApp`, an overlay handle, and `composeInlineFrame` /
`footerTop` for placing a footer against the bottom of the region. It predates
the retained host, so it composes rows itself rather than going through
`internal:tty/layout` and `fino:tty/frame`.

Rebuild it on the landed stack rather than porting it:

- Reuse `layoutRetained` and the `Frame` model; an inline region is a viewport
  with a height the app chooses, not a new layout engine.
- Reuse `frameToScreen` row diffing. Inline mode differs in cursor placement
  and in scrolling the region, not in how a row is encoded.
- Keep the existing `TuiApp` shape where it fits, so `render()` and
  `renderInline()` differ in viewport ownership and nothing else.
- Overlays should be `Layer`, which the layout engine already supports, rather
  than a second out-of-flow mechanism.

Carry over the behaviour `inline.ts` already gets right — footer placement
under a growing history, and reflow on resize without corrupting scrollback.

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

- **Inline scrollback is hard to assert.** The pty harness models a screen, not
  scrollback, so "the transcript survives after exit" needs either an emulator
  addition or a test that reads the raw byte stream. Decide this before writing
  step 2's tests, not after.
- **`fino code`'s value is in the agent, not the chrome.** The catalog rewrite
  is mechanical; the risk is spending the budget there and re-landing the agent
  unreviewed. Keep step 3 reviewable on its own.
