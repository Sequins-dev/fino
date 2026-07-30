---
weight: 15
---
# Documentation

This page is the map of Fino's documentation: every authored guide, organized
by what you are trying to do, plus how to browse and search the generated API
reference. If you are brand new, start with
[Getting Started](./getting-started.md).

## Build an Agent

The [AI section](./ai.md) is the front door: model calls, validated tools,
agents, sessions, and how the layers fit together.

- [Model Requests](./ai/model-requests.md) — one-off stateless calls: provider
  adapters, streaming events, embeddings, response assembly.
- [Complex Tools](./ai/complex-tools.md) — tool design beyond simple lookups:
  subprocesses, agents as tools, approval gates.
- [Interactive CLI Harness](./ai/interactive-cli-harness.md) — a local
  terminal harness for developing prompts, tools, and sessions.
- [Agent MCP Server](./ai/agent-mcp-server.md) — exposing tools and resources
  to external clients over the Model Context Protocol.
- [Evals and OpenTelemetry](./ai/evals-opentelemetry.md) — protecting AI
  behavior like tests, with scorers, reporters, and traces.
- [Skills](./ai/skills.md) — optional expert instructions and tools, loaded
  only when relevant.

## Isolate Code

The [Realms section](./realm.md) covers the runtime's isolation primitive —
run skills, plugins, and untrusted code with only the imports you grant.

- [Realm Lifecycle](./realm/lifecycle.md) — creating, running, calling into,
  and reloading realms.
- [Isolation Levels](./realm/isolation.md) — reactor-pooled, process, and remote
  modes and their trade-offs.
- [Messaging](./realm/realm-messaging.md) — ports and `BroadcastChannel`
  between parent and child.
- [Facades](./realm/facades.md) — exposing parent-side logic as a virtual
  module the child imports.
- [Import Capabilities](./realm/capabilities.md) — the import rule system that
  shapes what a child may load.

## Serve an Application

The [Networking section](./net.md) spans Fetch-style HTTP down to sockets,
TLS, DNS, and QUIC. The [HTTP section](./net/http.md) dispatches to the right
surface for what you are building:

- [HTTP Server](./net/http/serving.md) — `serveHttp()`, `serve()`, upgrades,
  and lifecycle.
- [Routing and Middleware](./net/http/routing.md) — `App`, middleware, body
  and schema validation, cookies, sessions, OpenAPI.
- [HTTP Client](./net/http/http-client.md) — `fetch()` and `HttpClient`
  policies, sessions, and metadata.
- [WebSockets](./net/http/websockets.md) — client global and server-side
  connections.
- [Server-Sent Events](./net/http/server-sent-events.md) — `route().sse()` operations,
  `EventSourceWriter`, and SSE parsing.
- [WebTransport](./net/http/web-transport.md) — bidirectional transport over
  HTTP/3.
- [Protocol Versions and Transport](./net/http/protocols.md) — HTTP/1.1, h2,
  h3, ALPN, and TLS configuration.
- [Server-Driven Web UI](./ui/web.md) — progressive enhancement, live SSE
  patches, cleanup, deployment, and operational guidance.

## Observe It

The [OpenTelemetry section](./opentelemetry.md) explains the provider/SDK
architecture; the deep dives cover
[Manual Tracing](./opentelemetry/tracing.md),
[Metrics](./opentelemetry/instruments.md),
[Structured Logs](./opentelemetry/logging.md),
[SDK Setup](./opentelemetry/sdk-setup.md),
[Exporters and CLI Bootstrap](./opentelemetry/exporters.md),
[Context Propagation](./opentelemetry/propagation.md), and
[Runtime Instrumentations](./opentelemetry/instrumentations.md).

## Platform

- [Getting Started](./getting-started.md) — install, first script, first
  server, first agent, tests, packages.
- [Runtime Model](./runtime-model.md) — modules, globals, the event loop, byte
  streams, capabilities and isolation, context and topics.
- [Modules and Packages](./modules-and-packages.md) — the import model, public
  API boundaries, and npm installation.
- [Testing and Benchmarking](./testing-and-benchmarking.md) — the built-in
  test framework, mocks, and benchmark harness.
- [Data](./data.md) — Apache Arrow and Parquet tooling.
- [Machine Learning](./ml.md) — shared metrics for classification, ranking,
  regression, calibration, and similarity.
- [Text](./text.md) — tokenizers: loading published BPE and WordPiece
  vocabularies, offsets, and tokenizing a dataset.
- [Models](./model.md) — resolving models and datasets from a hub, with
  content-addressed caching and a `models.lock` pin.
- [Native FFI](./native-ffi.md) — loading native libraries and binding C ABI
  functions.
- [Profiling](./profiling.md) — JS CPU profiles and native profiling paths.

The [CLI guide](./cli.md) maps every command:
[run](./cli/run.md), [repl](./cli/repl.md), [test](./cli/test.md),
[bench](./cli/bench.md), [task](./cli/task.md), [init](./cli/init.md),
[install](./cli/install.md), [doc](./cli/doc.md), [fmt](./cli/fmt.md), and
[lint](./cli/lint.md).

## API Reference

Every public `fino:*` module is documented from its source doc comments, and
some modules — background jobs (`fino:jobs`), tasks (`fino:task`), workflows
(`fino:workflow`), validation (`fino:validate`), files, formats, SQLite,
processes, and the security helpers among them — are documented there rather
than in an authored guide.

On the generated docs site, the API reference appears alongside these guides
in the sidebar. To build and search it locally:

```sh
fino doc build --format html --types runtime-builtins.d.ts js
fino doc search websocket
fino doc show bench.Group.measure
```

Generated output is written under `docs/`. See the [doc command](./cli/doc.md)
for the full workflow, including runnable documentation examples.
