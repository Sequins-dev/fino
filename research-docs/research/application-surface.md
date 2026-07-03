# The Application Surface — Remaining Work

> Status: remaining-roadmap snapshot. This note intentionally removes items
> that have already landed (`fino:jobs`, `fino:storage`,
> `fino:security/oauth`, `fino:email`, and the `fino:signals` read model) and
> focuses on the application batteries still missing for the all-in-one
> agent-app goal.

## 1. Current Baseline

The runtime now has a credible AI and local-app substrate:

- AI: models, agents, tools, MCP, durable sessions, memory, evals, skills.
- Runtime state: `fino:signals`, signal-backed AI/session/jobs/workflow/pool
  read models.
- Background work: `fino:jobs` with durable jobs, cron, retries, and
  workflow-backed durable task execution.
- Storage: S3-compatible signing/client helpers and an async object-backed
  filesystem adapter in `fino:storage`.
- Auth primitives: JWT/JWS/JWE, JWK/JWKS, sealed cookies, password hashing,
  plus OAuth/OIDC client helpers in `fino:security/oauth`.
- Email: MIME rendering, SMTP delivery shape, provider transport interface,
  and DKIM signing in `fino:email`.

The remaining gap is no longer "basic app infrastructure." It is the set of
surfaces that make a Fino app production-complete without leaving the runtime:
shared relational data, caching, server sessions, browser UI, safe code
execution, budget enforcement, webhooks, and secret custody.

## 2. Shared Relational Data: `fino:database/postgres`

SQLite stays the differentiated default for per-tenant/per-session local
state, but many apps still need a shared external database. Postgres is now
the biggest missing ecosystem bridge.

Build a pure TypeScript protocol-v3 client:

- No libpq and no blocking FFI; use `fino:net/socket`, `fino:net/tls`, and
  Web Crypto/SCRAM-SHA-256.
- Support the extended query protocol, prepared statements, transactions,
  typed row decoding, cancellation, and connection pooling.
- Include `LISTEN`/`NOTIFY` early and bridge notifications to topics/signals;
  agent apps frequently need "wake this run when ingestion finished."
- Defer bulk analytical paths such as `COPY` to Arrow until the core client is
  stable.

Success criterion: an app can use Postgres for shared state while still using
SQLite for isolated tenant/session state.

## 3. Caching And Semantic Cache

`fino:cache` should be a small cache abstraction, not a distributed systems
promise:

- `get` / `set` / `delete`, TTL, namespaces, and tag invalidation.
- Memory LRU backend and SQLite backend.
- Deterministic clock hooks for tests.
- HTTP response-cache middleware for `fino:net/http/app`.

The AI-specific layer is the differentiated piece:

- `fino:ai/cache` wraps a `Model`.
- Tier 1: exact cache keyed by normalized request shape.
- Tier 2: semantic cache using `EmbeddingModel` plus sqlite-vec similarity.
- Usage accounting should report cache savings separately from model spend.

Caveats belong in the API docs: semantic thresholds are domain-specific,
time-sensitive answers should usually bypass semantic hits, and tool-calling
turns should generally exact-match on tool context.

## 4. Server Sessions: `fino:security/session`

OAuth client flows exist, but apps still need a first-class authenticated
session layer.

Add `fino:security/session`:

- Sealed-cookie session id.
- Pluggable record stores: memory, SQLite, and later `fino:cache`.
- Rolling expiry and explicit invalidation.
- Middleware for `fino:net/http/app` that hydrates `ctx.session`.
- Auth helpers that compose with `fino:security/oauth` callback results.

This should not become an identity provider. It is the app-session layer that
turns OAuth/JWT primitives into "put this app behind login."

## 5. Browser UI: `fino:ui/web`

The runtime now has signals as a shared read model, but the browser host is
still missing. The target remains narrow: the UI for the app written in this
runtime, not a React/Next competitor.

Remaining pieces:

- HTML renderer/host for `fino:ui`, including SSR of VNodes to HTML.
- Explicit live regions that re-render from signal reads and send DOM patches
  over SSE or WebSocket.
- A small static browser client that applies patches and sends events back.
- TypeScript/TSX transpile-on-demand middleware for browser modules using the
  existing OXC path.

The canonical demo should be an agent chat where model stream state updates a
signal and the browser receives patches without a client build step.

## 6. AI Product Controls

### Budgets

The agent loop records usage and cost; it still needs enforcement.

Add a `Budget` surface for token, dollar, and wall-clock ceilings attachable
to a run, session, or tenant. Checks happen before each model call.
Exhaustion should either fail the run or raise `SuspendSignal`, allowing a
human to approve more spend and resume a durable session.

### Gateway Policy

Routing and fallback already exist. The gateway work left is policy:

- Per-key/per-tenant quotas.
- Rate smoothing using `fino:cache` counters once cache exists.
- Provider key custody in the parent realm, with children receiving
  facade-backed models and never seeing credentials.

### Code-Exec Sandbox

Productize the safe execution story as `fino:ai/sandbox`:

- Tool factory for model-written TypeScript.
- `Realm.fromSource` execution with `ImportMap.deny` as the default.
- Explicitly granted facades as the sandbox's whole world.
- Timeout via `terminate()`, captured output, and structured result.
- Higher isolation tiers can follow the multi-tenant virtualization work.

This is a flagship agent feature: safe code execution without requiring a
container sidecar for the common trusted-or-semi-trusted case.

## 7. Webhooks

Add `fino:webhooks` or split helpers under HTTP/security:

- Outbound delivery with HMAC signatures, timestamp headers, and queue-backed
  retry using `fino:jobs`.
- Inbound verification middleware for the same signature scheme.
- Replay window checks and clear error reporting.

Webhooks are deliberately thin: fetch plus signatures plus jobs.

## 8. Secrets

Add a secrets source for `fino:config`:

- Env and sealed-file backends first.
- Values tagged as secret so logs and telemetry can redact by construction.
- Later cluster distribution can ride the cask/grant machinery from
  `multi-tenant-runtime.md`.

The model should stay capability-shaped: a secret is granted to a deployment
or realm, not scattered as process-global ambient state.

## 9. Updated Sequencing

1. **Postgres** — biggest ecosystem unlock; pure protocol work.
2. **Cache, then AI semantic cache** — app performance first, AI
   differentiation second.
3. **Server sessions** — completes the login story on top of OAuth.
4. **`fino:ui/web` + transpile middleware** — makes the all-in-one app visible
   in a browser.
5. **Budgets and gateway policy** — turns usage accounting into product
   controls.
6. **`fino:ai/sandbox`** — flagship agent capability; sequence stronger
   isolation tiers with multi-tenant runtime work.
7. **Webhooks and secrets** — small, production-critical batteries.

The organizing principle stays the same: every surface is a module, and the
module graph remains the capability graph. What a tenant can import is what it
can do, whether that is a database, cache, session store, model, UI channel,
webhook sender, or secret.
