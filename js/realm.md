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

Realms come in four execution modes. An embedded realm shares the current V8
isolate and OS thread. A thread realm gets its own V8 isolate and OS thread. A
process realm runs in a separate OS process. A remote realm runs on a machine
in a `fino:cluster`. Within each mode the import rule system, messaging API,
facade mechanism, and watch mode work the same way, so you can move from
embedded to thread to process as isolation requirements change without
rewriting application logic.

The guides in this section:

- [Realm Lifecycle](./realm/lifecycle.md) — creating realms, running them,
  calling into them, and controlling their lifetime, including watch mode for
  auto-reload on file changes.
- [Isolation Levels](./realm/isolation.md) — choosing between embedded,
  thread, process, and remote modes, and what each mode costs and provides.
- [Messaging](./realm/realm-messaging.md) — exchanging messages between parent
  and child using ports and `BroadcastChannel`.
- [Facades](./realm/facades.md) — exposing parent-side logic to the child as a
  virtual module the child can import and call like any other module.
- [Import Capabilities](./realm/capabilities.md) — shaping what a child realm
  is allowed to import, using import rules and provider configs.
- [Realm Pools](./realm/pools.md) — running repeated independent tasks across
  a pool of warm thread realms with load-based dispatch.
