# Fino — Vision & Niche Exploration

> Status: exploratory. This document inventories fino's distinctive capabilities and maps
> them onto product directions. It is a thinking document, not a commitment. Concrete,
> sequenced work belongs in `roadmap.md`; cross-references are noted inline.

## 1. What fino actually is (the unfair advantages)

Before chasing niches, name the assets. fino is not "another Node." Its defensible,
hard-to-copy properties are a specific *combination* that no incumbent runtime has all of:

1. **Location-transparent realms.** The same Facade/RPC programming model spans four
   isolation tiers with identical surface: `embedded` (new V8 context, same isolate),
   `thread` (own isolate/thread), `process` (fork+exec, hard crash isolation), and
   `remote` (another cluster node). Code written against a Facade does not know or care
   whether its peer is in-isolate or on another machine. *This is the core asset — a
   distribution substrate where the topology is a deployment decision, not a rewrite.*

2. **Enforced, monotonic capability narrowing.** The import-rule system
   (`ImportMap.deny/inherit`, `state.rs` directives) is a real object-capability model:
   a child realm can only ever *narrow* what its parent granted, enforced in Rust at
   spawn time (`native.rs` `narrowing_check`) and at import time (`loader.rs`). A child
   cannot re-grant a blocked capability. Combined with `Facade` + `FacadeHandle`
   (stateful object-capabilities) and bidirectional streaming, this is a genuine
   security boundary for running untrusted or semi-trusted code.

3. **A wire format already shaped for QUIC.** The RPC envelopes map 1:1 onto QUIC
   request/response + unidirectional streams. `ClusterTransport` is abstracted;
   `WebSocketTransport` is today's only impl. The hard protocol-design work is done.

4. **Cross-node structured concurrency.** Realm lifecycle (run/watch/restart via exit-code
   75, terminate, `REALM_EXIT` propagation) already works across the cluster. Parent death
   tears down children; this is the skeleton of a reliable orchestrator.

5. **Embeddable vector-capable storage with pluggable I/O.** `fino:database/sqlite` binds system
   libsqlite3 over a **JS-implemented VFS** (function pointers are `FfiCallback`s), so
   SQLite transparently runs on disk, memory, or an S3/virtual filesystem — and
   `sqlite-vec` gives vector search in-process. No external database or vector store
   needed for memory/RAG workloads.

6. **Deep, fast FFI + `FfiCallback`.** Bind essentially any system library (sqlite,
   nghttp2, OpenSSL, libc) with a V8 Fast-API hot path and thread-pool async offload.
   `FfiCallback` lets C call back into JS. New capabilities rarely need new Rust.

7. **Single self-contained binary.** Thin Rust core, everything-in-JS stdlib baked in.
   Ships as one executable — trivial to deploy as an appliance or sidecar.

8. **Built-in observability.** First-class OpenTelemetry (traces/logs/metrics +
   instrumentations) and a per-realm V8 Inspector (CDP) — every realm is debuggable and
   traceable out of the box.

**The one-sentence thesis:** *fino is a distribution substrate where capability-secured,
independently-isolated units of JavaScript can be placed anywhere from "same isolate" to
"another datacenter" behind one programming model — which makes it unusually well-suited to
control planes and to safely running untrusted/AI-generated code at scale.*

### Honest weaknesses (these gate several niches)

- **Networking data plane is HTTP/1.1-only.** No HTTP/2 or HTTP/3 (abstractions are
  pre-wired but no driver), **no outbound connection pooling** (every `fetch()` is a fresh
  connect), **no mTLS** (client-cert surface absent), **no UDP/datagram class** (only raw
  FFI used by DNS), no SNI multi-cert. (See `roadmap.md` 4.1 for H2.)
- **Cluster is single-seed.** Seed is a SPOF/bottleneck (all PORT_MSG routed through it),
  no P2P data plane yet, **no transport auth (mTLS/token)**, no seed election. (See
  `cluster.md`.)
- **No distributed scheduling/discovery.** `RealmPool` can't place work across nodes;
  worker discovery is an open design question. (See `distribution.md`.)
- **Process realms can't transfer ports / capabilities** across the boundary (threads can
  via `transit.rs`). Limits ocap delegation in exactly the topologies a control plane wants.
- **No persistence / durable state engine** beyond SQLite; no built-in distributed
  consensus/KV; realm identity-across-restart is unspecified.
- **npm-ecosystem gaps** (`node:` aliases, `Buffer`, `process` shim) — adoption friction
  for the OSS lens. (See `roadmap.md` Tier 2.)

The pattern: *the substrate (realms, ocap, RPC) is mature; the data plane and operational
HA layers are deliberately deferred.* Most niches below are gated by 2–4 of these gaps, and
the gaps cluster — closing a handful unlocks multiple niches at once (see §6).

---

## 2. The three pillars

### Pillar A — Agent runtime ("Mastra on a capability-secured substrate")

**Why fino, not Node.** Every mainstream agent framework (Mastra, LangChain/LangGraph,
LlamaIndex, the OpenAI Agents SDK) runs in a *single trusting process*. Tools, MCP servers,
and especially LLM-generated code execute with the full ambient authority of the host. The
industry's hardest unsolved problem is *running agent-authored or third-party tool code
safely*, and the current answer is "spin up a Docker/Firecracker microVM per execution" —
heavy, slow to cold-start, and operationally painful.

fino collapses that. **Each agent, session, or tool call can run in a realm whose
capabilities are narrowed to exactly what it needs** — and the isolation tier is a dial:
`embedded` for cheap many-per-process tenancy with fast cold start, `process` for hard
crash isolation of a code-interpreter tool, `remote` to push execution to another node.
Same code. This is a category-defining wedge: *the agent framework whose tool sandbox is
the runtime itself, not a container around it.*

**Feature mapping to Mastra's surface:**

| Mastra concept | fino realization | Status of substrate |
|---|---|---|
| **Agents** (LLM + tools + memory) | An agent is a module; its tool surface is a set of `Facade`s; its authority is its import rules | Substrate ready |
| **Tools** (typed, MCP) | Tools are Facade methods (typed RPC). Untrusted/codegen tools run in narrowed child realms; MCP servers hosted as realms behind a Facade | Substrate ready; needs tool/MCP SDK |
| **Workflows** (graph, durable, suspend/resume) | Structured-concurrency realm graph; `watch`/reload (exit-code 75) is the suspend/resume primitive; durable state in `fino:database/sqlite` | Needs a durable-execution layer over realms |
| **Memory** (working + semantic recall) | `fino:database/sqlite` for thread/working memory; `sqlite-vec` for semantic recall — in-process, no external store | Substrate ready; needs memory API |
| **RAG** (chunk/embed/retrieve/rerank) | `sqlite-vec` vector store over pluggable VFS (S3-backed for serverless); embeddings via fetch to providers | Substrate ready; needs RAG toolkit |
| **Multi-agent networks** | Agents as realms; `remote` realms distribute them across machines with location-transparent messaging | Substrate ready (cluster); gated by cluster auth |
| **Evals / scoring** | Eval runs as isolated realms (reproducible, parallel via `RealmPool`) | Substrate ready; needs eval harness |
| **Observability** | Built-in OTel traces per agent step + per-realm V8 Inspector for live debugging | Best-in-class already |
| **Voice / streaming** | WebSocket + streaming bodies + SSE (`fino:net/http/eventsource`) | Transport ready |
| **Deployment** | Single binary; `remote` realms; appliance or serverless | Ready (self-host); serverless needs platform |

**Differentiating capabilities no competitor can easily match:**
- **Per-tool / per-session capability sandbox.** "This summarize tool may read the vector
  store but cannot open sockets or the filesystem" — expressed as import rules, enforced in
  Rust. Untrusted tool code and computer-use/code-interpreter become *safe by construction*.
- **MicroVM-grade isolation without a microVM.** `embedded` realms cold-start in
  microseconds (new V8 context, shared isolate) — thousands of concurrent agent sessions
  per process for multi-tenant agent SaaS, with `process`/`remote` escalation when a
  workload needs hard isolation.
- **Zero-dependency memory/RAG.** sqlite + sqlite-vec means an agent app has no external
  Postgres/pgvector/Pinecone dependency — it's one binary with a file (or an S3 bucket via
  the VFS).
- **Reproducible, parallel evals** via the realm pool — each eval in a clean, isolated realm.

**Headline product framings (across all three lenses):**
- *OSS:* `fino:agent` — the agent kit whose tool sandbox is the runtime. Wedge for mindshare.
- *Appliance:* a self-hosted "agent gateway" binary — runs an org's agents with per-tool
  capability policy and OTel, on-prem, behind their data boundary.
- *Commercial:* a multi-tenant agent-hosting control plane (per-customer realm isolation,
  fleet of `remote` agent nodes, central policy + observability) — the monetizable layer.

### Pillar B — Programmable networking data plane / appliance

**Why fino.** The connection-takeover primitive (`ConnectionTakeover._takeOver(reader,
writer)`) plus streaming bodies, backpressure, batched `writev`, and a clean
driver/protocol abstraction means fino was *architected for proxying*. The opportunity is a
**programmable proxy/gateway where filters and plugins run in capability-narrowed realms** —
think "Envoy's data plane, but plugins are sandboxed JavaScript instead of WASM/Lua, with a
realm-based control plane built in." This is also the natural substrate for a self-hostable
**Cloudflare-Workers-style edge runtime**.

**What's strong today:** HTTP/1.1 (pipelining, keep-alive, trailers), TLS (SNI, ALPN
client, peer verify), full RFC-6455 WebSocket (client+server, termination & relay), SSE,
DNS, connection hijack, OTel instrumentation on the socket/http path.

**What must be built (the data-plane investments, roughly in leverage order):**
1. **Outbound HTTP/1.1 connection pool** — the single highest-leverage fix. `H1ClientDriver`
   already declines to close; a pool layer over it unlocks every proxy/gateway/LB use case.
   `fetch()` being connect-per-request is disqualifying for upstream-heavy appliances today.
2. **`H2ServerDriver` / `H2ClientDriver`** — fills the pre-built abstraction, flips
   server-side ALPN beyond `http/1.1`, enables gRPC. (nghttp2 FFI binding already exists
   per the stdlib inventory — large but de-risked.)
3. **mTLS** — client-cert load + server `SSL_VERIFY_PEER`. Table stakes for zero-trust
   gateways and for the cluster-auth story in Pillar C.
4. **DNS caching + multi-address / Happy-Eyeballs** — required for a credible LB/gateway.
5. **`DatagramSocket` + `NetworkProvider` impls** — path to QUIC/HTTP3 and UDP load
   balancing. Longest pole; gates the H3/QUIC future.

**Appliance product framings:**
- *Self-host / OSS:* a programmable reverse proxy / API gateway as a single binary with
  JS plugins that are *capability-sandboxed* (a plugin can't exfiltrate — it only gets the
  Facade it's granted). Differentiator vs nginx/Envoy: plugins in a real language, safely.
- *Commercial:* the managed control plane for fleets of these gateways (config distribution,
  cert management, traffic policy) — see Pillar C; the data plane and control plane share
  the realm substrate.

### Pillar C — Distributed control planes (the substrate's native habitat)

**Why fino.** A control plane is, structurally, *exactly* what the realm cluster is: a
set of nodes running isolated units of logic, talking over a uniform RPC, with capability
scoping, lifecycle management, and structured teardown. fino lets you **build a control
plane and its agents/workers in one language and one programming model**, where "run this
component locally vs on that node" is a flag. Most control planes today are a polyglot mess
(Go control plane + per-language agents + gRPC IDL + a config DB + a message bus). fino
folds those into the substrate.

**The pattern fino makes cheap:** central orchestrator realm — fleet of `remote` worker
realms, each capability-narrowed to its job, lifecycle-managed (watch/restart/terminate),
observable (OTel), reconfigurable (hot-reload via exit-code-75), and addressable behind one
RPC. That is the spine of a dozen infrastructure products.

**Gating gaps for *production* control planes:** cluster auth (mTLS/token), seed HA / P2P
data plane, distributed scheduling + discovery, cross-process capability transfer, and a
durable state/consensus story. These are concentrated and shared — see §6.

---

## 3. Niche catalog (scored)

Scoring is 1–5. **Fit** = how well fino's *current* assets match. **Moat** = how hard for
incumbents/Node to replicate (driven by the ocap + realm-distribution combination).
**MVP-ease** = inverse cost (5 = cheap). **Primary gating gaps** = which §1 weaknesses
block it.

| # | Niche | Pillar | Fit | Moat | MVP-ease | Primary gating gaps |
|---|---|---|---|---|---|---|
| 1 | **Secure agent runtime / multi-tenant agent hosting** | A | 5 | 5 | 3 | cluster auth; durable-exec layer |
| 2 | **Untrusted code-execution sandbox** (code-interpreter, computer-use, eval-as-a-service) | A | 5 | 5 | 4 | process-realm cap transfer; resource limits |
| 3 | **Programmable API gateway / reverse proxy (sandboxed plugins)** | B | 4 | 4 | 3 | conn pool; mTLS; H2 |
| 4 | **Self-host edge-function platform (Workers-style)** | B/C | 4 | 4 | 2 | conn pool; scheduling; isolate resource limits |
| 5 | **Multi-tenant SaaS isolation runtime** (run customer code/plugins safely) | A/C | 5 | 5 | 3 | resource limits; cap transfer |
| 6 | **Distributed workflow / durable-execution engine** (Temporal-like) | C | 4 | 4 | 2 | durable state; scheduling; seed HA |
| 7 | **IoT / edge fleet control plane** (push capability-scoped logic to edge nodes) | C | 4 | 5 | 2 | cluster auth; P2P; offline/reconnect |
| 8 | **CI/CD runner orchestration** (isolated, capability-scoped job realms) | C | 4 | 3 | 3 | scheduling; process-realm limits |
| 9 | **Database connection proxy / query mesh** (sqlite-VFS angle) | B/C | 4 | 4 | 3 | conn pool; pgwire/mysql FFI |
| 10 | **Config / feature-flag / policy distribution plane** | C | 4 | 3 | 4 | seed HA; auth |
| 11 | **Embeddable RAG / vector-memory engine** (sqlite-vec, no external store) | A | 5 | 3 | 4 | none major (DX work) |
| 12 | **MCP host / tool-broker** (sandboxed MCP servers behind capability policy) | A | 5 | 4 | 4 | MCP SDK; cap transfer |
| 13 | **Service mesh sidecar / data plane** (JS plugins vs Envoy WASM) | B/C | 3 | 4 | 2 | H2; mTLS; UDP; pool |
| 14 | **Serverless FaaS runtime** (fast realm cold-start) | B/C | 4 | 4 | 2 | scheduling; resource limits; cold-start SLOs |
| 15 | **Blue/green & canary deploy controller** (watch/reload native) | C | 3 | 3 | 4 | scheduling |
| 16 | **Real-time collaboration / pub-sub fabric** (WebSocket + broadcast + realms) | B | 3 | 3 | 3 | P2P; seed HA |

### Reading the table

- **#1 + #2 + #5 are the same moat from three angles:** capability-secured execution of
  code you don't fully trust (agents, codegen, customer plugins). This is fino's deepest,
  most defensible territory and it spans all three product lenses. *Highest conviction.*
- **#11 + #12 are cheap, high-fit DX wins** that make Pillar A tangible and drive OSS
  adoption with little new infra. Good early bets to seed a community.
- **#3 + #4** are the strongest *appliance* plays but are gated on the connection-pool /
  H2 / mTLS data-plane investments — fund those and several niches unlock together.
- **#6 + #7** are the most ambitious *commercial control-plane* plays; highest moat,
  highest effort, gated on auth + HA + durable state.

---

## 4. Deep dive — the recommended lead wedge: capability-secured execution

The three named directions converge on one differentiator. Articulated as a product spine
that serves all three lenses:

**The primitive:** `runUntrusted(code, grants)` — a realm whose import rules are
`ImportMap.deny([...grants])`, where each grant is a `Facade` the host fully controls.
The code physically cannot reach any capability not in `grants`. Escalate isolation
(`embedded -> process`) for hostile code; escalate location (`-> remote`) for scale.

**What it powers:**
- *Agent tools / code interpreter (Pillar A):* LLM emits code; it runs with a grant set
  like `{ fetch: allowlistedHostsFacade, vectorStore: readOnlyFacade }` — no fs, no
  arbitrary egress. Crash-isolated in a `process` realm. This is the feature agent
  platforms are paying microVM costs for today.
- *Multi-tenant plugins (SaaS/appliance):* customers ship JS extensions that run with a
  scoped Facade to the host's API and nothing else.
- *Gateway plugins (Pillar B):* request/response filters as sandboxed realms on the
  data path.

**What must be added to make it production-grade:**
1. **Resource limits per realm** — CPU/wall-time deadline (terminate already exists; needs
   a deadline API), memory caps (V8 heap limits per isolate; `embedded` shares a heap so
   use `thread`/`process` for hard memory isolation), I/O quotas via the Facade layer.
2. **Cross-process capability transfer** — so a sandboxed `process` realm can be handed a
   live capability, not just spawned with static grants. (`transit.rs` does this for
   threads; extend to process/remote.)
3. **A grant/policy DSL** — ergonomic authoring of capability sets (the raw `ImportMap`
   is powerful but low-level).
4. **Auditing** — OTel spans for every capability invocation crossing a Facade (the RPC
   layer is the natural choke point; instrument it).

This wedge is recommended as the *narrative center* of fino's positioning because it (a) is
uniquely enabled by primitives that already exist, (b) is a top-of-mind unsolved problem in
the AI-agent market specifically, and (c) generalizes cleanly to the SaaS and gateway lenses.

---

## 5. Architecture sketch — `fino:agent` (Pillar A, deep)

A concrete shape for the agent framework so the design is falsifiable, not hand-wavy.
Layered, each layer leaning on an existing primitive:

```
fino:agent            Agent, run(), streaming, handoff           (new, JS)
fino:agent/tool       Tool defs, typed schema, MCP adapter       -> Facade RPC
fino:agent/sandbox    runUntrusted(code, grants)                  -> ImportMap.deny + Realm
fino:agent/memory     thread memory + semantic recall            -> fino:database/sqlite + sqlite-vec
fino:agent/rag        chunk / embed / retrieve / rerank          -> sqlite-vec + fetch
fino:agent/workflow   graph, step, suspend/resume, durable       -> realm watch/reload + sqlite
fino:agent/eval       scorers, datasets, parallel runs           -> RealmPool
fino:agent/net        multi-agent across nodes                   -> cluster remote realms
(observability)       per-step OTel spans, Inspector debugging   -> fino:opentelemetry
```

- **Agent** = a module + a model client (LLM via `fetch`) + a tool set (Facades) + a memory
  handle + an import-rule policy. `agent.run(input)` streams steps; tool calls dispatch
  over RPC; untrusted tools execute via `sandbox.runUntrusted`.
- **Memory** = a `fino:database/sqlite` database (working memory: messages/threads; semantic:
  `sqlite-vec`), pluggable VFS so the same code runs on local disk or S3 for serverless.
- **Workflow** = a graph of steps, each a realm; durability via journaling step results to
  SQLite + `watch`/reload to resume after a crash; suspend = persist + terminate, resume =
  respawn from journal. This reuses the realm-restart machinery rather than inventing a
  scheduler.
- **Eval** = dataset rows fanned out over `RealmPool` into isolated realms; deterministic,
  parallel, no cross-contamination.
- **Networks** = agents as `remote` realms; handoff is a Facade call; the cluster handles
  transport. Gated on cluster auth for production.

**Open questions to resolve in a follow-up design pass:** durable-workflow journal format
and exactly-once semantics; resource-limit API surface; the grant/policy DSL; MCP transport
mapping (stdio/SSE) onto Facades; model-client abstraction (provider-agnostic vs thin).

---

## 6. Cross-cutting enabling investments (unlock multiple niches at once)

These are the chokepoints. Each one lights up several catalog rows; ordered by
breadth-of-unlock x leverage. Items already tracked elsewhere are cross-referenced.

1. **Per-realm resource limits** (CPU/wall deadline, memory cap, I/O quota). *Unlocks:*
   #1,#2,#4,#5,#14 — every untrusted-execution and FaaS niche. Highest breadth.
2. **Outbound HTTP/1.1 connection pool.** *Unlocks:* #3,#4,#9,#13 — every
   proxy/gateway/LB. Cheapest high-leverage data-plane fix (`H1ClientDriver` already
   supports it).
3. **Cluster transport auth (mTLS/token) + seed HA / P2P data plane.** *Unlocks:*
   #1,#6,#7,#10,#16 — every production cross-node control plane. (See `cluster.md`
   items 1 and 3; pair with the mTLS work below.)
4. **Distributed scheduling + worker discovery** (answer `distribution.md` Q1/Q2 first).
   *Unlocks:* #4,#6,#8,#14 — anything that places work across the fleet.
5. **mTLS** (client-cert + server verify). *Unlocks:* #3,#13 directly and is a
   prerequisite for cluster auth (#3 above). (FFI primitives mostly present in
   `openssl.mts`.)
6. **Cross-process/remote capability transfer.** *Unlocks:* #2,#5,#7,#12 — ocap
   delegation in process/remote topologies (extend `transit.rs` model).
7. **Durable state / journal primitive** (over `fino:database/sqlite`, optional distributed KV
   later). *Unlocks:* #6,#7,#10 — durable workflows and config planes.
8. **HTTP/2 driver** then **UDP/QUIC**. *Unlocks:* #3,#13 (gRPC), then the H3/QUIC
   future and mesh credibility. (See `roadmap.md` 4.1.) Largest effort; sequence last.
9. **npm-compat basics** (`node:` aliases, `Buffer`, `process` shim — `roadmap.md`
   Tier 2). Not a niche unlocker but the dominant *adoption* lever for the OSS lens;
   cheap; do early.

**Dependency shape:** mTLS (5) is a prerequisite for cluster auth (3); distributed
scheduling (4) depends on cluster auth (3); durable state (7) underpins workflows (#6)
which underpins `fino:agent/workflow` (§5). Resource limits (1) and conn pool (2) are
independent and should go first.

---

## 7. Positioning across the three lenses

The substrate is one thing; the three lenses are packaging:

- **OSS framework (adoption engine):** ship `fino:agent` (§5) and a programmable-proxy
  toolkit (Pillar B) as open libraries. Lead with the unique wedge (capability-sandboxed
  tools/plugins) + zero-dependency RAG. Lower npm-compat friction (§6.9). Goal: developer
  mindshare and a reference workload.
- **Self-host appliance (the credible single-binary product):** package the agent gateway
  and programmable API gateway as deployable binaries with capability-policy + OTel built
  in. Sells on "real-language plugins that are actually sandboxed" and "no external vector
  DB / no microVM." Goal: teams running it inside their own boundary.
- **Commercial control plane (the monetization layer):** the managed plane that operates
  *fleets* of those appliances/agents — multi-tenant isolation, central policy, fleet
  config/cert distribution, cross-node scheduling, observability. This is where the
  cluster-auth/HA/scheduling investments (§6.3, §6.4) pay off and where recurring revenue
  lives. Goal: the product that the OSS + appliance funnels lead into.

The strategic point: **the same realm-distribution + ocap substrate is the OSS library, the
appliance, and the SaaS control plane** — the lenses differ only in packaging and the
operational-maturity investments each requires.

---

## 8. Suggested sequencing (conviction-ordered, not a commitment)

1. **Seed the OSS wedge cheaply:** `fino:agent/memory` + `/rag` (#11) and `/tool` + MCP
   host (#12) — high fit, low new-infra, makes the agent story tangible. Land npm-compat
   basics (§6.9) in parallel.
2. **Build the lead differentiator:** `runUntrusted` + per-realm resource limits (§4, §6.1)
   — unlocks #1/#2/#5 and is the headline nobody else has.
3. **Fund the data plane:** connection pool (§6.2) then mTLS (§6.5) — unlocks the appliance
   gateway (#3) and prepares cluster auth.
4. **Make the cluster production-grade:** transport auth + seed HA/P2P (§6.3), then
   scheduling/discovery (§6.4, after the `distribution.md` design pass) — unlocks the
   commercial control-plane niches (#6/#7/#10).
5. **Long poles:** durable-execution layer (§6.7, targets #6), HTTP/2 (§6.8, gRPC/#13),
   then UDP/QUIC (H3 future).

---

## Appendix — capability to source-of-truth map

For readers verifying claims against the code:

- Realms / modes / lifecycle: `js/realm/index.mts`, `src/realm/{mod,native,child,bridge}.rs`
- Capability narrowing: `src/state.rs` (directives), `src/realm/native.rs` (`narrowing_check`),
  `src/loader.rs` (block/remap enforcement)
- RPC / Facade / streaming / handles: `js/realm/index.mts`, `js/internal/.../parent-rpc.mts`,
  `src/realm/synthetic.rs`; cross-thread port transfer: `src/realm/transit.rs`
- Cluster / remote realms / transport: `js/cluster/*`, `docs/research/cluster.md`
- Networking: `js/net/{dns,socket,tls}.mts`, `js/net/http/*.mts`,
  `js/internal/openssl.mts`, `js/net/socket.mts`; gaps noted in §1
- FFI / callbacks: `src/ffi/{mod,call,closure,pointer,fast}.rs`
- Async / event loop: `src/async_rt/*`, `src/runtime.rs`, `js/internal/runtime/loop.mts`
- SQLite / vector / VFS: `js/sqlite/*`, `js/sqlite.mts`
- Observability: `fino:opentelemetry`, `internal:inspector` (`src/inspector_module.rs`)
- Existing roadmap and research: `docs/roadmap.md`,
  `docs/research/{cluster,distribution,virtual-io}.md`
