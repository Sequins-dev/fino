# The Application Surface — What All-in-One Still Requires

> Status: exploratory, direction-setting. Companion to
> `multi-tenant-runtime.md`, which maps *where code runs and what it may
> touch* (placement, packaging, virtualization). This doc maps the other
> half: *what code gets to call* — the batteries a typical AI-centric app
> expects that fino does not yet ship, with a concrete proposal for each.
> It deepens the backend items sketched in `stdlib-dx.md` and revises that
> doc's deferred-frontend posture in light of the all-in-one agent-app goal.

## 1. The thesis

Walk the dependency graph of a real AI application, backend to frontend:
model access, agent orchestration, retrieval and memory, background compute
(ingestion, embedding, batch inference), state (relational, object, cache),
auth, realtime delivery, and a UI that streams tokens. An inventory of the
built-in surface against that graph gives a lopsided result: the AI plane is
nearly complete — models with local fallback, agents, tools, MCP both
directions, durable resumable sessions, sqlite-vec memory, evals, skills —
while the application-infrastructure plane has specific, enumerable holes.
Today a fino user writing an agent product hits a wall not at "call the
model" but at "run the embedding backfill tonight," "put sessions behind
login," and "show the stream in a browser."

Two properties make filling these holes cheaper here than anywhere else.
First, almost every gap is a composition of things that already ship — the
proposals below name their ingredients, and several are close to assembly
work. Second, every battery is just another `fino:*` module: it inherits the
capability regime (a tenant's queue access is an import grant), the
observability regime (OTel instrumentation), and eventually the metering and
placement regime from `multi-tenant-runtime.md`. Nothing below requires new
runtime machinery; nothing below is blocked on the cluster work.

## 2. Background compute: `fino:jobs`

The most-hit gap. Every AI app accumulates background work almost
immediately — document ingestion, embedding backfills, batch inference,
webhook retries, session summarization — and fino has durable *orchestration*
(`fino:workflow`) but no durable *work queue*. The seam is even visible in
the code: `fino:task`'s doc header promises the same task value can be
reused "by RPC and queue surfaces," and no queue surface exists.

`stdlib-dx.md` already names this `fino:jobs`; keep the name and commit to
the shape:

- **Store**: sqlite-backed, cloning the `WorkflowStore` contract's shape
  (`js/workflow.ts:113` — save/load/list/delete of validated JSON state by
  id). Jobs get leases with visibility timeouts, so a worker death returns
  the job to the queue instead of losing it; retries with backoff and a
  dead-letter state; delayed jobs; typed payloads via `fino:validate`.
- **Work unit**: a `fino:task` op. `queue('ingest').push(input, { delay,
  retries })` enqueues; a worker pool runs `task.run` with a job-scoped
  context. This is the wiring `fino:task` was designed for, and it means one
  definition is simultaneously a CLI command, an AI tool, an MCP mount, and
  a job handler.
- **Workers**: a `RealmPool` of thread realms consuming with bounded
  concurrency — crash recovery and load-spreading come with the pool. Each
  job runs under an OTel span linked to its enqueue site.
- **Cron**: persisted schedules in the same store, driven by the workflow
  timer machinery (`toDueAt`); `schedule('0 3 * * *', task)`. Cron is a job
  emitter, not a separate subsystem.
- **Division of labor**: workflows orchestrate (checkpointed steps, signals,
  long sleeps); jobs execute (retryable units). A workflow activity that
  should survive the orchestrator's node can be an enqueued job — this gives
  `fino:workflow` the remote-activity-executor story it currently lacks.

Honest v1 limits, stated up front per the `stdlib-dx.md` posture: local
process, single-writer sqlite. The cluster path — the seed's desired-state
reconcile loop placing consumers on nodes — composes later and changes the
consumer side only; the queue store stays put until proven insufficient.

## 3. Data backends

### `fino:database/postgres`

SQLite covers app-local and per-tenant state, but the moment an app must
share relational state across nodes — or simply must talk to the database a
company already has — fino has no answer at all. This is the single biggest
unlock on the list.

The proposal is a pure-JS wire-protocol client, no libpq, no FFI: protocol
v3 is stable and well documented, SCRAM-SHA-256 lands on Web Crypto, TLS is
a socket upgrade via `fino:net/tls`, and the extended query protocol
pipelines naturally over the async socket — the async-I/O-only rule is
satisfied by construction rather than by wrapping a blocking library.
Include `LISTEN`/`NOTIFY` from the start; it is disproportionately useful in
agent apps (wake a session when ingestion finishes) and trivially maps onto
the topic bus. Later, not v1: a `COPY`-to-Arrow bridge via `fino:data/arrow`
for bulk analytical reads.

### `fino:storage`

Object storage is where AI apps keep everything heavy — user uploads,
artifacts, model weights, exported datasets. An S3-compatible client is
signing plus streaming: SigV4 over the shipped crypto, multipart upload over
the shipped HTTP stack, presigned URLs (the standard answer to browser
uploads) as a pure signing exercise.

The same module should ship the S3-backed `FileSystem` provider that
`virtual-io.md` anticipates. That dual role is the point: `fino:file`
against a bucket becomes an import directive, and anything built on the
filesystem — including sqlite through its JS VFS — can be pointed at object
storage per realm. (Honesty note: sqlite paging synchronously over HTTP is
for snapshot/restore and cold archives, not hot databases.)

### The position: sqlite-per-tenant is the default

With Postgres and S3 available, the doc should still take a position rather
than offering three equal options: embedded sqlite — one database per
tenant, per agent session, per realm — is fino's *differentiated* default,
the Durable Objects/Turso pattern with the VFS already in-tree. Tenant state
that lives in the tenant's own database file inherits realm isolation,
migrates with a file copy, and needs no connection pool. Postgres is for
genuinely shared state; `fino:storage` is for bytes; neither demotes the
default.

## 4. Caching: `fino:cache`, and the semantic cache

`stdlib-dx.md` sketches `fino:cache`/`fino:kv`; the shape to commit to: one
small interface (`get`/`set`/`delete`, TTL, namespaces, tag invalidation)
with a memory-LRU tier and a sqlite tier, deterministic-clock-friendly for
tests. The HTTP app layer should grow a response-cache middleware that takes
any `fino:cache` store. As with jobs: local and honest first, no distributed
cache promise.

The differentiated move sits one level up. Model calls are the most
expensive, most cacheable I/O an AI app does, and fino ships both halves of
a **semantic cache**: `EmbeddingModel` and sqlite-vec. `fino:ai/cache`
wraps a `Model` with two tiers — exact (hash of the normalized request:
messages, tools, params) and semantic (embed the prompt, `vec` similarity
lookup, serve the cached completion above a threshold). No other runtime has
this in the box. The caveats belong in the doc, not a footnote: thresholds
need tuning per domain; a semantic hit on a stale answer is worse than a
miss for time-sensitive queries; tool-calling turns must key on tool context
and should usually only exact-match; cache hits must still be attributed in
usage accounting (as savings, not spend).

## 5. Completing the AI plane

### Budgets

The agent loop already meters usage and cost per run; nothing *enforces*
anything. Add `Budget` — token, dollar, and wall-clock ceilings — attachable
to a run, a session, or a tenant (nested, narrowing only, like every other
capability in the system). The runtime checks before each model call;
exhaustion either fails the run or raises `SuspendSignal`, which composes
with durable sessions into exactly the right product behavior: the agent
pauses, a human approves more spend, `resumeSuspended()` continues. Spend
reports over OTel now, and over the per-realm stats channel planned in
`multi-tenant-runtime.md` §2 when it lands — tokens are the AI-native cost
dimension, and a tenant burning budget is a throttling signal exactly like a
realm burning CPU.

### Gateway hardening

Routing and fallback across providers already exist in the runtime layer.
Two additions make it an actual gateway: per-key/per-tenant quotas and rate
smoothing (a `fino:cache` counter is enough), and key custody — provider
keys live in the parent realm, children import a facade-backed model and
never see a credential. The capability model does key isolation for free;
the doc just has to say so and make it the documented pattern.

### The code-exec sandbox, productized

`fino:ai/sandbox` was deliberately deferred until the privileged agent
harness matured. The substrate is now in place, so propose the shape: a
tool factory that runs agent-generated TypeScript in a realm assembled for
the purpose — `ImportMap.deny` as the floor, explicitly granted facades as
the tenant's whole world, `Realm.fromSource` for the code, wall-clock
timeout via `terminate()`, captured output and structured result. Isolation
tiers map to trust: embedded realm for cheap denial-based sandboxing,
process realm inside an OS sandbox for hostile code, the dlopen-shim and
WASM tiers of `multi-tenant-runtime.md` §5–6 as they land — same knobs,
same policy surface, chosen per call site.

This deserves flagship framing. Every serious agent product needs safe
execution of model-written code, and everyone else's answer is a container
sidecar with a network hop. fino's answer is a primitive of the runtime the
agent is already running in, with a capability grant as the security model.

### Batch and scheduled inference

Not a subsystem — a pattern the doc should show once `fino:jobs` exists:
embedding backfills, nightly summarization, and eval sweeps are cron
schedules emitting jobs whose handlers call models under a `Budget`. The
worked example belongs in the jobs guide.

## 6. Completing auth: `fino:security/oauth` and sessions

The primitives shipped — JWT/JWS/JWE, JWK/JWKS, sealed cookies, HMAC
tokens, password hashing — but a user cannot put an app behind login
without assembling them by hand. Two modules close it:

- **`fino:security/oauth`**: OAuth 2.1 *client* flows — authorization code
  with PKCE, OIDC discovery, token refresh, `state`/`nonce` handling — as
  functions plus drop-in `fino:net/http/app` middleware ("login with
  GitHub/Google in five lines"). Composed entirely from fetch + JWT/JWKS
  verification.
- **`fino:security/session`**: server-side sessions — sealed-cookie session
  id, pluggable record store (memory, sqlite, `fino:cache`), rolling
  expiry, middleware that hydrates `ctx.session`.

Explicitly not an identity provider — that is an app someone writes on
these modules, perhaps a template. The same two modules retire MCP's
"OAuth is app middleware" caveat: resource-server metadata and bearer-token
validation land on `fino:security/oauth`'s verification half, making
authenticated MCP servers a documented composition instead of an exercise.

## 7. The frontend layer

`stdlib-dx.md` deferred frontend work, correctly, when the wedge was
backend services. The all-in-one agent-app goal changes the calculus: an
agent product is not done until a person can watch tokens stream into a
browser, and today fino serves static files and raw WebSockets and stops.
The revision is narrow, though — the target is *the UI for the app you just
wrote in one file*, not a general frontend build platform. Three pieces:

- **An HTML host for `fino:ui`.** The JSX/signals/reconciler core is
  host-neutral by design — it owns VNodes and keyed reconciliation and
  explicitly does not know about the DOM or terminal cells; `fino:tty/tui`
  proves the adapter contract. An HTML adapter with streaming render (flush
  the shell, stream the rest) is the second host, and SSR falls out of it.
- **Server-driven interactivity over the signal graph.** Signals already
  carry precise invalidation. Keep the component tree on the server, ship a
  small static client runtime, and send minimal DOM patches over
  WebSocket/SSE when signals change — the LiveView/Hotwire school, which
  fino is unusually equipped for: realtime transports are native, a realm
  per connected session is the natural unit (capability-scoped, priced,
  restartable), and no bundler or client framework is required. The
  canonical demo writes itself: model stream → signal set → patch over the
  wire; a live agent chat with zero client build.
- **TypeScript to the browser.** For the client code an app does need, a
  transpile-on-demand middleware: serve `.ts`/`.tsx` as ES modules with an
  import map, strip types at request time, cache by mtime. The runtime
  already transpiles TS in-memory (`Realm.fromSource`), so this is exposing
  existing OXC plumbing behind a route (a small `fino:transpile` surface),
  not new machinery. Zero build step in dev *and* prod; `staticFiles()`
  covers the rest.

What this deliberately is not: a React/Next competitor, a bundler, an
islands framework. Apps that outgrow the story use the ecosystem; the story
exists so the common agent app never has to.

## 8. Smaller batteries

**Email.** Transactional mail is table-stakes for any app with users
(magic links, digests, alerts). An SMTP client is a modest protocol over
`fino:net/socket` + `fino:net/tls` — STARTTLS, AUTH PLAIN/LOGIN, dot
stuffing — plus a provider-neutral `send()` with HTTP adapters for the
hosted services, since most production mail goes that way. DKIM signing is
crypto fino already has, worth doing early since unsigned mail is
effectively undelivered.

**Webhooks.** Both directions, thin: outbound delivery with HMAC
signatures, timestamp headers, and queue-backed retry with backoff (rides
`fino:jobs`; a webhook is just a job whose handler is a fetch); inbound
verification middleware for the same signature scheme. Agent products live
on webhooks in both directions.

**Secrets.** A `fino:config` source with provenance: env and sealed-file
backends first, values tagged so logging/telemetry can redact by
construction. Later, cluster distribution rides the cask/grant machinery
from `multi-tenant-runtime.md` — a secret is a capability a deployment is
granted, not a file an operator scatters.

## 9. Sequencing

Ordered by leverage; each independently shippable; none blocked on the
cluster line. The `fino:ai` items ride in parallel with whatever backend
step is in flight.

1. **`fino:jobs` + cron** — the most-hit gap; unblocks batch inference,
   webhook retry, and the workflow activity-executor story.
2. **`fino:database/postgres`** — the ecosystem unlock; pure protocol work
   with no new primitives.
3. **`fino:cache`, then `fino:ai/cache`** — the sqlite tier is small; the
   semantic cache is the headline and is mostly assembly.
4. **`fino:security/oauth` + sessions** — closes "put it behind login" and
   the MCP auth caveat together.
5. **`fino:storage`** — client + FileSystem provider in one module.
6. **HTML host for `fino:ui` + transpile middleware** — SSR and
   TS-to-browser; prerequisite for the next step.
7. **Server-driven UI protocol** — the live agent-chat demo; the piece that
   makes "whole app, one runtime, no build" visibly true.
8. **Email, webhooks, secrets** — small, independent, any order.

In parallel on the AI plane: **budgets** (small, high product value),
**gateway quotas/key custody** (mostly documentation of the capability
pattern plus counters), **`fino:ai/sandbox`** (flagship; sequence its tiers
with the `multi-tenant-runtime.md` virtualization work).

The convergence mirrors the multi-tenant doc's: every one of these is a
module, so the module graph remains the single mechanism — what a tenant's
import rules grant is what exists, whether that is a filesystem, a model, a
queue, or a mailbox. The all-in-one runtime is not a framework bolted onto
fino; it is fino's own composition rules applied to a longer list of
batteries.
