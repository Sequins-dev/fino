# Server-Driven UI — `fino:ui/web` Design

> Status: design iteration, pre-implementation. Expands
> `application-surface.md` §7 ("the frontend layer") into a concrete
> framework design. Inspired by the data-star.dev / LiveView / Hotwire
> school: the server renders HTML, a tiny static client runtime interprets
> declarative attributes, and the server pushes HTML fragments over SSE
> that selectively morph DOM elements by id. Nothing here is committed;
> the point of this doc is to iterate on the shape before building it.
> Runtime read-model signals now exist across sessions, jobs, pools,
> workflows, MCP, metrics, and process stats so live regions can render
> current runtime state with minimal glue.

## 1. Thesis

An agent product is not done until a person can watch tokens stream into a
browser, and the target remains *the UI for the app you just wrote in one
file* — not a React/Next competitor, not a bundler, not an islands
framework. The proposal is a hypermedia framework where the component tree
lives on the server, interactivity is server actions plus DOM patches over
SSE, and every interactive element is a real link or form so that with JS
disabled the whole thing degrades to full-page loads.

fino is unusually equipped for this school: realtime transports are
native, `fino:ui` already owns VNodes and signals host-neutrally,
`fino:workflow` already implements durable checkpoint/rehydrate state, and
the no-bundler constraint is a feature — the client runtime is one static
file baked into the binary, and user TypeScript reaches the browser
through transpile-on-demand middleware.

The interesting part — and the reason this doc exists — is the state
model.

## 2. The state question

Conventional wisdom says servers should be stateless. That wisdom is
really about *process affinity*: nothing load-bearing may live only in one
process's memory, so any process can serve any request and restarts lose
nothing. LiveView violates this (the socket process *is* the state, and a
deploy drops it); classic stateless SSR satisfies it by pushing all state
into the database and rebuilding everything per request.

The translation this design commits to:

> **The server is stateless *between* events and stateful *within* an
> event.** Every interaction — page GET, form POST, SSE re-render — is a
> function: `(URL, state carried in the HTML, durable snapshot, app DB) →
> (HTML or patches, next snapshot)`.

State is a *sequence of durable snapshots*, each produced from the last by
one event, with nothing resident in server memory in between. This is
already fino's own discipline — it is exactly the `fino:workflow`
execution model (checkpoint → unwind → rehydrate → continue) applied to
rendering sessions.

The companion question — can the client own state without the app being
JS-oriented — resolves as: **the state lives in the hypermedia.** HTML is
the client-side state container. Values the client owns are serialized
into the rendered document; with JS they ride a data attribute and are
sent back with every fetch, and without JS the *same values* ride hidden
form inputs and round-trip through an ordinary POST. Forms were the
original state round-trip; the framework formalizes it rather than
replacing it.

## 3. Four state layers

The framework makes the taxonomy explicit and prices the API by how much
statefulness each layer adds, so the nudge toward statelessness is
structural rather than documentary:

- **L0 — URL.** Route params and query string are the canonical,
  shareable, bookmarkable state: filters, tabs, pagination, selection. A
  full-page render is a pure function of URL plus app data. Free — it is
  just routing, with typed params via the existing `fino:validate`
  integration in `fino:net/http/app`.

- **L1 — document-embedded signals.** Declared per view, serialized into
  the rendered HTML, sent back with every action request, never stored
  server-side. Ephemeral UI state: input drafts, disclosure toggles,
  optimistic counters. Plain JSON by default (inspectable, data-star
  style); a per-key `sealed` option runs the value through
  `fino:security/cookie` sealing so the client carries but cannot read or
  forge it. Cost: one `embed:` keyword.

- **L2 — durable view snapshots.** Server-owned per-view-instance state,
  too large, sensitive, or server-authoritative to embed: chat
  transcripts, wizard accumulations, working sets, anything an SSE stream
  must re-render after reconnect or restart. Loaded by id at event start,
  mutated, persisted with a version bump, released — zero bytes resident
  between events. Cost: an explicit `state:` factory. Mechanics in §6.

- **L3 — app/domain state.** The app's own database. The framework never
  owns it; its only involvement is an invalidation hook — publish to a
  topic (`fino:context/topic`) after a write and subscribed live views
  re-render.

Decision procedure: shareable → L0; ephemeral and user-visible → L1;
server-owned but view-scoped → L2; durable business data → L3.

## 4. The developer surface

What a complete interactive page looks like — no client code, no build:

```tsx
/** @jsxImportSource fino:ui */
import { App } from 'fino:net/http/app';
import { Signal } from 'fino:ui';
import { webUI, view, page, SqliteViewStore } from 'fino:ui/web';
import * as v from 'fino:validate';

const todos = view({
  id: 'todos',
  state: () => ({
    items: new Signal<Item[]>([]),   // L2 by default: lives in the snapshot store
    draft: new Signal(''),           // L1 via embed: lives in the page itself
  }),
  embed: ['draft'],
  actions: {
    add: {
      input: v.object({ text: v.string() }),
      async handler({ state }, input) {
        state.items.set(list => [...list, { id: newId(), text: input.text }]);
        state.draft.set('');
      },
    },
  },
  render({ state, actions }) {
    return (
      <section id="todos">
        <ul>
          {state.items.get().map(i => <li id={`todo-${i.id}`}>{i.text}</li>)}
        </ul>
        <form action={actions.add}>
          <input name="text" value={state.draft.get()} />
          <button>Add</button>
        </form>
      </section>
    );
  },
});

const app = new App();
app.use(webUI({ store: await SqliteViewStore.open('./ui.db'), secret: env.SECRET }));
app.get('/', page(ctx => <Layout title="Todos">{todos.mount(ctx)}</Layout>));
await app.listen({ port: 3000 });
```

`<form action={actions.add}>` serializes to a *real* form —
`action="/?_action=todos.add" method="post"` plus hidden `_view`, `_ver`,
`_csrf`, and `$draft` inputs plus the `data-fi-*` attributes the client
runtime enhances. One action definition serves both transports.

Actions dispatch on the *same URL* as the page (`?_action=`) rather than a
dedicated mount, which keeps no-JS semantics obvious and URLs meaningful.

## 5. One click, end to end

**Enhanced path (JS on).** The client runtime — event delegation on
`document`, so it survives every morph with zero re-initialization —
intercepts the submit and POSTs FormData plus the embedded-signal values,
with `accept: text/event-stream`. The middleware verifies CSRF (sealed
double-submit cookie plus `Sec-Fetch-Site`/`Origin`), takes a per-viewId
async mutex, and loads the snapshot. **Hydration** calls the view's
`state()` factory for fresh `Signal` objects, sets L1 keys from the
request and L2 keys from the snapshot, and subscribes to every signal for
the duration of the event purely to record which keys change — the
explicit-subscription substitute for dependency tracking, which `fino:ui`
deliberately does not have. The handler runs inside `batch()`.
**Persistence** reads the L2 signals back into the snapshot, bumps the
version, and compare-and-swap saves. **Re-render and diff**: the view's
regions re-render; each region's HTML is hashed and compared against
hashes *stored in the snapshot* — patch minimization with zero server
memory, correct across restarts and node hops. The response is a
short-lived SSE stream of `patch` events; the client morphs each target by
id and the stream closes. After the response the server holds nothing.

**No-JS path.** The same POST arrives without the header. Same middleware,
same hydration (embedded signals arrived as hidden `$`-prefixed inputs),
same handler. The response is `303 See Other` — classic POST-redirect-GET
— and the browser GETs a full page rendered from URL plus snapshot.
Refresh-safe, back-button-safe, behaviorally identical.

**Server push (opt-in).** A page with live views opens one `EventSource`.
The connection holds no state — only topic subscriptions
(`fino:ui/view:{viewId}` plus any declared `watch:` topics) and the SSE
writer. Any writer — another tab, an action, a workflow checkpoint —
publishes; the server reloads the snapshot, re-renders, hash-diffs, and
pushes patches. Cross-tab sync falls out for free.

**Reconnect and restart.** SSE event ids carry the snapshot version, so
the client reconnects with `Last-Event-ID`. Version matches → resume
silently; behind → re-render, diff against stored hashes, push exactly
what was missed; snapshot expired → a `navigate` event triggers a full
page load, which legitimately reconstructs everything from L0. *Reconnect
is not a special case — it is just another event.* A mid-stream agent
answer survives a process kill, which LiveView and Hotwire cannot say.

## 6. Snapshot mechanics (L2)

The store contract mirrors `WorkflowStore` (`js/workflow.ts:113`) rather
than reusing the HTTP app's revisioned session cache: a session is per-browser
identity with cookie custody; a snapshot is per-*view-instance* with page
custody, versioning, and TTL. Conflating them breaks multi-tab.

```ts
interface ViewSnapshot {
  viewId: string;                     // random, embedded in the page
  view: string;                       // view definition id
  version: number;                    // monotonic; CAS token; SSE event id
  sessionId?: string;                 // owning auth session, verified per event
  data: Record<string, unknown>;      // L2 signal values (JSON)
  regions: Record<string, string>;    // hash of last-rendered HTML per region
  applied: Array<{ rid: string; action: string }>;  // idempotency ring (~16)
  createdAt: number; updatedAt: number; expiresAt: number;
}

interface ViewStateStore {
  load(viewId: string): Promise<ViewSnapshot | null>;
  save(snap: ViewSnapshot, opts?: { expectVersion?: number }): Promise<void>; // CAS
  history(viewId: string, opts?: { limit?: number }): Promise<ViewSnapshot[]>;
  delete(viewId: string): Promise<void>;
  sweep(now?: number): Promise<number>;   // TTL eviction; history deleted with head
}
```

`SqliteViewStore` clones the `SqliteWorkflowStore` pattern (JSON in a TEXT
column) with a head table plus a history table. **Full history is kept**:
every version retained until the snapshot's TTL sweep, enabling
time-travel debugging and rebase-against-any-version; a per-view
`history: { max?: number }` caps growth for long-lived keyed views. The
interface is deliberately KV-shaped so local `fino:cache` can back single-node
state, while distributed `fino:kv` can back replicated cross-node view state
when that service lands.

- **Multi-tab.** Every full GET mints a fresh `viewId`, so two tabs are
  two independent instances that never fight. A leaked viewId is useless
  without the owning session cookie — `sessionId` is verified per event.
  Views that *want* cross-tab sharing declare `key: (ctx) => string`;
  the framework derives `viewId = hash(sessionId, view.id, key)` and tabs
  converge on one snapshot, mediated by versioning plus topic pushes.
- **Stale actions** (back button, stale tab): an action carrying
  `_ver < head.version` follows the action's policy — `'reject'` by
  default (409 → the enhanced client replaces the whole view with a fresh
  render; no-JS gets PRG to a fresh GET) or explicit `'rebase'` (re-run
  the handler against head state; safe only for handlers that are
  event-shaped mutations rather than diffs).
- **Double-submit.** Each render embeds a per-render nonce; a replayed
  nonce found in the snapshot's idempotency ring short-circuits to the
  redirect or a no-op patch without re-running the handler.
- **Serialization.** L2 values must be JSON-serializable; `save` validates
  and throws naming the offending key — no silent corruption.

### The live/persistent split

An open SSE connection *could* hold live hydrated signals LiveView-style.
The design says no, for v1: the snapshot is in-process sqlite, a load is
microseconds against a network flush, and because rendered-region hashes
are snapshot-persisted even patch minimization needs no connection memory.
The hybrid — in-memory signals as pure cache, snapshot as source of truth,
topic-bus invalidation from any writer — is the designed v2 escape hatch
if per-event hydration ever shows up in profiles; write-through is already
forced (persist before flush), so adding the cache later is invisible.

Multi-node honesty: v1 liveness is single-process — the topic bus is
in-process and the stores are one sqlite file. *Correctness* is already
multi-node-safe (any node can serve any event given a shared store);
cross-node invalidation of open SSE streams awaits a distributed topic
bridge, and the `topic()` named-registry indirection means that bridge
slots in without framework changes.

## 7. Where workflows come in — and where they don't

**Rejected: every UI session as a workflow run.** The tempting shape —
`while (true) { const ev = await ctx.waitForSignal('ui'); … }` with every
click a `Workflow.signal` — does not survive contact with
`js/workflow.ts`: resume replays the run function from the top past all
checkpointed steps, so a session gains one step per click, `steps[]` grows
unboundedly, every save rewrites the whole JSON row, replay is O(n) per
click (O(n²) per session), and there is no continue-as-new. Per-click
state belongs in the snapshot store of §6, which is *workflow-shaped
persistence without replay*. (If `continue-as-new` ever lands in
`fino:workflow` for its own reasons, this tier becomes honest for bounded
windows — but it still buys nothing over snapshots for plain UI state.)

**`flowPage()` — bounded multi-step flows.** Wizards, checkout,
onboarding, approvals: a bounded number of interactions with real side
effects between them that must not re-run — exactly what
`ctx.step`/`ctx.call` checkpointing exists for — and that must survive
deploys and week-long abandonment.

```tsx
const checkout = workflow({
  id: 'checkout',
  async run(ctx, input: { cartId: string }) {
    const shipping = await ctx.waitForSignal<Address>('shipping');   // form submit #1
    const quote = await ctx.call(quoteShipping, shipping);           // checkpointed effect
    const payment = await ctx.waitForSignal<PaymentInfo>('payment'); // form submit #2
    const charge = await ctx.call(chargeCard, { quote, payment });   // never re-runs
    return { orderId: charge.orderId };
  },
});

app.get('/checkout', flowPage(checkout, {
  store,
  start: ctx => ({ cartId: ctx.session.cartId }),  // no ?run= → start, redirect to ?run={runId}
  inputs: { shipping: addressSchema, payment: paymentSchema },
  render(ctx, state) {                              // pure function of WorkflowState
    switch (state.waitingOn?.name) {
      case 'shipping': return <ShippingForm />;
      case 'payment':  return <PaymentForm quote={state.state.quote} />;
      default:         return state.status === 'done'
        ? <Receipt order={state.result} /> : <Failed error={state.error} />;
    }
  },
}));
```

The **runId in the URL is the entire session mechanism** — shareable,
resumable, deploy-surviving; close the laptop for a week, click the
emailed link, continue. A form submit becomes validate →
`signal({ store, runId, name: state.waitingOn.name, payload })` →
`resume()` (replay is bounded, so cheap) → re-render from the new
`WorkflowState` → PRG or patches per transport. Back-button safety is
inherent: re-submitting an old step's form signals a name the run is not
waiting on, the workflow throws, and the framework re-renders the
*current* step. The card cannot double-charge because `ctx.call` is
checkpointed.

**`observableWorkflowStore()` — workflow-driven views.** The flagship
agent-app case: a long-running workflow (agent run, ingestion, batch job)
whose progress any watching page renders live. The one missing piece of
plumbing is store-write → open-SSE-stream notification, a thin wrapper
over the existing topic bus:

```ts
export function observableWorkflowStore(inner: WorkflowStore): WorkflowStore;
// after inner.save(state):
//   topic(`fino:ui/run:${state.runId}`).publish({ version: state.updatedAt })
```

```tsx
app.get('/runs/:id', page(ctx =>
  runView.mount(ctx, { watch: [`fino:ui/run:${ctx.params.id}`] })
));
```

Each checkpoint → publish → the view's live channel reloads the state,
re-renders, hash-diffs, pushes patches. A human's form submit and an
agent's decision become **the same primitive** — a signal/save against a
durable run hitting the same render path — so a checkout where step 3 is
completed by an agent instead of a person needs zero new machinery. For
lowest latency the *initiating* request's own SSE response can stream
mid-handler (`ctx.stream.patch()` flushes current signal values as patches
immediately — token-by-token agent output), checkpointing to the snapshot
at message granularity while other tabs ride the topic path. The existing
`onCheckpoint` callback covers in-process runs without even the store
wrapper.

## 8. Wire protocol

Own protocol, own client — not data-star wire compatibility. The
no-bundler stance means shipping a client either way, data-star's client
brings an expression language and plugin system this design does not
want, and the needed vocabulary is six events. The tradeoff (forfeiting
their ecosystem and devtools) is mitigated by keeping the event shapes
datastar-like so a compat shim remains possible.

SSE; `event:` is the kind, `data:` is one JSON value — HTML travels inside
JSON strings, which makes framing robust and parsing trivial.

| event | data | client action |
|---|---|---|
| `patch` | `{id, mode, html?}`, mode ∈ `morph\|replace\|inner\|append\|prepend\|before\|after\|remove` | mutate the element with that id |
| `state` | object | merge into embedded signal values; dispatch a `fino:state` CustomEvent |
| `title` | string | set `document.title` |
| `navigate` | `{url, replace?}` | full page load — always safe because state is durable |
| `eval` | JS string | escape hatch; never emitted by the framework itself; CSP caveat documented |
| `close` | `{}` | end of an action stream |

Two interaction shapes share the vocabulary: an action POST whose
*response is* a short-lived SSE stream, and the optional long-lived GET
`EventSource` per page for server push. Event id = snapshot version, which
is what makes `Last-Event-ID` reconnect (§5) work. Heartbeats via SSE
comments; `EventSourceWriter` in `fino:net/http/eventstream` already
provides the framing.

## 9. The client runtime

One zero-dependency TS file (~450 lines), baked into the binary at build
time (build.rs already transpiles per-file; a small addition emits the
transpiled client as an `internal:` source-string module) and served at a
content-hashed `/_fino/client.<hash>.js` with immutable caching.

- **Event delegation** on `document` for submit/click — no scanning,
  survives morphs with zero re-init. Interception only of elements the
  serializer annotated; every element keeps its real `href`/`action`, so
  JS-off degrades by construction.
- **SSE-from-fetch parser** (~70 lines): native `EventSource` is GET-only,
  so action responses are parsed off `res.body` directly.
- **Morph** (idiomorph-lite): attribute sync; children keyed by id,
  positional fallback by tag; the focused input's value/checked are never
  clobbered; `data-fi-preserve` subtrees untouched; focus and scroll
  survive because matched nodes mutate in place. Written against a
  structural node interface so it unit-tests against a small shim — no
  browser in the test loop.
- Conveniences: `data-fi-confirm`, `data-fi-indicator` (busy class during
  in-flight requests).

For the client code an app *does* need, `fino:net/http/transpile` provides
`transpileFiles(root)` — a `staticFiles()`-shaped middleware serving
`.ts` as ES modules via the existing `fino:format/typescript` (OXC) with
an mtime cache. Zero build step in dev and prod.

## 10. Rendering layer notes

- **`fino:ui/html`** is a direct VNode→string serializer, not a
  `HostAdapter`: the server never retains a tree between renders — every
  patch is a fresh region render morphed client-side — so server-side
  reconciliation would maintain a mutable tree purely to re-serialize it.
  `createRenderer` stays untouched for genuinely retained hosts
  (`fino:tty/tui`, a future in-browser host). Escaping reuses
  `escapeHtml` from `fino:template`. Void elements enforced; boolean
  attributes; style objects; function props **throw** with a pointed
  message (the #1 React-refugee confusion, not silently dropped); the raw
  escape hatch is honestly named `rawHtml()`.
- **Region boundaries must be explicit** because `h()` invokes function
  components eagerly (`js/ui.ts:110`) — component boundaries are erased
  from the VNode tree by construction. A region is a thunk plus a stable
  element id (`live.view('cart', () => <Cart …/>)`), which conveniently is
  also the data-star model: patches always target ids.
- **Signal→region mapping** uses render-time read tracking: a one-branch
  ambient `readObserver` hook in `Signal.get()` (the only core `fino:ui`
  touch; subclassing cannot intercept reads of pre-existing signals since
  `#value` is private). Dependencies re-track on every render, so
  conditional reads stay correct.
- **Streaming full-page render is deliberately absent.** `h()` is eager
  and synchronous, so the whole tree exists before serialization begins;
  flush-shell-then-stream would need async components in core. The
  fino-shaped answer: render the fallback synchronously, mark the region,
  and push the real content over the live channel as a patch — late
  content is just another server push.

## 11. What this is not

Not a React/Next competitor, a bundler, or an islands framework — apps
that outgrow the story use the ecosystem. Not client-side routing or
offline-first: navigation is navigation. Not multi-node-live in v1 (§6).
The `eval` event exists as an escape hatch but the framework never emits
it, and apps under strict CSP simply don't use it.

## 12. Why this is differentiated

- **Durability as the default, not an add-on.** LiveView and Hotwire lose
  the session on disconnect or deploy; here reconnect is just another
  event against durable snapshots, and a mid-answer agent stream survives
  a process kill.
- **Workflow-unified interactivity.** Human submits and agent decisions
  are the same primitive against the same durable run — no other
  framework has a durable-workflow engine *and* the UI layer in one
  runtime.
- **Zero build, zero affinity, zero external deps.** No bundler, no
  sticky sessions, no Redis: sqlite + topic bus + hypermedia, all stdlib.
- **The composition rules apply.** A view is code in a realm; a
  realm-per-session (capability-scoped, priced, restartable —
  `application-surface.md` §7, `multi-tenant-runtime.md`) composes later
  without changing the model.

## 13. Build-out sketch

Module layout: `fino:ui/html` (serializer), `fino:ui/web` (views,
actions, middleware, patch writer, live channel), `fino:ui/web/state`
(snapshot store), `fino:ui/web/flow` (`flowPage`,
`observableWorkflowStore`), `internal:ui/web/client` (browser runtime),
`fino:net/http/transpile`. Order of construction, each independently
testable: serializer → `observeReads` core hook → snapshot store →
view/action middleware (testable via `app.handle()` plus
`parseEventStream`, no sockets) → live channel → client runtime + build
baking → flow module → transpile middleware → the flagship demo: a
zero-build agent chat where the model streams into a signal, patches flow
over the wire, a second tab follows live via the topic bus, and killing
the process mid-answer loses nothing.

## 14. Open questions

1. **View/action ergonomics.** The worked example folds `actions:` into
   the `view()` definition; the alternative is separate
   `view.action(...)` registration. Also: is `mount(ctx)` the right
   embedding surface, or should views be plain components with the
   framework discovering them?
2. **Rebase semantics.** Default `'reject'` is safer for stale actions;
   actions that can safely re-run against head state opt into `'rebase'`.
   The remaining question is whether higher-level helpers should make that
   opt-in easier for commutative actions.
3. **Embedded-signal custody.** Plain JSON default with per-key sealing —
   or sealed-by-default with plain opt-in for inspectability?
4. **History retention.** Full history until TTL sweep is the current
   position; is a dev/prod split (history in dev, head-only in prod)
   worth the config surface?
5. **`ctx.stream.patch()` mid-handler streaming.** The lowest-latency
   agent-token path bypasses the snapshot per token and checkpoints at
   message granularity. Is that granularity rule right, or should the
   checkpoint cadence be explicit in the API?
6. **`continue-as-new` for `fino:workflow`.** Out of scope here, but it
   is the missing piece that would make unbounded workflow-backed
   sessions honest, and it benefits non-UI workflows too. Worth its own
   consideration.
7. **Region dependency declarations.** Hash-diffing makes re-rendering
   every region correct; `deps: ['items']` per region would skip
   re-render work. Later optimization or v1 surface?
