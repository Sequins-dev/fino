# Fino UI component framework

One component model, many render targets. This document is the durable design record for
building a general-purpose, host-neutral UI component library on `fino:ui` — a Chakra-style
catalog (modals, tabs, disclosure sections, file trees, form controls, tables, …) written
once and rendered to **HTML** and **TUI** through per-host render targets, with room for
more targets later.

It exists because the `fino code` TUI was built by bypassing `fino:ui`: pre-rendered
`string[]` smuggled through fake VNodes, trees synthesised from rendered strings, and a
hand-written footer layout engine. The correction is not "rewrite that TUI" — it is to build
the component framework that should have existed, validate it standalone, and only then
rewrite the app on top of it.

## Phasing

- **Phase 1 — the framework.** JSX/TSX for built-ins, the host-neutral primitives contract,
  the TUI render target (reworking `fino:tty/tui` in place), the HTML render target mapping,
  the component catalog, and a generic PTY testing system. Built, tested, and validated
  ergonomically sound before any app work. This phase lives on its own branch/PR.
- **Phase 2 — `fino code` integration.** Rewrite the coding agent interface on the
  framework. The design decisions are already settled and recorded below (§Phase 2) so they
  survive until execution; the existing PR rebases onto the framework branch first.
- **Phase 3+ — future targets.** Candidates: a retained DOM adapter for the browser client,
  canvas/pixel targets, remote/portable trees over transports. Listed, not designed.

---

## Architecture

### The component model (unchanged from `fino:ui`)

Components are synchronous functions from props to a VNode tree. State lives in signals or
app-owned models outside the tree; a signal write re-renders the root that read it,
producing a new object graph. **Reconciliation of that graph is the render target's job** —
each target decides how a graph change becomes actual UI change. Targets are retained-mode:
they implement `HostAdapter` (`js/ui.ts`), keep a mounted node tree, and mutate only what
differs.

Framework facts that shape every target (verified against `js/ui.ts`, which needs **no
changes**):

- `h()` invokes function components eagerly — the reconciler sees only host nodes.
  Retained mode caches host-side artifacts (layout, paint), never component invocations.
- `moveChild` is called on every child on every pass — same-index moves must be no-ops.
- `unmount` is shallow — targets must recursively release per-node state (focus
  registrations, hit regions, measurement caches).
- `createRoot` re-runs the whole element thunk per signal write — the reconciler is what
  keeps host mutation proportional to change.

### The semantic tree — the core rule

**The tree is purely semantic; render targets own all presentation.** A catalog component
is a thin constructor emitting a semantic node (`ui:checkbox` with `{ checked, label,
onChange }`, `ui:details`, `ui:table`, …) carrying only data and handlers — never glyphs,
never composed layout. Each render target has a lowering layer that decides what that
semantics *looks like there*: the terminal lowers `ui:checkbox` to `[x] label` glyph
composition (`internal:tty/lower`), HTML lowers it to a native `<input type="checkbox">`
with web styling. Presentation baked into the shared tree — even as a "default" one target
happens to use — is an architecture bug: it privileges one host and forces the others to
transform its artifacts.

### The primitives contract

Beneath the semantic layer sit **the host-neutral layout primitives** — the structural
vocabulary lowering layers and custom app trees compose with. A render target implements
exactly these (plus focus/events), and every lowering works. This is the wall that keeps
targets from drifting.

| Primitive | Contract |
|---|---|
| `Box` | The one layout node. **Flexbox model**: `direction`, `wrap`, `justify`, `align`, `gap`, and per-child `grow`/`shrink`/`basis`; plus `padding`, `margin`, `border` (`borderStyle`, `borderColor`), `width`/`height`/`minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `overflow: 'visible' \| 'hidden'`. `gap` skips zero-size children. |
| `Text` | Styled text runs. `wrap: 'none' \| 'char' \| 'word'`, `align`, `truncate` (ellipsis), `caret?: number` (character offset reported to the target's cursor). |
| `Layer` | Portal: children render above normal flow. `anchor`: a node id or explicit `{x, y}` (e.g. a click position); `placement` (`'bottom-start'`, `'center'`, …), `offset`, viewport clamping, optional `backdrop`, `onDismiss` (Esc / outside click). Base for Modal, ContextMenu, Select popover, Tooltip, Toast. |
| `Clickable` | **Non-visual behavior container.** Wraps anything; activating anywhere within (click, or Enter/Space while focused) fires `onClick`. Props: `focusable` (default true), `disabled`, `id`. Base for Button, Details' summary bar, MenuRow, Tab labels, tag remove glyphs. |
| `Input` | Single-line editable text: `value`, `caret`, `selection`, `placeholder`, `onInput`/`onSubmit`. Multi-line editing is a component over the `TextBuffer` model, not a primitive. |
| `Scroll` | Scrollable region: `offset` (controlled), `onScroll(info)`, `follow` (stick-to-bottom while content grows; upward scroll breaks follow, reaching bottom re-engages), wheel handling. Virtualization is a component on top, not a primitive. |

Style props on every primitive: `color`, `background`, `bold`, `dim`, `italic`,
`underline`, `inverse`, `strike`, `style?: StyleToken | StyleToken[]`.

### Theming

Semantic tokens resolved per target. A theme maps token names — `accent`, `danger`,
`success`, `warning`, `muted`, `surface`, `border`, … — to concrete values: CSS custom
properties on HTML, `Style` objects (SGR) on TUI. Catalog components reference tokens only;
no raw colors outside theme modules. The terminal palette distinguishes `white` (SGR 37)
from `brightWhite` (97); the palette→SGR mapping is pinned by a unit test.

### Focus and events

Framework-level, implemented per target over its retained tree:

- **Focus**: `focusable`/`tabIndex`/`focused` props; a `FocusManager` holds focus by node
  identity, traverses in document order (`focusNext`/`focusPrev`), fires
  `onFocus`/`onBlur`. Retained node identity is what makes this possible.
- **Events**: `onKey`, `onMouse`, `onClick` props. Mouse events hit-test to the deepest
  containing node and **bubble up the ancestor chain**; key events start at the focused node
  and bubble. A handler returning `true` stops propagation.
- Tradeoff, stated: function props make a tree non-portable (`fino:ui/portable` rejects
  functions by design). Interactive trees are in-process; purely presentational components
  stay function-prop-free and remain portable.

### State rule

Interactive state lives in signals or plain app-owned models (`ListSelection`,
`TextBuffer`, `VirtualScroll`); components receive snapshots/props. Components offer
controlled and uncontrolled variants where Chakra does: `open`/`defaultOpen` +
`onOpenChange`, `value`/`defaultValue` + `onChange`.

---

## The component catalog — `fino:ui/components/*`

Chakra UI is the reference point for scope and API shape. Each component is behavior state
plus composition down to primitives; every component renders in both targets from day one.

**Module layout.** The catalog is grouped into `internal:ui/components/*` modules — one per
component family — with `fino:ui/components` as the single public entry point over them, and
each module's gallery stories beside it in `<module>.stories.tsx`. The barrel's re-exports are
the public API: components, props types, the data types those props name, and the state models
an app holds across renders. The pure helpers that exist so the two lowerings agree (edit
reducers, icon registry lookups, calendar and axis math, the braille rasterizer) stay off the
barrel and are imported from their owning module by render targets and tests.

| Group | Components |
|---|---|
| Layout | `Flex`/`Stack`/`HStack`/`VStack` (thin `Box` sugar), `Spacer`, `Rule`, `Panel` (bordered box with title/footer) |
| Disclosure | `Details` (always-visible summary bar; clicking toggles the content area — GitHub details/summary), `Accordion` (Details list, optional single-open), `Tabs`/`TabList`/`Tab`/`TabPanel` |
| Overlay | `Modal` (centered `Layer` + backdrop + focus trap + Esc), `ContextMenu` (`Layer` anchored at a click position), `Popover`, `Tooltip`/`HoverCard` (hover/focus-triggered), `Toast` |
| Forms | `Button`, `Checkbox`, `Radio`/`RadioGroup`, `Switch`, `Select` (trigger + popover `MenuList`), `TextInput`, `TextArea` (over `TextBuffer`), `Slider` (stretch) |
| Menus/lists | `MenuList`/`MenuRow`/`MenuHeader`/`MenuSeparator`; `ListSelection` state model (move/page/selectKey, scroll-window snap) |
| Navigation | `Breadcrumbs`, `Pagination`, `Steps` (step sequences) |
| Data | `Table` (headers, flex column sizing, sortable hooks), `Tag` (optional remove ×)/`TagGroup`, `Timeline`, `FileTree` (expand/collapse, selection, lazy children), `Badge`, `KeyHint`, `Spinner`, `ProgressBar` |
| Virtual | `VirtualList` over a `VirtualScroll` model — height estimates corrected by measured retained nodes; pad spacers keep scroll geometry; only windowed items build VNodes |

---

## The TUI render target — `fino:tty/tui` reworked in place

**Cells are the intermediate representation; ANSI bytes exist only at the wire edge.**
Every legacy bug (escapes split by wrapping, compositing by code-unit slicing, containers
measuring 0×1) is a symptom of strings as the IR.

- **`fino:tty/style`** — `Style`, `Color`, `mergeStyle` (undefined inherits, `false`
  disables), `styleToSgr` (minimal transitions), `parseAnsi` (SGR state machine; non-SGR
  CSI dropped). Styles are interned through a bounded table so equality is pointer compare.
- **`fino:tty/frame`** — `Segment { text, width, style }` (printable only), ragged `Row`
  (no trailing pad — a filled last column gets recorded soft-wrapped by real terminals),
  `Frame { rows, cursor, hits }`, `rowToAnsi` (pure per-row; the encoded string doubles as
  the diff key), `frameToAnsi`, `frameToScreen(frame, previous)` (row-diffed absolute
  paint), `hitTest`/`hitPath`.
- **Width** — `charWidth`/`graphemes`/`stringWidth`: East Asian Wide/Fullwidth → 2,
  combining/ZWJ/variation selectors → 0. Approximate for emoji ZWJ sequences; terminals
  disagree with each other anyway.
- **Host** — a `TerminalNode` tree implementing `HostAdapter`. Damage rules: `updateNode`
  diffs props before dirtying (the reconciler passes fresh props objects every time);
  same-index `moveChild` is a no-op; `removeChild` recursively releases focus/hit/measure
  state; dirt propagates up (measurement) and down (inherited style). Clean subtrees at an
  unchanged width skip re-layout — this is what makes large static regions cheap.
- **Layout** — the flexbox subset from the `Box` contract with real recursive intrinsic
  measurement; `wrapSegments` (hard `\n` breaks in every mode; word/char; style runs
  survive breaks; grapheme- and wide-char-safe); a cell `Canvas` for composition (clipping,
  wide-char continuation cells; clipping half a wide char yields a space); `Layer` subtrees
  painted after the main tree in registration order.
- **Live target** — `render()` on the retained host: alt screen, mouse `?1002/?1006`
  (button events, deliberately not `?1003` motion), `frameToScreen` diffing per commit,
  terminal cursor placed from `frame.cursor`, input via `TuiInput` dispatched through the
  event tree. `renderFrame`/`frameSink` keep their signatures, reimplemented on top;
  `terminalSink()` returns the `Frame`. Resize = invalidate width-keyed caches, re-layout,
  one diffed paint.
- Kept: `TuiInput`/`decodeTuiInput`, `getTerminalSize`, OSC 52 clipboard.

Deliberate behavior changes: default `borderStyle` becomes `'single'` (`'ascii'` stays
available); `wrap` on `Text` means word wrap (`'char'` preserves the old hard-chop);
`visibleWidth` becomes wide-char-aware.

## The HTML render target

The same primitives mapped onto the existing HTML machinery (`fino:ui/html`, the web
client): `Box` → flexbox CSS, `Text` → styled spans, `Layer` → portal root with absolute
positioning, `Clickable` → button semantics/ARIA, `Scroll` → overflow container. Theme
tokens → CSS custom properties. Static pages via `htmlSink` keep working; interactivity
uses the web client's event wiring. Every catalog component lands with an HTML snapshot
test next to its TUI frame test — the dual-test requirement is the drift guard.

## The PTY testing system

A generic, fino-native system for validating TUI output behavior in a real pty, so
interaction tests run inside the normal `fino test` suite:

- **`internal:tty/vt`** — a VT emulator in TypeScript: grid, SGR spans, private modes
  (`?25 ?7 ?1002 ?1006 ?1049`), alt screen, scroll regions, wheel encoding, resize with
  cursor/bottom anchoring, DECAWM pending-wrap. Ported from the proven Python emulator
  (`tests/tty/harness/pty_driver.py` on the coding-agent branch), which remains the parity
  reference until matched, then retires.
- **`fino:test/pty`** — spawns a child `fino` process on a real pty (FFI: `posix_openpt`/
  `grantpt`/`unlockpt`, `TIOCSWINSZ`) and feeds output through the emulator:
  `openPty(script, opts)` → `{ send(), resize(), snapshot(), text(), styledAt(), modes,
  waitFor(predicate, { timeout }), close() }`.
- Every interactive catalog component gets a demo app + PTY test (modal focus trap, select
  popover, details toggle, tab switching, file-tree expand, drag behavior in `Scroll`).

## Phase 1 validation gate

Phase 2 does not start until: every catalog component has unit + HTML + TUI
tests, with PTY tests for interactive ones; the gallery renders every story in
both targets from one component tree (this is the conformance surface — a
separate demo app was considered and dropped as redundant); docs are written
(`js/ui.md` updated, `js/ui/components.md` added) and every new `fino:*`
specifier is registered in `src/loader.rs` and `benchmarks/COVERAGE.md`; and
the component API has passed an ergonomics review over the gallery.

Decided and not pursued: clickable terminal hyperlinks (OSC 8). They cannot
survive the frame pipeline without teaching `Segment`/`Row` about
non-printable payloads, so `href`-only links are styled text in the terminal
and real anchors on the web.

---

## Phase 2 — `fino code` integration (settled decisions, recorded for later)

Decided during planning; executed only after the Phase 1 gate, on the coding-agent PR
rebased onto the framework branch:

- **Live-only UI.** One full-screen component tree; alt screen; mouse capture on. The
  scrollback-commit / live-to-static sealing designs were considered and **dropped as too
  complicated**; maybe revisited later.
- Transcript is a `VirtualList` with a bounded in-memory entry window (~hundreds) that
  reloads older entries from the session transcript (`fino:ai/transcript`) on scroll-up;
  total extent from the transcript index with height estimates for unloaded ranges.
- **Virtualized selection copying**: selection in content coordinates (entry, row, column);
  highlight painted as a composition overlay; **auto-copy on mouseup** via OSC 52 with a
  "copied" status flash; cleared on width change. Off-window parts of a selection are laid
  out on demand when materializing the text.
- Streaming messages render live; per-delta cost stays flat via settled-markdown-block row
  caching (`MarkdownTerminalStream` kept as an internal optimization).
- Tabs drive sub-agent views; Modal drives the model picker; ContextMenu for session row
  actions.
- Deletions at cutover: `js/tty/inline.ts` (DECSTBM commit, `composeInlineFrame`, DSR
  probe) + its unit tests + the inline PTY scenarios; the `fino:tty/components/*` string
  builders; the hand-written footer layout (`tailAllowance`, the caret-by-subtraction
  arithmetic). App-level PTY scenarios rewritten on `fino:test/pty`.
