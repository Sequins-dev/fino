---
weight: 20
---
# Runtime Model

Fino is organized around a few user-visible concepts: ES modules, built-in
`fino:*` APIs, an event loop, async byte streams, and optional realms for
isolated execution. You can use it for scripts, services, tests, benchmarks, and
tools without learning how the runtime is built.

## Built-In Modules

Public runtime modules use `fino:*` specifiers:

```ts
import { serveHttp } from 'fino:net/http/server';
import { DiskFileSystem } from 'fino:file';
import { parse } from 'fino:format/toml';
```

Application code should depend on public `fino:*` modules, local project
modules, and installed packages.

## Global Surface

Fino installs Web-style globals such as timers, `console`, `fetch`, URL
classes, `Blob`, `File`, `FormData`, Web Streams, `crypto`, `structuredClone`,
`MessageChannel`, and `BroadcastChannel`. `self` aliases `globalThis`.

The runtime also exposes a deliberately small `navigator` object with a Fino
user agent. It is not a browser navigator implementation, and it does not
promise fields such as hardware concurrency, language, platform, permissions,
or service-worker state.

Node globals are not installed by default. Use `fino:process` for process
metadata, child processes, stdio, environment variables, and `exit()`; do not
expect `globalThis.process`, `Buffer`, CommonJS globals, or Node's process event
APIs to exist.

`reportError(error)` writes an unhandled-error diagnostic to stderr and returns.
Fino does not currently implement browser `unhandledrejection` /
`rejectionhandled` events. Top-level entry errors and top-level await
rejections still propagate through the root CLI and produce a nonzero exit.

## Event Loop

The event loop keeps asynchronous work moving. Network sockets, file
operations, timers, child realms, and other asynchronous resources resume
JavaScript when progress is possible.

Most application code should not manually drive the loop. Write async functions,
consume async iterables, and let the runtime keep the loop alive while resources
such as servers, sockets, watchers, or child realms are open.

Runtime modules use a small set of stable loop helpers rather than depending on
one operating-system backend directly. Timers, file-descriptor readiness and
writability, wake sources, vnode/file-watch hooks, and completion submission are
implemented by the active backend for the current platform. The exact hook
mechanism may differ between backends, but JavaScript code should see the same
observable contract: pending async work wakes the loop, readiness callbacks are
rescheduled after backpressure or `EAGAIN`, and completed operations resume
their waiting promises through the runtime loop.

## Byte Flow

Fino's lower-level I/O APIs often represent streams as
`AsyncIterable<Uint8Array>`. That keeps transport code simple and lets files,
sockets, TLS, HTTP bodies, WebSockets, and parser pipelines compose without
requiring every layer to depend on a single stream class.

For example, an HTTP response body can be a string, bytes, or an async iterable:

```ts
async function* lines() {
  yield new TextEncoder().encode('one\n');
  yield new TextEncoder().encode('two\n');
}

return new Response(lines(), {
  headers: { 'content-type': 'text/plain; charset=utf-8' },
});
```

When an API accepts or returns an async iterable body, consume it once. Bodies
usually represent live I/O rather than reusable in-memory values.

## Realms

A realm is an isolated JavaScript environment with its own global object, module
graph, microtask queue, and event loop state. Realms are used for sandboxing,
worker-style execution, reloadable application contexts, and stronger isolation
when needed.

The parent controls what a child can import:

```ts
import { ImportMap, Realm } from 'fino:realm';

const realm = new Realm({
  entry: './worker.ts',
  overrides: ImportMap.deny([
    { pattern: './worker.ts', directive: 'inherit' },
    { pattern: 'fino:format/*', directive: 'inherit' },
  ]),
});

await realm.run();
```

Use the [realms guide](./realm/guide.md) for import rules, message
ports, facades, threads, processes, and pools.

## Context and Topics

The context APIs provide async-local state, and topics provide publish/subscribe
style coordination. They are used by runtime systems such as OpenTelemetry and
realm pools, and they are useful when application code needs request-scoped
state or decoupled event publishing.

Use context for values that should flow through async work, such as request IDs.
Use topics for named events that may have zero or more subscribers.

## API Shape

Public APIs prefer JavaScript data structures, web-compatible objects, and async
iteration. For example, HTTP uses `Request`, `Response`, and `Headers`; file and
network bodies are usually byte streams; formats expose parse and stringify
helpers; and SQLite exposes databases, statements, rows, and bound parameters.

Start with the highest-level module that matches the task. Drop to lower-level
helpers only when you are building a protocol tool, parser, custom transport, or
runtime extension.
