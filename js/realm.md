---
weight: 110
---
# Realms

A realm is a self-contained JavaScript execution context: its own module graph,
its own global object, its own microtask queue. Code running inside a realm
cannot reach objects in the parent except through explicit channels — ports,
facades, or broadcast. The parent chooses what imports the child can make, so
the capability surface is controlled at construction time.

That makes realms the runtime's isolation primitive for agentic systems: a
loaded skill, a model-invoked tool, a plugin, or any other code the
application did not write can run with exactly the modules it was granted and
nothing else. The same primitive covers ordinary worker-style execution and
reloadable application contexts.

Every ordinary realm is one V8 isolate hosted and scheduled by a reactor
thread. Node orchestration chooses the reactor and, when clustering is enabled,
cluster orchestration will first choose the node. Declare scheduling intent
with `priority`: `'background'` realms run on the batch reactor pool so
sync-heavy work never contends with latency-class realms, and the orchestrator
also demotes realms that repeatedly blow the synchronous-slice budget.
`RealmDeployment` composes independent realm replicas when scaling is
required. Use `process: true` only when an OS-process isolation boundary is
required; it does not create a separate Realm API.

The guides in this section:

- [Realm Lifecycle](./realm/lifecycle.md) — creating realms, running them,
  calling into them, and controlling their lifetime, including watch mode for
  auto-reload on file changes.
- [Isolation and Placement](./realm/isolation.md) — orchestrated placement,
  local mobility, and optional process isolation.
- [Messaging](./realm/realm-messaging.md) — exchanging messages between parent
  and child using ports and `BroadcastChannel`.
- [Facades](./realm/facades.md) — exposing parent-side logic to the child as a
  virtual module the child can import and call like any other module.
- [Import Capabilities](./realm/capabilities.md) — shaping what a child realm
  is allowed to import, using import rules and provider configs.
