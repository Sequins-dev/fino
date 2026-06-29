---
weight: 10
---
# Realm

A realm is a self-contained JavaScript execution context: its own module graph, its own global object, its own microtask queue. Code running inside a realm cannot reach objects in the parent except through explicit channels — ports, facades, or broadcast. The parent chooses what imports the child can make, so the capability surface is controlled at construction time.

Realms come in four execution modes. An embedded realm shares the current V8 isolate and OS thread. A thread realm gets its own V8 isolate and OS thread. A process realm runs in a separate OS process. A remote realm runs on a machine in a `fino:cluster`. Within each mode the import rule system, messaging API, facade mechanism, and watch mode work the same way, so you can move from embedded to thread to process as isolation requirements change without rewriting application logic.

## Guide map

- **lifecycle** — Creating realms, running them, calling into them, and controlling their lifetime, including watch mode for auto-reload on file changes.
- **isolation** — Choosing between embedded, thread, process, and remote modes, and what each mode costs and provides.
- **messaging** — Exchanging messages between parent and child using ports and `BroadcastChannel`.
- **facades** — Exposing parent-side logic to the child as a virtual module the child can import and call like any other module.
- **capabilities** — Shaping what a child realm is allowed to import, using import rules and provider configs.
- **pools** — Running repeated independent tasks across a pool of warm thread realms with load-based dispatch.
