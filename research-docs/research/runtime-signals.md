# Signals as the Runtime's Read Model

> Status: design iteration, pre-implementation. Companion to
> `server-driven-ui.md`, which designs the `fino:ui/web` framework this doc
> feeds. The question explored here: where else in the runtime would
> signals provide a clean integration point with UI code — and what
> discipline keeps "signals everywhere" from becoming a mess.

## 1. The gap, stated precisely

A survey of the runtime finds four ways state change is observed today:

1. **Async iterators** — model streams (`ModelStream`), agent event
   streams (`AgentStream.reader`), file watch (`Watcher`), topic
   `[Symbol.asyncIterator]`.
2. **One-shot callbacks** — `SessionOptions.onCheckpoint(RunState)`,
   workflow `onCheckpoint`, MCP client `onToolsChanged`/`onResourceUpdated`,
   realm `onReload()`, eval `EvalReporter`.
3. **Poll-only getters** — `Session.state`, `jobs.get/list` (plus a
   literal 10ms→250ms backoff poll loop inside `jobs.wait()`),
   `RealmPool.size/pending/queued`, orchestrator `workloads()`,
   `ManualMetricReader.collect()`, `Memory.getWorkingMemory()`.
4. **Topic bus** (`fino:context/topic`) — the real event spine: jobs,
   realms, and pools already publish lifecycle events under
   `otel:runtime:*`. But topics are transient broadcast — no retained
   current value, no dedupe; subscribe late and you know nothing.

`Signal` (`js/ui.ts`) is a fifth idiom the runtime has but does not use:
**retained current value + change notification + `Object.is` dedupe +
batch coalescing**. Grep confirms zero producers outside the UI layer —
and, notably, even `fino:tty/tui` doesn't subscribe to signals (its live
renderer is imperative `app.update()`; the reconciler in `js/ui.ts` that
would consume subscriptions is unused by the shipping TTY host).

The signal shape is exactly what a render function wants: read the
current value during render (read-tracking captures the dependency), get
notified to re-render. In the `fino:ui/web` model, a live region that
reads a runtime-produced signal becomes live-updating with *zero glue* —
no iterator-draining loop, no callback plumbing, no poll timer. That is
the payoff this doc is chasing:

```tsx
const run = session.watch();          // ReadonlySignal<RunState>

live.view('agent', () => (
  <div>
    <Transcript messages={run.get().messages} />
    {run.get().status === 'suspended' &&
      <ApprovalCard reason={run.get().suspendedOn} action={actions.approve} />}
    <UsageMeter usage={run.get().usage} cost={run.get().cost} />
  </div>
));
```

Read-tracking subscribes the region; every session checkpoint pushes DOM
patches. The same component tree renders in the terminal — signals are
already host-neutral.

## 2. The discipline: state vs. events

The rule that keeps this coherent — worth stating as a runtime-wide
convention:

> **A signal models state ("what is"). A topic or iterator models events
> ("what happened"). Expose a signal only where losing intermediate
> values is correct.**

Signals are lossy by design: they retain the latest value and coalesce
under `batch()`. That is right for status, counters, transcripts,
inventories — anywhere a late subscriber should see the current truth and
a fast producer should not queue history. It is wrong for sequences where
every element matters: model deltas, watch events, SSE frames, job
lifecycle *events* stay iterators/topics. Most modules therefore keep
their existing surfaces and *add* a signal-shaped read model beside them
— nothing is rewritten, and the two idioms compose (a signal is often a
fold over a topic or iterator).

The second discipline is **laziness**. Topics already gate work on
`hasSubscribers`; signal bridges must do the same — a signal derived from
a topic subscription or a fold should not subscribe upstream until it has
its first subscriber, and should dispose upstream when the last one
leaves. This requires a "cold signal" primitive (§3), and it is what
makes "signals everywhere" free for programs that never render anything.

## 3. The kernel: extract and extend

Two structural moves before any module integration:

**Extract the primitive out of the UI layer.** If `fino:jobs` and
`fino:ai/session` produce signals, they cannot import `fino:ui` — the
layering is backwards. Decision: move `Signal`, `createSignal`, `batch`
(and the `observeReads` hook from the UI design) into a small standalone
module — **`fino:signals`** — with `fino:ui` re-exporting them
unchanged. The UI core keeps VNodes and reconciliation; the reactive
primitive becomes runtime infrastructure, which is what this doc is
arguing it already wants to be.

**Grow the kernel with the generic combinators** every integration below
needs, so each module's bridge is a few lines rather than a bespoke
subscription manager:

```ts
interface ReadonlySignal<T> {           // producer keeps set(); consumers can't write
  get(): T;
  subscribe(fn: (value: T, previous: T) => void): () => void;
}

function computed<T>(fn: () => T): ReadonlySignal<T>;
// derived via observeReads tracking; recomputes when any dependency fires

function effect(fn: () => void): () => void;
// run now, re-run on dependency change; returns dispose

function lazy<T>(initial: T, start: (set: (v: T) => void) => () => void): ReadonlySignal<T>;
// cold signal: `start` runs on first subscriber, dispose runs after the last leaves

function fromIterable<T, S>(src: AsyncIterable<T>, fold: (acc: S, item: T) => S, initial: S): ReadonlySignal<S>;
// drain an async iterable into a retained fold (built on `lazy`)
```

`ReadonlySignal` matters for API honesty: a module exposing
`pool.stats` must not hand consumers a `set()`.

There is deliberately no topic-specific combinator: `Topic` is already
`AsyncIterable` (`js/context/topic.ts:312` — each iterator gets its own
subscription and buffered queue, and `return()` disposes it), so
`fromIterable` covers streams, watchers, and topics alike. One care in
the implementation: a topic's iterator subscribes at *creation*, so
`fromIterable` must obtain the iterator inside `lazy`'s `start` (not at
call time) and call `return()` on teardown — that is what preserves the
`hasSubscribers` gating end to end: the topic sees a subscriber only
while the signal is hot.

There is also deliberately no throttling in the kernel. A fold may
`set()` per token; that is fine because backpressure is the consumer's
job and the consumers already have it — the SSE patch path writes through
buffered writers, so a hot signal's updates coalesce naturally between
flushes (the region re-renders at the rate the writer drains, reading
whatever the current value is), and `batch()` covers the synchronous
case. If a consumer genuinely needs time-based coalescing it can wrap a
signal in user space; the kernel stays value-semantics only.

**Prefer coarse object signals over decomposed ones.** One
`ReadonlySignal<RunView>` carrying `{status, text, usage, cost, ...}`,
not five sibling signals — fewer instances to construct, manage, and
unsubscribe, and one emission point per state change instead of a
fan-out. The render-cost argument for fine-grained signals doesn't apply
here: `fino:ui/web` hash-diffs rendered regions, so a coarse signal that
fires with an unchanged-relevant field produces zero patches. Decompose
with `computed()` at the consumer when a narrower view is wanted.

## 4. Integration points, ranked by leverage

### 4.1 AI plane — the flagship (highest value)

The AI survey found the richest live state in the runtime with the
weakest read model: everything is iterator-or-nothing, and a UI must
maintain its own derived state by draining `AgentEvent`s.

- **`Session.watch(): ReadonlySignal<RunState>`.** The cleanest single
  candidate in the runtime. `RunState` already carries everything a UI
  renders — `status`, `stepIndex`, `usage`, `cost`, `suspendedOn`,
  `result`, `error` — and the emission point already exists: the
  `onCheckpoint` site in `Session.#drive` plus the suspend/terminal
  branches. A derived `computed(() => run.get().suspendedOn ?? null)`
  drives approval UIs; durable sessions make this the perfect partner for
  the `fino:ui/web` snapshot model (reconnect re-reads current state — no
  special case).
- **`AgentStream.state: ReadonlySignal<AgentRunView>`.** Keep `reader`
  for consumers that need every event; add one coarse object signal fed
  from the same `onEvent` sites, carrying
  `{status: 'streaming' | 'tool' | 'suspended' | 'done' | 'error',
  text, currentTool: {id, name} | null, usage, cost, stepIndex}`.
  The fold logic already exists in `assembleResult` — it just runs lazily
  at the end today instead of incrementally. (Side benefit: an internal
  tee/fold fixes the existing wart where iterating the stream and calling
  `result()` are mutually exclusive because they share one generator.)
- **`ModelStream.state`** — same fold one level down
  (`{text, usage, stopReason}`), for direct model calls without an agent
  loop. This is the token-streaming demo reduced to its essence:
  `model stream → signal → patch`.
- **`MessageHistory` as a signal of an immutable value.** History is
  already reference-swapped immutably
  (`strategy.history = await history.append(...)`), which is *ideal* for
  `Object.is` dedupe — a `Signal<MessageHistory>` at the strategy level
  makes transcript views, token-budget meters, and summarization
  indicators reactive with no other change. The reassignment sites exist;
  nothing fires there today.
- **MCP client:** `client.tools` / `client.resources` / `client.prompts`
  as `ReadonlySignal<...[]>`, refetched inside the existing
  `on*Changed` callbacks. The callbacks already exist and already carry
  the change; today every consumer re-implements the refetch.
- **Later, needs new emission points:** eval run progress
  (`Signal<{passed, total, mean}>` beside `EvalReporter`), memory
  `ingest()` chunk progress, working-memory object.

### 4.2 Workflow — unify with the UI design

`server-driven-ui.md` §7 proposes `observableWorkflowStore()` (save →
topic publish) so pages can watch runs. That is really the producer half
of a signal. The consumer half generalizes it:

```ts
function watchRun(store: WorkflowStore, runId: string): ReadonlySignal<WorkflowState>;
// fromIterable over topic(`fino:ui/run:${runId}`), reload-on-publish, seeded by store.load()
```

One mechanism, three consumers: the web live channel, a TUI progress
view, and any program that just wants `effect(() => ...)` on a run. The
UI doc's `watch:` topics and this helper should be the same thing — the
framework watches topics; `watchRun` is sugar that pairs a topic with its
store reload.

### 4.3 Jobs — dashboards need a read model that doesn't exist

The survey found a concrete gap: **no stats surface at all** — no
counts/depth query in the store, in-flight tallies private, and
`jobs.wait()` is a backoff poll loop. Two additions:

- **`jobs.job(id): ReadonlySignal<JobRecord>`** — seeded by `get(id)`,
  updated from the existing `otel:runtime:jobs:*` topic events (store
  remains truth; reload on event). `wait()` collapses into "subscribe
  until terminal status" and the poll loop disappears.
- **`jobs.stats(queue?): ReadonlySignal<QueueStats>`** — requires adding
  the missing aggregate query (`COUNT ... GROUP BY status`) to the store
  and the control facade, then folding topic events with periodic
  reconcile. `QueueStats = { pending, running, waiting, done, error, dead,
  oldestPendingAt }`.

With those two, a live jobs dashboard is a `fino:ui` component tree and
nothing else — and it renders in the browser via `fino:ui/web` *and* in
the terminal via `fino:tty/tui` from the same components.

### 4.4 Pools, realms, orchestrator — the runtime observing itself

- **`RealmPool.stats: ReadonlySignal<{size, pending, queued, restarts}>`**
  — getters exist for the first three; *restarts are currently silent*
  (crash respawn and recycle fire nothing beyond OTel call events), so
  this adds one emission point worth having regardless.
- **Orchestrator `workloads()`** is the runtime's top-level live
  inventory — id, kind, status per workload — and is snapshot-poll today.
  A `ReadonlySignal<Workload[]>` set at the existing register/release
  sites is trivial and makes a "what is this runtime doing" page free.

Together with §4.3 this composes into something worth naming: **the
runtime can render its own ops dashboard** — jobs, schedules, workloads,
pool health, active agent sessions — as an ordinary fino app with no
external monitoring stack. Host-neutrality makes it `fino top` in a
terminal and `/admin` in a browser from one component tree. This is a
direct consequence of signals-as-read-model and probably its best demo
outside the agent chat. (Deferred: no dashboard or any other UI ships
with this line of work — signals land as pure infrastructure, and UI
built on them waits until `fino:ui/web` is polished.)

### 4.5 Metrics — signals and gauges are duals

An OTel `ObservableGauge` is a pull-callback; a signal is a retained
value. The bridges are one-liners in whichever direction:

- `gaugeFromSignal(meter, name, sig)` — instrument the app's own reactive
  state with zero extra bookkeeping.
- Dashboard-side: `lazy` around `ManualMetricReader.collect()` on an
  interval → `ReadonlySignal<MetricRecord[]>`.

(The survey also found there are **no process stats at all** — no
memory/RSS, no event-loop lag. That gap is independent of signals but
becomes more visible once dashboards are easy; noted for the
application-surface list.)

### 4.6 Deliberately *not* signals

- **Model/agent event sequences, watch events, SSE frames** — every
  element matters; iterators/topics remain the surface. Signals appear
  only as folds beside them.
- **File watch** — a `WatchEvent` stream is events, not state. (A
  `fromIterable` fold like "contents of this config file" is a
  three-line user-space composition; it doesn't need a module surface.)
- **WebSocket `readyState`** — EventTarget parity is the spec surface
  (per the no-extra-methods-on-spec-globals rule); anyone needing a
  signal wraps it with `lazy` in user space.
- **`fino:task`** — a `Task` is an immutable definition; there is no
  state to observe. Durable task state is workflow state (§4.2).

## 5. Interaction with the `fino:ui/web` state model

Runtime-produced signals are **ephemeral read models**, not snapshot
state — they never serialize into L2 snapshots and never cross realms.
This composes cleanly with the durable design rather than fighting it:

- In a live region, reading `session.watch()` or `jobs.stats()` makes the
  region live for as long as the SSE connection exists; on reconnect the
  signal is simply re-read at current truth — consistent with "reconnect
  is just another event."
- The durable path and the signal path share producers: a workflow
  checkpoint both persists state (durable truth) and publishes a topic
  (live notification). `watchRun` and `observableWorkflowStore` are the
  two halves of that one contract.
- The TTY host should adopt the same consumer pattern (subscribe →
  re-render via the existing reconciler) instead of imperative
  `update()` — otherwise the web host establishes the pattern and the
  terminal host remains the odd one out.

## 6. Sequencing sketch

No UI ships in any of these steps — this line of work ends at the signal
surfaces themselves (observable via tests and plain `effect()`
consumers). UI built on them waits for `fino:ui/web` to be polished.

1. Extract the kernel to `fino:signals` (re-export from `fino:ui`), add
   `ReadonlySignal`, `computed`, `effect`, `lazy`, `fromIterable`.
2. `Session.watch()` + `AgentStream.state`/`ModelStream.state` — the
   flagship surfaces, and the direct dependency of the agent-chat demo in
   `server-driven-ui.md`.
3. `watchRun()` unified with `observableWorkflowStore`.
4. Jobs: stats query + `job(id)`/`stats()` signals (also deletes the
   `wait()` poll loop).
5. Pool/orchestrator stats signals (adds the missing restart emission).
6. MCP client list signals; metrics bridges.

## 7. Decisions and remaining questions

Resolved (2026-07-03):

- **Kernel module is `fino:signals`**, standalone public, re-exported by
  `fino:ui`.
- **Coarse object signals, not decomposed** — one signal per live thing
  (`AgentRunView`, `RunState`, `QueueStats`); consumers narrow with
  `computed()`. Avoids excessive instance construction and management;
  hash-diffing in `fino:ui/web` makes coarse invalidation costless.
- **No kernel throttling** — folds `set()` freely; buffered writers on
  the consumer side (the SSE patch path) provide the backpressure, so
  hot signals coalesce between flushes naturally.
- **`watch()` lives on the owner** — `Session.watch()` is a method, and
  `Jobs`/`RealmPool` follow the same shape (discoverability wins; the
  coupling is only to the small `fino:signals` kernel).
- **No UI in this line of work** — the ops dashboard and any component
  kits wait until the UI framework is polished; signals land as
  infrastructure only.

Still open:

1. **`AgentRunView` field set.** Exactly which folded fields the agent
   and model state signals carry (e.g. does `steps` belong, or is the
   transcript better served by the `MessageHistory` signal alone?).
2. **Reconcile cadence for store-backed signals.** `jobs.stats()` folds
   topic events with periodic reconcile against the store — what
   interval, and is reconcile skipped entirely while the store and
   events agree?
