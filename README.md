![fino logo](./logo.svg)

# fino

Fino is a JavaScript runtime for building agentic applications: tools that call
models, expose actions, run untrusted or reloadable code, serve HTTP APIs, and
keep their capabilities explicit. Instead of scattering those concerns across a
pile of services and framework glue, Fino combines ordinary TypeScript with
strong execution boundaries — a permissioned module system, isolated realms,
sandbox-aware processes, and built-in AI and observability subsystems — in one
runtime.

[Download the latest Fino release](https://github.com/Sequins-dev/fino/releases/latest)
for Linux (x64 or arm64) or macOS (Apple silicon), or
[browse the source on GitHub](https://github.com/Sequins-dev/fino).

## A Streaming Support Agent

An agent with a validated tool, streaming its answers over server-sent events
from an HTTP route:

```ts
import { agent, openai, streamText, tool } from 'fino:ai';
import { App } from 'fino:net/http/app';
import { v } from 'fino:validate';

const lookupTicket = tool({
  name: 'lookup_ticket',
  description: 'Read a support ticket by id.',
  parameters: v.object({
    id: v.string().describe('Ticket id, such as T-1001'),
  }),
  execute: async ({ id }: { id: string }) => {
    return JSON.stringify({ id, status: 'open', plan: 'business' });
  },
});

const assistant = agent({
  model: openai({ model: 'gpt-4o' }), // reads OPENAI_API_KEY from the env
  instructions: 'Answer as a concise support engineer.',
  tools: [lookupTicket],
});

const app = new App();

app.route('/chat').sse(async (events, ctx) => {
  const { message } = await ctx.request.json();

  for await (const text of streamText(assistant.stream(message))) {
    await events.write({ data: JSON.stringify(text) });
  }
  await events.write({ event: 'done', data: '{}' });
});

app.listen({ port: 3000 });
```

Run it and talk to it:

```sh
fino run --watch app.ts
```

```sh
curl -N -H 'content-type: application/json' \
  -d '{"message":"What is the status of ticket T-1001?"}' \
  http://127.0.0.1:3000/chat
```

The model calls the validated tool, and the reply streams back token by token
as SSE events. Everything in the example — the agent loop, tool validation,
router, and streaming response — is built into the runtime.

## Quick Start

Fino builds from source with a Rust toolchain:

```sh
git clone https://github.com/Sequins-dev/fino.git
cd fino
cargo build --release
export PATH="$PWD/target/release:$PATH"
```

Then run a script, a server, or tests:

```sh
fino ./hello.ts
fino test tests
```

[Getting Started](./js/getting-started.md) walks from a first script to a
model-calling program.

## Requirements

Native libraries for specific features are optional: install only those for the
features you use. The current runtime also needs a loadable zlib (`libz`) at
startup because its global compression and fetch modules import `fino:compress`.
A library may already be included in a release binary or provided by the
operating system; the table describes the required capability, not an extra
install step in every environment.

| Library | Required when using | Other modules that depend on it |
| --- | --- | --- |
| OpenSSL `libcrypto` | `crypto` / `crypto.subtle`, `fino:security/*` cryptographic operations, `fino:uuid` generation | Cryptographic features in `fino:storage`, `fino:email`, `fino:webhooks`, `fino:database/migrate`, PostgreSQL SCRAM authentication, HTTP/WebSocket integrity and handshakes, and QUIC randomness. These dependencies also apply when those features are reached through higher-level modules. |
| OpenSSL `libssl` (with `libcrypto`) | `fino:net/tls`, HTTPS and secure WebSockets | TLS connections through `fetch`, `fino:net/http/client`, `fino:net/http/server`, and `fino:database/postgres`; HTTP/2 over TLS and the OpenSSL QUIC backend. Plain HTTP and cleartext database connections do not need `libssl`. |
| `libnghttp2` | HTTP/2 through `fetch`, `fino:net/http/client`, or `fino:net/http/server` | HTTP/2 routes in `fino:net/http/app`. TLS based HTTP/2 also needs OpenSSL. |
| `libngtcp2` plus a crypto backend (`libngtcp2_crypto_ossl` with OpenSSL, or `libngtcp2_crypto_gnutls` with GnuTLS) | `fino:net/quic` connections | HTTP/3 and WebTransport through the HTTP client/server APIs. QUIC also uses OpenSSL `libcrypto` for randomness, including with the GnuTLS backend. |
| `libnghttp3` | HTTP/3 through `fetch` or the HTTP client/server APIs | HTTP/3 and WebTransport routes in `fino:net/http/app`; also requires the QUIC libraries above. |
| `libsqlite3` | `fino:database/sqlite` | `sqliteStore()` in `fino:store`, SQLite datasets, SQLite-backed AI cache and memory, and the SQLite provider in `fino:database`. The optional `sqlite-vec` extension accelerates vector search; those features can fall back without it. |
| zlib (`libz`) | Runtime startup; `fino:compress` gzip/deflate formats and compression stream globals | ZIP and tar.gz in `fino:archive`, gzip Parquet pages, HTTP content compression, and WebSocket permessage-deflate. |
| Brotli (`libbrotlienc` and `libbrotlidec`), `libzstd`, `liblz4`, or `libsnappy` | The matching `fino:compress` format | Matching Parquet page codecs use Brotli, Zstandard, or Snappy; LZ4 Frame is available through `fino:compress`. Each format needs only its own library (Brotli needs both). |
| llama.cpp `libllama` | Local GGUF models through `fino:ai/model/local` | `libggml` and its compute backends may be loaded alongside `libllama` when present. Remote model providers do not need llama.cpp. |

Most optional bindings can be imported without their library installed; using
the affected feature then reports that it is unavailable.

## Why Fino

**AI is a runtime subsystem, not an afterthought.** `fino:ai` provides
provider-neutral model calls, agents, validated tools, durable sessions, MCP
adapters, evals, skills, and memory, designed to work with the rest of the
runtime: routes, realms, OpenTelemetry, and sandboxed processes. See the
[AI section](./js/ai.md).

**Imports are permissions.** Runtime APIs are imported through public `fino:*`
modules instead of one ambient global bag, so what code can do is visible in
review — and enforceable for children. A parent decides exactly what a child
realm may import, starting from a deny-all baseline for untrusted code;
children cannot grant themselves modules the parent has denied. See
[Import Capabilities](./js/realm/capabilities.md).

```ts
import { ImportMap, Realm } from 'fino:realm';

const realm = new Realm({
  entry: './skill.ts',
  overrides: ImportMap.deny([
    { pattern: './skill.ts', directive: 'inherit' },
    { pattern: 'fino:ai/tool', directive: 'inherit' },
    { pattern: 'fino:validate', directive: 'inherit' },
  ]),
});

await realm.run();
```

**Realms are built in.** A realm is an isolated JavaScript execution context
with its own global object, module graph, and event loop state, and it can run
embedded, in a thread, in a process, or remotely — with the same messaging,
facade, and import-rule model in every mode. Use realms for plugin hosts,
skill execution, and reloadable workers. See [Realms](./js/realm.md).

**Sandboxing is part of process execution.** Process APIs can request sandbox
policies — filesystem, network, process, resource limits — and report what the
platform can enforce. Strict mode fails closed when a requested boundary is
unavailable rather than pretending it was enforced. See the
[runtime model](./js/runtime-model.md).

**HTTP apps get a real router.** `fino:net/http/app` provides middleware,
validated bodies and schemas, sessions, cookies, WebSocket, SSE, and
WebTransport routes, and OpenAPI generation while preserving plain `Request`
and `Response`. See [HTTP](./js/net/http.md).

**Observability is expected.** A full OpenTelemetry implementation — traces,
metrics, logs, propagation, runtime instrumentations — plus benchmark, doc,
and profiling commands make agent behavior and runtime performance measurable
from the start. See [OpenTelemetry](./js/opentelemetry.md).

Beyond those: background jobs, durable workflows, a task model shared by the
CLI and AI tools, Arrow and Parquet data tooling, SQLite, and more — indexed
in the [documentation map](./js/documentation.md).

## Documentation

- [Getting Started](./js/getting-started.md) — install to first agent.
- [Documentation map](./js/documentation.md) — every guide, organized by goal.
- [AI](./js/ai.md) — models, tools, agents, sessions, evals, MCP.
- [Realms](./js/realm.md) — isolation, capabilities, messaging, pools.
- [HTTP](./js/net/http.md) — serving, routing, clients, WebSockets, SSE.
- [Runtime Model](./js/runtime-model.md) — the concepts behind it all.

On the generated docs site the full API reference sits alongside these guides;
build it locally with `fino doc build --format html js`.

## Project Status

Fino is experimental and under active development. Some APIs are broad, some
are new, and Node/npm ecosystem compatibility is intentionally partial. Treat
documented public `fino:*` modules and authored guides as the supported
application surface, and expect low-level internals to change as the runtime
evolves.

For build instructions, repository layout, and development workflow, see
[CONTRIBUTING](https://github.com/Sequins-dev/fino/blob/main/CONTRIBUTING.md).
