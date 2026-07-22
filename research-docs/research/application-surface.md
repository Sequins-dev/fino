# The Application Surface — Remaining Work

> Status: remaining-roadmap snapshot. This note intentionally removes items
> that have already landed (`fino:jobs`, `fino:storage`,
> `fino:security/oauth`, HTTP app sessions, `fino:email`, the `fino:signals` read model,
> Postgres, general caching, AI response caching, and the first
> server-driven web UI pass) and focuses on the application batteries still
> missing for the all-in-one agent-app goal.

## 1. Current Baseline

The runtime now has a credible AI and local-app substrate:

- AI: models, agents, tools, MCP, durable sessions, memory, evals, skills.
- AI caching: `fino:ai/cache` wraps models with exact and semantic cache
  layers, including usage savings metadata.
- Runtime state: `fino:signals`, signal-backed AI/session/jobs/workflow/pool
  read models.
- Background work: `fino:jobs` with durable jobs, cron, retries, and
  workflow-backed durable task execution.
- Data and storage: SQLite, pure TypeScript Postgres protocol support through
  `fino:database/postgres`, S3-compatible signing/client helpers, and an async
  object-backed filesystem adapter in `fino:storage`.
- Caching: `fino:cache` with memory and SQLite backends, TTL, namespaces,
  deterministic clocks, tag invalidation, and HTTP response-cache middleware.
- Auth primitives: JWT/JWS/JWE, JWK/JWKS, sealed cookies, password hashing,
  plus OAuth/OIDC client helpers in `fino:security/oauth`.
- Server sessions: `fino:net/http/app` middleware with sealed identifier
  cookies, key rotation, fixed or rolling expiry, explicit
  regeneration/invalidation, and caller-owned revision-capable caches.
- HTTP app surface: route builders, shared builder branches, middleware and
  layer composition, cookies, in-app session primitives, OpenAPI metadata, and
  response/error helpers.
- Browser UI: `fino:ui/web`, view snapshot stores, workflow-backed pages, SSE
  patch streams, and `transpileFiles()` for browser TypeScript/TSX modules.
- Email: MIME rendering, SMTP delivery shape, provider transport interface,
  and DKIM signing in `fino:email`.

The remaining gap is no longer "basic app infrastructure." It is the set of
surfaces that make a Fino app production-complete without leaving the runtime:
production UI hardening, safe code execution, budget enforcement, webhooks,
and secret custody.

## 2. Browser UI Hardening

The first `fino:ui/web` pass has landed: server-rendered VNodes, view
snapshots, SSE patches for enhanced actions, workflow-backed pages, and
transpile-on-request middleware are available. The remaining work is no longer
"create the browser host"; it is making that host durable enough for real
apps:

- Document the canonical install shape for `webUI()`, sessions, CSRF, view
  stores, and `transpileFiles()`.
- Add a production demo: an agent chat where model stream state updates a
  signal and the browser receives patches without a client build step.
- Decide whether WebSocket patches are needed or whether SSE plus form actions
  should remain the intentionally narrow transport.
- Add operational cleanup hooks for expired snapshots and abandoned streams.
- Ensure the generated browser client and docs make progressive enhancement
  boundaries clear.

## 3. AI Product Controls

### Budgets

The agent loop records usage and cost; it still needs enforcement.

Add a `Budget` surface for token, dollar, and wall-clock ceilings attachable
to a run, session, or tenant. Checks happen before each model call.
Exhaustion should either fail the run or raise `SuspendSignal`, allowing a
human to approve more spend and resume a durable session.

### Gateway Policy

Routing and fallback already exist. The gateway work left is policy:

- Per-key/per-tenant quotas.
- Rate smoothing using `fino:cache` counters.
- Provider key custody in the parent realm, with children receiving
  facade-backed models and never seeing credentials.

### Code-Exec Sandbox

The lower-level pieces exist: `Realm.fromSource()` and strict process sandbox
support can run constrained code. Productize the AI-facing story as
`fino:ai/sandbox`:

- Tool factory for model-written TypeScript.
- `Realm.fromSource` execution with `ImportMap.deny` as the default.
- Explicitly granted facades as the sandbox's whole world.
- Timeout via `terminate()`, captured output, and structured result.
- Higher isolation tiers can follow the multi-tenant virtualization work.

This is a flagship agent feature: safe code execution without requiring a
container sidecar for the common trusted-or-semi-trusted case.

## 4. Webhooks

Add `fino:webhooks` or split helpers under HTTP/security:

- Outbound delivery with HMAC signatures, timestamp headers, and queue-backed
  retry using `fino:jobs`.
- Inbound verification middleware for the same signature scheme.
- Replay window checks and clear error reporting.

Webhooks are deliberately thin: fetch plus signatures plus jobs.

## 5. Secrets

`fino:config` can redact configured secret paths in validation errors, but it
does not yet have secret sources or secret-typed values. Add a secrets source
for `fino:config`:

- Env and sealed-file backends first.
- Values tagged as secret so logs and telemetry can redact by construction.
- Later cluster distribution can ride the cask/grant machinery from
  `multi-tenant-runtime.md`.

The model should stay capability-shaped: a secret is granted to a deployment
or realm, not scattered as process-global ambient state.

## 6. Updated Sequencing

1. **Browser UI hardening and demo** — prove the all-in-one app path with
   durable state, sessions, CSRF, streaming model state, and no client build
   step.
2. **Budgets and gateway policy** — turns usage accounting into product
   controls.
3. **`fino:ai/sandbox`** — flagship agent capability; sequence stronger
   isolation tiers with multi-tenant runtime work.
4. **Webhooks and secrets** — small, production-critical batteries.

The organizing principle stays the same: every surface is a module, and the
module graph remains the capability graph. What a tenant can import is what it
can do, whether that is a session cache, model, UI channel, webhook sender, or
secret.
