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

The catalog covers forms (`Button`, `Checkbox`, `Radio`, `RadioGroup`,
`Switch`, `TextInput`, `Select`), disclosure (`Expander`, `Details`, `Tabs`,
`TabList`, `Accordion`), menus (`MenuList`, `MenuRow`, `MenuHeader`,
`MenuSeparator`), overlays (`Modal`, `ContextMenu`, `Popover`, `Tooltip`,
`Toast`, `ToastStack`), status (`Badge`, `Tag`, `TagGroup`, `Spinner`,
`ProgressBar`, `KeyHint`, `Timeline`), navigation (`Breadcrumbs`,
`Pagination`, `Steps`), and data (`Panel`, `Table`, `FileTree`, `Icon`,
`VirtualList`).

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
