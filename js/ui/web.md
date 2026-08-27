# Production server-driven UI

`fino:ui/web` is installed as an application layer. A production application
normally composes cookie parsing, HTTP sessions, a durable view store, and the
UI layer in that order:

```ts no_run
import { App, cookies, sessions } from 'fino:net/http/app';
import { transpileFiles } from 'fino:format/typescript';
import { memoryStore, sqliteStore } from 'fino:store';
import { clientScriptPath, page, webUI } from 'fino:ui/web';

const views = await sqliteStore({ path: 'var/app/ui.db', namespace: 'views' });
const app = new App();
const routes = app
  .value('cookies', cookies())
  .value('session', sessions({
    store: memoryStore({ namespace: 'sessions' }),
    keys: [{ id: 'current', secret: process.env.SESSION_SECRET! }],
    ttlMs: 24 * 60 * 60 * 1000,
  }))
  .layer(webUI({
    store: views,
    secret: process.env.UI_CSRF_SECRET!,
    ttlMs: 24 * 60 * 60 * 1000,
  }));

routes.layer(transpileFiles('./client', { prefix: '/client/' }));
```

Use a shared cache or database session store when requests can reach more than
one process. Keep the session key and UI CSRF secret distinct, rotate session
keys by retaining old verification keys, and never use source-code defaults in
production.

Every page that wants browser enhancement must load the content-addressed
client:

```ts no_run
import { h } from 'fino:ui';
import { clientScriptPath, page } from 'fino:ui/web';

routes.get('/').handle(page((ctx) =>
  h('html', null,
    h('body', null, dashboard.mount(ctx)),
    h('script', { src: clientScriptPath(), defer: true }),
  )
));
```

Forms remain ordinary POST forms. Without JavaScript they use
POST-redirect-GET; with the client they send JSON action envelopes and receive
JSON UI events over SSE. The long-lived `/_fino/live` connection carries
checkpoint and cross-tab updates. This is deliberately SSE plus HTTP actions:
it preserves browser reconnect support, normal HTTP semantics, CSRF handling,
and useful no-JavaScript behavior.

## JSON UI protocol

Every SSE response uses one event name, `ui`, with a JSON payload. There is no
HTML-patch variant and no protocol selector in the `Accept` header. The
protocol version lives in the JSON envelope where every client can read and
validate it.

An EventSource opened directly against a page route receives each mounted
view's current semantic snapshot first and remains subscribed for subsequent
updates. This lets a non-HTML client begin with the SSE stream instead of
making a separate HTML request. The browser runtime can still begin with the
HTML response for progressive enhancement, then connects to `/_fino/live`;
that stream also starts with the current semantic snapshot.

The JSON `kind` is one of:

- `render`: a complete host-neutral component tree and monotonic revision.
- `heartbeat`: confirmation that a live stream is connected.
- `navigate`: a page transition after expiry or invalidation.
- `error`: a stable, safe error code and whether recovery is possible.
- `close`: the end of a short-lived action or error stream.

A render tree uses the existing `fino:ui` shape: `type`, JSON `props`,
ordered `children`, and an optional `key`. Give semantic components stable,
versioned names such as `app.counter.v1`. Each client keeps its own map from
those names to HTML, TUI, SwiftUI, Jetpack, or another native implementation.
That registry is client-owned; the server neither knows nor stores platform
implementations. Unknown component names should fail explicitly in the client
so contract drift is visible.

The bundled browser adapter exposes its client-owned registry as
`globalThis.finoUI.register(name, implementation)`. An implementation receives
the component's JSON props, rendered child DOM nodes, and protocol node, then
returns a DOM node. Standard HTML element names are built in:

```js
finoUI.register('app.counter.v1', (props, children) => {
  const output = document.createElement('output');
  output.textContent = String(props.count);
  output.append(...children);
  return output;
});
```

Version 1 sends complete trees. `key` and `type` are the identity information a
client uses to reconcile against the previous tree, preserving component
identity and avoiding recreation of unchanged host nodes. Platform interaction
state such as focus, scroll position, text composition, gestures, and animation
is client-local and is never round-tripped through view snapshots.

The bundled browser adapter reconciles rather than replacing. An unchanged
render performs no DOM mutations, keyed children are moved instead of rebuilt,
and only props that actually changed are written. Because props are diffed, a
value the server did not change is never written back over what someone is
typing; a value the server *did* change still wins. Focus, selection, and
scroll position are restored if reordering detached the active element.

Registered components are opaque to the reconciler: an instance is reused
untouched while its props and children are unchanged, and rebuilt when they
change. Add `data-fi-preserve` to an element to stop reconciliation at that
boundary and keep whatever the page has put inside it.

The adapter dispatches these events on `globalThis` so a page can react without
owning the transport:

- `fino-ui-render`: `{ viewId, revision }` after a tree is applied.
- `fino-ui-heartbeat`: a live stream is still connected.
- `fino-ui-error`: `{ code, recoverable, retry }`. `retry` re-sends the last
  action when one is available.
- `fino-ui-online` / `fino-ui-offline`: live-stream connectivity changed. A
  reconnect restarts with a full snapshot and resynchronizes through the same
  reconciliation path, so local interaction state survives.

While an enhanced action is in flight its form carries `aria-busy="true"` and a
`data-fi-busy` attribute, its submit controls are disabled, and repeat submits
are ignored. Set `confirm` on an action descriptor to require confirmation
before the request is sent. `finoUI.applyUi(event)` applies a single protocol
event directly, which is the seam used to drive the adapter from tests or a
custom embedding.

Action props are serialized as `PortableActionRef` objects. POST
`application/json` to the supplied `url` while retaining the authenticated
session cookie:

```json
{
  "version": 1,
  "view": "view_...",
  "revision": 4,
  "request": "render_...",
  "input": {
    "amount": 1
  }
}
```

Declare an `input` JSON schema on the action when it accepts client data.
Validation runs before the handler. JSON action bodies default to a 64 KiB
limit, configurable with `maxActionBytes`. Posting `application/json` selects
the JSON action envelope and always returns an SSE UI response; no custom
`Accept` parameter is needed. Action responses and live updates use the same
event schema.

## Derived state

A view whose data already lives in another durable store should not copy it into
the view snapshot. List those signal keys in `derived` and they are rendered but
never persisted, so the other store stays the only durable copy:

```ts
view({
  id: 'run-view',
  derived: ['run'],
  state: () => ({ runId: new Signal(''), run: new Signal(null) }),
  async derive({ state }) {
    state.run.set(await runs.load(state.runId.get() as string));
  },
  render: ({ state }) => renderRun(state.run.get()),
});
```

`derive` runs before the action and live-stream renders, both of which are
already async. `mount()` is synchronous and cannot await it, so pass initial
values as `view.mount(ctx, { runId, run })` from a handler that loaded them
first. `fino:ui/web/flow` is built this way.

## Action errors

An action handler that throws is reported as `action_failed` with its details
published only to `fino:ui/action:error`. Throw a `ViewActionError` to choose a
stable public code instead:

```ts
import { ViewActionError } from 'fino:ui/web';

throw new ViewActionError('flow_stale_step', { status: 409, recoverable: true });
```

Enhanced clients receive it as an `error` UI event with that code; the
no-JavaScript path receives the code as the response body with that status.
Nothing else about the thrown value is exposed.

Long-running actions can call and await `checkpoint()` after changing their
signals. Each checkpoint is compare-and-swap persisted and published to live
tabs:

```ts no_run
actions: {
  run: {
    async handler({ state, checkpoint }) {
      for await (const chunk of work()) {
        state.output.set((text) => text + chunk);
        await checkpoint();
      }
    },
  },
}
```

`webUI()` sweeps expired snapshots at most once per minute by default. Set
`sweepIntervalMs: false` when an external scheduler owns cleanup. Observe
`fino:ui/sweep` for deletion counts and durations and
`fino:ui/sweep:error` for failures. Cancelling an SSE response disposes its
topic subscriptions.

For browser TypeScript, mount `transpileFiles()` under a narrow prefix and
keep server-only source outside that root. It transpiles on request; it is not
a bundler and does not expose npm packages or server credentials to the
browser.

## Troubleshooting

- `page() requires webUI() middleware`: mount the `webUI()` layer before the
  route.
- `403 Forbidden` on actions: preserve both the session and `fi_csrf`
  cookies; check the request `Origin` and `Sec-Fetch-Site`.
- `409 Conflict`: the form used a stale snapshot. Reload it, or mark only
  operations that are safe to replay as `stale: 'rebase'`.
- `410 Gone` or a live `navigate` event: the snapshot expired or cleanup ran;
  render a fresh page.
- No updates: load `clientScriptPath()`, verify `/_fino/live` is not buffered
  by the reverse proxy, and allow `text/event-stream` responses to remain
  open.
