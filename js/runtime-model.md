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

## Capabilities and Isolation

Because runtime APIs arrive through imports rather than ambient globals, an
import is effectively a capability: code can only use what it can import. For
the main application that is a code-review property. For child realms it is an
enforced boundary.

A realm is an isolated JavaScript environment with its own global object, module
graph, microtask queue, and event loop state. Realms are used for sandboxing,
worker-style execution, reloadable application contexts, and stronger isolation
when needed. The parent decides exactly what a child may import — starting from
a deny-all baseline for untrusted code, or inheriting most capabilities and
blocking dangerous ones for trusted workers. Children cannot grant themselves
modules the parent has denied:

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

Realms run embedded in the current isolate, in their own thread, in a separate
process, or on a remote cluster machine, with the same import-rule, messaging,
and facade model in every mode. See the [Realms section](./realm.md), and
[Import maps](./realm/import-maps.md) for the rule system.

Process execution adds an operating-system boundary on top. `fino:process` can
request sandbox policies (filesystem, network, process, resource limits) for
child processes and reports what the current platform can enforce: strict mode
fails closed when a requested boundary is unavailable, and best-effort mode
reports unsupported policy categories instead of pretending they were enforced.
The process and sandbox APIs are documented in the generated API reference.

## Context and Topics

The context APIs provide async-local state, and topics provide publish/subscribe
style coordination. They are used by runtime systems such as OpenTelemetry and
the realm scheduler, and they are useful when application code needs
request-scoped state or decoupled event publishing.

Use context for values that should flow through async work, such as request
IDs. A `Context` value follows the causal chain of async execution — `await`,
`.then()`, `queueMicrotask()`, timers, and promise-based runtime APIs:

```ts
import { Context } from 'fino:context';

const requestId = new Context<string>('requestId');

await requestId.runWithValue('req-1', async () => {
  await Promise.resolve();
  console.log(requestId.get()); // 'req-1' — propagated through await
});
```

Use topics for named events that may have zero or more subscribers:

```ts
import { topic } from 'fino:context/topic';

const logins = topic<{ user: string }>('audit:login');
logins.subscribe((event) => console.log('login:', event.user));
logins.publish({ user: 'ana' });
```

## API Shape

Public APIs prefer JavaScript data structures, web-compatible objects, and async
iteration. For example, HTTP uses `Request`, `Response`, and `Headers`; file and
network bodies are usually byte streams; formats expose parse and stringify
helpers; and SQLite exposes databases, statements, rows, and bound parameters.

Start with the highest-level module that matches the task. Drop to lower-level
helpers only when you are building a protocol tool, parser, custom transport, or
runtime extension.
