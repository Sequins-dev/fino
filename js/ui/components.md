---
weight: 10
---

# The Component Catalog

`fino:ui/components` is where interfaces come from. It is one import site with
two vocabularies: structural primitives that describe layout, and a semantic
catalog that describes meaning. Both produce ordinary `fino:ui` trees, so
everything in [Components and Render Programs](../ui.md) — lifetimes, sinks,
realms, portability — applies unchanged.

## Two vocabularies

The **structural primitives** — `Box`, `Text`, `Spacer`, `Input`, `Layer`,
`Clickable`, `Scroll`, and `Rule`, with `VStack`/`HStack`/`Stack` as direction
shorthands — describe layout. They emit the node types render targets
implement directly (`box`, `text`, `layer`, `clickable`, `input`,
`scrollview`, plus the `spacer` and `rule` helpers): flexbox axes, padding and
borders, styled runs, overlays, hit regions.

The **catalog components** sit above them and are purely semantic. `Checkbox()`
does not compose glyphs or markup; it emits a `ui:checkbox` node carrying
`checked`, `label`, and `onChange`, and says nothing about presentation:

```ts no_run
import { Checkbox } from 'fino:ui/components';

Checkbox({ checked: true, label: 'Ship it' });
// → { type: 'ui:checkbox', props: { checked: true, label: 'Ship it' } }
```

The catalog covers forms (`Button`, `IconButton`, `Checkbox`, `Radio`,
`RadioGroup`, `Switch`, `TextInput`, `TextArea`, `NumberInput`, `Slider`,
`Select`, `ComboBox`, `Field`, `Fieldset`), disclosure (`Expander`, `Details`,
`Tabs`, `TabList`, `Accordion`), menus (`MenuList`, `MenuRow`, `MenuHeader`,
`MenuSeparator`), overlays (`Modal`, `ContextMenu`, `Popover`, `Tooltip`,
`Toast`, `ToastStack`), status (`Badge`, `Tag`, `TagGroup`, `Spinner`,
`ProgressBar`, `KeyHint`, `Timeline`), navigation (`Breadcrumbs`,
`Pagination`, `Steps`), typography (`Heading`, `Bold`, `Italic`, `Link`,
`Blockquote`, `List`, `Code`, `InlineCode`), and data (`Panel`, `Table`,
`FileTree`, `Icon`, `VirtualList`).

## The tree is purely semantic

The core rule: **the tree is purely semantic; render targets own all
presentation.**

In the terminal, `fino:tty/tui` runs `internal:tty/lower` over every tree
before layout: `ui:checkbox` lowers to the `[x]` glyph-and-box composition the
layout engine paints, `ui:button` to a bracketed `Clickable`, `ui:progress` to
a filled bar, with handlers forwarded onto the lowered nodes. On the web,
`fino:ui/components/html` lowers the same nodes to native markup — a real
`<input type="checkbox">`, `ui:details` a `<details><summary>`, `ui:select` a
`<select>` — so checkboxes toggle and sections expand with zero client
JavaScript. Pass `toHtml()` an `actions` collector and handler-bearing nodes
become server-driven forms instead of static markup.

Because no presentation rides in the tree, a component never branches on where
it is running, and a new render target means one new lowering — not a new
component library. Color is semantic too: components reference the `styles`
tokens from `fino:ui/components/theme` (`accent`, `muted`, `danger`, …), the
terminal resolves them to SGR through `fino:tty/style`, and HTML maps the same
fields onto CSS custom properties.

## State lives outside the tree

Components take values and change callbacks — never internal state. A
component function is called fresh every pass, so it cannot hold anything
across renders; what must survive lives in signals beside the tree, created by
the state helpers:

- `createDisclosure()` — open/closed state for `Details`, `Modal`, `Select`,
  and menus.
- `createTextField()` — value, caret, and selection for `TextInput`, with the
  `applyTextEdit` reducer behind an `apply(event)` method.
- `createTextArea()` — the same shape for `TextArea`, behind `applyTextAreaEdit`
  (see "Form controls" for why it is a separate reducer).
- `createAccordion(single)` — open keys for `Accordion`; `single` closes other
  sections on toggle.
- `createTreeState()` — expanded keys for `FileTree`.
- `ListSelection` — a selection model for menu lists: a selected key,
  header-skipping movement, and a scroll window that follows the selection.
- `VirtualScroll` — a scroll model for lists too large to render whole;
  `window()` yields the slice worth building nodes for, and `VirtualList`
  renders it with spacers standing in for everything excluded.

```ts no_run
/** @jsxImportSource fino:ui */
import { Details, TextInput, createDisclosure, createTextField } from 'fino:ui/components';

const advanced = createDisclosure();
const token = createTextField('');

const view = () => (
  <Details title="Advanced" open={advanced.open.get()} onToggle={advanced.set}>
    <TextInput
      value={token.value.get()}
      caret={token.caret.get()}
      selection={token.selection.get()}
      onChange={token.set}
    />
  </Details>
);
```

`TextInput` is the pattern in miniature: the render target maintains the edit —
typed characters, backspace, word jumps, selection — and reports the new state
through `onChange`, which pairs exactly with `createTextField().set`. The
component renders whatever the signals hold; nothing is buffered inside it.

## Focus

Focus follows the same split. The render target owns focus *state*: the
terminal dispatcher tracks it by node `id`, Tab and Shift-Tab traverse
focusables in document order, a mouse press focuses the nearest focusable
ancestor, and Enter or Space activates the focused node. (`Clickable` is
focusable by default; pass `focusable: false` to opt out.) Focus *appearance*
is rendered from the `focused` prop — a control paints focused if and only if
the app passes it.

The app wires the two together by reading its target's focus signal into the
prop. A live terminal app exposes it as `app.focus.focusedId`, alongside
`next()`, `prev()`, `focus(id)`, and `blur()`; the first paint happens before
`render()` returns, so the view guards its read:

```ts no_run
let app: TuiApp;
const view = () => {
  const focused = app === undefined ? null : app.focus.focusedId.get();
  return <Button id="save" label="Save" focused={focused === 'save'} onClick={save} />;
};
app = render(view, { input: true });
```

The HTML target ignores `focused` entirely — the browser owns real focus, and
native `<input>` elements already render it.

## Form controls

`Field` wraps a control with a label, an optional dim `hint`, and an optional
`error` line; `required` adds a red `*` after the label. `Field` never owns
the control — it takes it as `children` — so on the web it wires
accessibility onto whatever native form element it finds inside: `error`
turns into `role="alert"` on the error line plus `aria-invalid` and
`aria-describedby` injected onto the first `<input>`/`<select>`/`<textarea>`
among the children. Give it `htmlFor` (naming the control's own `id`) for an
explicit `<label for>` pairing, or leave it out and the `<label>` wraps the
control instead — natively associated with no `for` needed:

```ts no_run
/** @jsxImportSource fino:ui */
import { Field, TextInput } from 'fino:ui/components';

const view = () => (
  <Field label="Email" hint="We only use this for release notes." required>
    <TextInput value="" onChange={() => {}} />
  </Field>
);
```

`Fieldset` groups fields under a `legend` — a bordered box with the legend
set into the border in the terminal (the same `borderTitle` mechanism as
`Panel`), a real `<fieldset><legend>` on the web.

`NumberInput` and `Slider` are both draggable/steppable numeric controls, and
both lower to native `<input type="number">`/`<input type="range">` on the
web — dragging and the native spinner arrows come for free there. In the
terminal, arrow keys step both while focused, and `NumberInput` additionally
gets click targets for its `‹`/`›` affordances. `Slider`'s click-to-position
needed a piece of infrastructure neither the primitives nor the dispatcher
had: a component has no way to know its own painted screen offset, so a
mouse event's `x`/`y` (frame-absolute) can't by itself say *where on the
track* a click landed. `UiMouseEvent` (and the dispatcher's
`TuiMouseEventLike`) now also carries `localX`/`localY` — the same
coordinates relative to the deepest hit node's own rect, computed once in
`TuiDispatcher#dispatchMouse` from the same `nodeRect` lookup hit-testing
already uses. It is the terminal-component equivalent of a DOM event's
`offsetX`/`offsetY`, and any future component that needs "where inside me
was this click" can reuse it instead of re-deriving its own screen position.

`TextInput` gained `password`: the terminal paints `•` per character and the
web renders `type="password"`, but in both targets the masking is purely a
paint-time transform — `value` (and every caret/selection index derived from
it) is always the real text, since a mask of matching length keeps the index
math correct without the edit reducer ever seeing it.

`TextArea` is multi-line editing, and it gets its own reducer,
`applyTextAreaEdit`, rather than an `applyTextEdit` mode flag: Enter inserts a
newline instead of doing nothing (there is no submit key left to reserve),
Home/End move to the current *line's* boundaries instead of the whole value's,
and Up/Down move the caret to the same column on the adjacent line, clamping
short lines — none of which single-line callers should pay for. `createTextArea()`
pairs with it the same way `createTextField()` pairs with `TextInput`. An
explicit `onSubmit` still exists for an app-chosen combination like
ctrl+enter; the web target has no native gesture for it (a `<textarea>` in a
`<form>` never submits on Enter), so it only ever fires from the terminal.

`ComboBox` is a text input that filters a list as you type. The default
filter (`defaultComboBoxFilter`) is a case-insensitive substring match over
each option's `label`; pass `filter` to replace it entirely. Reaching for the
existing `Select`-anchoring pattern (`Layer anchorId` in the terminal, the
same popover shape on the web) turned up one prop `Select` gets for free that
`ComboBox` needs to ask for explicitly: `Select`'s `value` *is* the picked
option's key, so it doubles as the row to highlight while browsing with arrow
keys. `ComboBox`'s `value` is free-typed text, not a key, so browsing needs
its own piece of state — `activeKey`/`onActiveChange` — held by the caller
like every other piece of catalog state. On the web, `ComboBox` deliberately
does not use `<datalist>` (too limited — no control over filtering, no rich
rows) or `<select>` (wrong interaction model for free text); it reuses the
same `.ui-popover`/`.ui-menu` markup `Popover` and `ContextMenu` already
established, so the three overlays look and behave alike.

`IconButton` is an icon-only click target: `label` is the accessible name,
never visible text, so on the web it becomes a `<button aria-label>` around
an `aria-hidden` icon span — nothing for a screen reader to read twice.

## Icons

Icons are registry entries, not glyphs in the tree. `ICONS` maps semantic
names (`folder`, `code`, `lock`, …) to per-target forms — a monochrome
width-1 glyph for the terminal, an emoji for the web — and each render target
picks its own column via `iconForm(name, target)`:

```ts no_run
import { Icon, iconForm } from 'fino:ui/components';

Icon({ name: 'folder' });          // ui:icon — the target chooses the form
iconForm('folder', 'tui');         // '▸'
iconForm('folder', 'html');        // '📁'
```

Both `Icon` and `iconForm` accept an `overrides` table layered over the
registry, and unknown names fall back to the `file` icon. `FileTree` builds on
the same registry: `fileIcon` resolves each node's icon name — an explicit
`icon` wins, directories get the folder icons (which double as the expander),
and file extensions map through `FILE_ICONS`.

## Typography

`Heading`, `Bold`, `Italic`, `Link`, `Blockquote`, `List`, `Code`, and
`InlineCode` round out the catalog for prose content. They follow the same
rule as everything else — the tree carries data, not glyphs:

```ts no_run
import { Heading, List, Code } from 'fino:ui/components';

Heading({ level: 1, children: 'Release notes' });
List({ items: ['Clone the repo', 'Install dependencies'] });
Code({ code: 'const x = 1;', language: 'ts', showLineNumbers: true });
```

`Bold`, `Italic`, `Link`, and `InlineCode` are inline, but the terminal's
`Text` primitive is a flattening leaf — it renders everything beneath it as
one plain, single-styled run (`childText()` in `internal:tty/layout`
concatenates descendant text and ignores any styling on nested nodes). So
mixing them *inside* a `Text` (`<Text>plain <Bold>bold</Bold></Text>`)
silently drops the nested styling in the terminal, even though the same tree
renders correctly nested on the web. Compose mixed inline runs as **row
siblings** instead — `<HStack gap={0}><Text>plain </Text><Bold>bold</Bold></HStack>`
— which both targets render correctly; the gallery's Typography stories use
this pattern throughout.

`List` takes its rows as `items: Child[]` rather than a `ListItem` child
component — an entry can be a plain string or a nested tree (`Text` runs,
`InlineCode`, anything), and both render targets lower the array directly:
`•`/`1.` markers with a hanging indent in the terminal, a real `<ul>`/`<ol>`
of `<li>`s on the web.

`Blockquote` gives every child its own `│` gutter row in the terminal —
pass one line per child (as the gallery story does) and each carries the
gutter, matching Markdown's `>` on every quoted line. A single child that
word-wraps internally only gets one gutter for that block, since how many
rows it wraps to is decided by layout, after the terminal composer has
already run. The web target doesn't share this limit: `<blockquote>`'s CSS
left border spans wrapped content automatically.

`Code` reuses `fino:format/typescript`'s OXC-backed tokenizer
(`highlightLines`) instead of shipping a highlighter of its own. The terminal
paints tokens through the same `styles` tone tokens as the rest of the
catalog (`accent` for keywords, `success` for strings, `info` for numbers,
`muted` for comments, `warning` for regexes), and the web emits matching
`tok-*` classes. Languages outside the JS/TS/JSX family — or an omitted
`language` — render as plain monospace text; there's no attempt to guess a
highlighter for a language the parser can't lex.

`Code` optionally gets a header bar: `filename` shows it, `copyable` adds a
copy affordance, and either alone still gives the bar a home (an empty label,
a right-aligned copy button) rather than leaving `copyable` nowhere to live.
In the terminal that bar is a dim row followed by a rule — always visible,
never hover-revealed, since the terminal has no hover here (mouse tracking is
button-event only, not motion). Its copy button cannot write to the
terminal's clipboard itself — a lowering only emits nodes, it performs no
effects — so it calls `onCopy`, which the app wires to whatever it wants,
typically `fino:tty/tui`'s `copyToClipboard` (an OSC 52 clipboard-set
request). On the web the bar is a `<figcaption>` above the `<pre><code>`
inside a `<figure>`, and the copy button copies client-side — the Clipboard
API needs a user gesture, so a server round trip could never drive it — via a
`[data-fi-copy]` delegated listener in `internal:ui/web/client` that reads
the sibling `<code>` element's `textContent` (rather than duplicating the
source into a `data-*` attribute) and calls `navigator.clipboard.writeText`.
It is hidden by default and revealed with plain CSS on `:hover`/
`:focus-within`, never `display:none`, so it stays reachable by keyboard
regardless of hover state.

`Link` is the one catalog component allowed to navigate. Its behavior
switches on which prop is set: `href` alone renders a real `<a href>` on the
web, and `onActivate` alone renders an in-app activator on both targets — a
link-styled button wired through the HTML action collector, a focusable
`Clickable` in the terminal. Passing both keeps `href` as the anchor's target,
but the handler intercepts the click and submits the action form instead of
navigating.

Terminal hyperlinks (OSC 8: `` \x1b]8;;URL\x1b\text\x1b]8;;\x1b\ ``) were the
original design for the `href`-only case, but they can't survive today's
frame pipeline: any escape byte in `Text` content routes through
`fino:tty/frame`'s `parseAnsi`, which intentionally discards non-SGR
sequences — OSC included — to keep `Segment` text free of embedded control
codes (see `frame.ts`'s module docs). Threading OSC 8 through cleanly would
mean teaching `Segment`/`Row` about a new kind of non-printable payload,
which is a frame-model change out of scope for a component lowering. An
`href`-only `Link` therefore renders as styled, underlined, non-interactive
text in the terminal rather than a real clickable hyperlink — reach for
`onActivate` when the terminal needs to *do* something on activation.

`href` is app-controlled data — chat messages, agent output, file metadata —
so the HTML target validates it before it ever reaches an `<a>`: `safeHref`
in `fino:ui/components/html` strips ASCII control characters (closing off the
`java\tscript:` bypass), then allows only `http:`, `https:`, `mailto:`,
`tel:`, and relative forms (`/…`, `./…`, `../…`, `#…`, `?…`). Anything else —
`javascript:`, `data:`, `vbscript:`, unknown schemes — is dropped; the link
still renders its text and styling, just without an `href` attribute, so it
degrades to inert rather than becoming an XSS vector.

## Seeing both targets

`fino:ui/gallery` is the catalog's storybook, and it is dual-target by
construction: the same story trees drive a live terminal gallery and an
HTML gallery served over HTTP, so a component that renders sensibly in one
target and not the other is a bug you can see.

```sh
fino gallery                    # built-in catalog stories, in the terminal
fino gallery stories.tsx        # your components, in the terminal
fino gallery --html --port 4000 # serve the same stories to a browser
```

A stories module default-exports `StoryGroup[]`; each story is a named view
function with optional controls, adjustable live in either target. The runners
are importable directly as `runGalleryTui()` and `runGalleryHtml()`.

Tests cover both targets without a browser or a real terminal session.
`renderFrame()` from `fino:tty/tui` paints any tree to a deterministic string,
and `renderToHtml(toHtml(view()))` produces the web markup for the same tree.
For full interaction — focus traversal, modals, text editing — `fino:test/pty`
drives the real thing:

```ts no_run
import { openPty } from 'fino:test/pty';
import { execPath } from 'fino:process';

const pty = await openPty(execPath, ['app.ts'], { cols: 90, rows: 26 });
await pty.waitFor((term) => term.text().some((line) => line.includes('[ Save ]')));
await pty.sendKey('tab');
await pty.sendKey('enter');
await pty.close();
```

## A worked example

A small form, composed once and rendered in both targets. State lives in
helpers beside the tree; every control reports changes through callbacks; the
tree stays semantic throughout:

```ts no_run
/** @jsxImportSource fino:ui */
import { createSignal } from 'fino:ui';
import {
  Button,
  Checkbox,
  Panel,
  RadioGroup,
  TextInput,
  VStack,
  createTextField,
} from 'fino:ui/components';
import { render, type TuiApp } from 'fino:tty/tui';

const name = createTextField('');
const plan = createSignal('hobby');
const updates = createSignal(false);

function submit(): void {
  console.log(name.value.get(), plan.get(), updates.get());
}

let app: TuiApp;
const form = () => {
  const focused = app === undefined ? null : app.focus.focusedId.get();
  return (
    <Panel title="Sign up" width={40}>
      <VStack gap={1}>
        <TextInput
          id="name"
          placeholder="Name"
          value={name.value.get()}
          caret={name.caret.get()}
          selection={name.selection.get()}
          focused={focused === 'name'}
          onChange={name.set}
        />
        <RadioGroup
          id="plan"
          value={plan.get()}
          options={[
            { key: 'hobby', label: 'Hobby' },
            { key: 'team', label: 'Team' },
          ]}
          onChange={(key) => plan.set(key)}
        />
        <Checkbox
          id="updates"
          checked={updates.get()}
          label="Email me updates"
          focused={focused === 'updates'}
          onChange={(next) => updates.set(next)}
        />
        <Button id="create" label="Create account" focused={focused === 'create'} onClick={submit} />
      </VStack>
    </Panel>
  );
};

app = render(form, { input: true });
```

The same `form()` becomes a web page without touching a component:

```ts no_run
import { htmlPage, toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';

const page = htmlPage(renderToHtml(toHtml(form())), { title: 'Sign up' });
```

Static markup drops the handlers; pass `toHtml(form(), { actions })` and each
handler-bearing control becomes a form the server round-trips instead. Either
way, what crossed the boundary was data — the same portable contract as every
other `fino:ui` tree.
