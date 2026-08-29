---
weight: 40
---

# Components and Render Programs

Fino has one component model. A component is a synchronous function from props
to a tree, and it does not know or care where it runs, what its output becomes,
or how long it lives. Those are decisions the surrounding *render program*
makes, and the same component serves a terminal app, a static HTML build, a
server-driven page, and a browser.

```ts no_run
/** @jsxImportSource fino:ui */
export default function Greeting(props: { name: string }) {
  return <p>Hello {props.name}</p>;
}
```

## Two axes

A render program is a `Sink` plus a lifetime.

A **sink** decides what a committed tree becomes. `htmlSink()` serializes to
HTML text, `portableSink()` converts to transferable JSON, `frameSink()` in
`fino:tty/tui` paints a terminal frame, and `hostSink()` wraps a `HostAdapter`
so a mutable node graph like the DOM participates on the same footing.

The **lifetime** is either one pass or many. `renderStatic()` renders once,
commits, and disposes. `createRoot()` keeps rendering: every signal read during
a pass becomes a dependency, so a later write re-renders and commits again.

```ts no_run
import { createRoot, renderStatic } from 'fino:ui';
import { htmlSink } from 'fino:ui/html';

const once = renderStatic(App, htmlSink());

const live = createRoot(App, htmlSink());
live.subscribe((html) => publish(html));
live.dispose();
```

Those two choices are independent. Any sink works with either lifetime, which is
why adding a host does not mean reimplementing reactivity, and why making
something live does not mean rewriting its output path.

## Components run when a target lowers them

`h()` does not call a component. It stores the function as the node's `type`,
and the component runs later, during `lowerTree(tree, target)` — which is what
a sink does on commit. The delay is the point: between building the tree and
running a component there is a moment where the render target is known, and
that is the moment a target gets to substitute its own version of that
component.

```ts no_run
import { mapRenderTargetLowering } from 'fino:ui';

using checkbox = mapRenderTargetLowering(Checkbox, 'tui', TuiCheckbox);
using article = mapRenderTargetLowering('article', 'tui', TuiArticle);
```

Registration is deliberately not the component author's privilege. The map is
keyed on the function itself, so a render target can lower components it did
not write and cannot modify — which is how a target is added without editing
the components it renders. A string key matches a host element name instead, so
a target can catch elements generically rather than specialising every
component that emits one. The last active registration for a pair wins, so an
application can override either. Each registration is disposable: removing a
temporary override restores the previous mapping, including when independent
registrations are disposed out of order.

Lowering repeats until nothing is left but the target's own primitives, which
each target declares with `defineRenderTarget()`. A component that only
composes other components therefore needs no registration at all and runs
anywhere; only the leaves, where meaning becomes real output, need a target to
say anything. A node that reaches a target with no lowering and no place in its
floor raises `RenderTargetError` naming both, rather than rendering nothing.

Calling a component directly (`Greeting({ name: 'fino' })`) still works and
simply bypasses the registry.

## State is never a component's job

Components do no asynchronous work. There is no `await` in a render pass and no
suspend protocol, because state that has not arrived yet is not a rendering
problem — it is a signal that has not been set yet.

```ts no_run
import { createSignal } from 'fino:signals';

const rows = createSignal<Row[]>([]);
void loadRows().then((loaded) => rows.set(loaded));

function Table() {
  return h('table', null, rows.get().map(renderRow));
}
```

Under `createRoot()` that component renders empty, then re-renders when the load
resolves. Under `renderStatic()` it renders whatever `rows` holds right now, and
a signal *write* during the pass throws `StaticRenderError` — a one-shot render
has nowhere to publish a revision, so output that disagrees with its own state
is reported rather than shipped.

## Rendering somewhere else

`fino:ui/realm` is the third option, and it is how asynchronous data becomes
static output without any component changing.

A component rendered in a child realm republishes its tree on every revision.
The realm's event loop decides when there is nothing left to do, and draining is
completion: the last tree published before the child exits is the answer.

```ts no_run
import { renderRealm } from 'fino:ui/realm';
import { renderToHtml } from 'fino:ui/html';

const tree = await renderRealm('./report.tsx', { props: { period: '2026-Q1' } });
await write('report.html', renderToHtml(tree));
```

Realms are held open by pending work rather than by an open port, so a rendering
child cannot idle waiting to be asked for more. Render a batch in one run
instead — one isolate, shared data sent once, a tree per item:

```ts no_run
import { renderRealmAll } from 'fino:ui/realm';

const trees = await renderRealmAll('./theme.tsx', {
  shared: { site },
  items: pages.map((page) => ({ page })),
});
```

## Portability is the contract

A tree that leaves the isolate that built it must be data. `fino:ui/portable`
defines that subset and enforces it at the boundary: functions, class instances,
and cycles are rejected with the offending property path named, rather than
failing later as an opaque clone error.

```ts no_run
import { toPortable } from 'fino:ui/portable';

toPortable(h('div', { onClick: () => {} }));
// PortableValueError: Portable UI values must be JSON data at tree.props.onClick
```

`undefined` follows JSON rules — an `undefined` prop is omitted, since a prop set
to `undefined` and one never set are the same absent prop.

Pre-rendered markup is an ordinary node rather than a special case, so it
crosses boundaries like anything else and each host sets its own policy:

```ts no_run
import { rawHtml } from 'fino:ui/html';

const node = rawHtml('<span>ok</span>'); // { type: 'ui:raw', props: { html } }
```

This is what makes a component's location a deployment decision. A theme, a
plugin, or a page template that stays inside the portable contract runs
in-process, in a sandboxed realm, or in a browser without changing.

## Component previews

[`fino:ui/components`](./ui/components.md) provides structural primitives and
semantic components whose trees lower to retained terminal cells or native HTML.
Each component family owns preview descriptors beside its implementation, and
[`fino:ui/preview`](./ui/preview.md) composes those descriptors into both
runners. The catalog therefore exercises production lowerings instead of
maintaining a preview-only rendering layer.

## Choosing

| You want | Use |
|---|---|
| A page, a file, a frame — once | `renderStatic()` + a sink |
| Output that tracks state | `createRoot()` + a sink |
| Untrusted or async-loading components | `renderRealm()` |
| Many pages from one component | `renderRealmAll()` |
| A mutable host (DOM, terminal cells) | `hostSink()` |

See [Server-Driven Web UI](./ui/web.md) for the hypermedia application layer
built on these pieces.
