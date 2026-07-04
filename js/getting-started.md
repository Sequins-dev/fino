---
weight: 10
---
# Getting Started

Fino is a JavaScript runtime for building agentic applications: model calls,
validated tools, isolated realms, HTTP services, and tests, all from one
binary. Runtime APIs are imported through `fino:*` specifiers.

This guide is the shortest path from a built `fino` command to a useful
program.

## Install

Fino builds from source with a Rust toolchain:

```sh
git clone https://github.com/Qard/fino.git
cd fino
cargo build --release
```

The binary is `target/release/fino`. Put it on your `PATH`, or substitute
`./target/release/fino` for `fino` in the commands below.

## Run a Script

Create `hello.ts` and import runtime APIs with `fino:*` specifiers:

```ts
import { parse } from 'fino:format/toml';

const config = parse(`
name = "demo"
port = 3000
`);

console.log(config.name, config.port);
```

Fino modules are regular ES modules. Use relative imports for your own files
and `fino:*` imports for built-in runtime modules.

Run the script:

```sh
fino ./hello.ts
```

## Start an HTTP Server

The HTTP server API is intentionally close to Fetch's `Request` and `Response`
model:

```ts
import { serveHttp } from 'fino:net/http/server';
import { env } from 'fino:process';

const port = Number(env.PORT ?? 3000);

const server = serveHttp({ port }, async (request) => {
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    return Response.json({ ok: true });
  }

  return new Response('hello from fino\n', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
});

console.log(`listening on http://127.0.0.1:${server.port}`);
```

Run it:

```sh
PORT=3000 fino ./server.ts
```

The [HTTP section](./net/http.md) covers routing, request bodies, streaming
responses, server-sent events, WebSockets, and graceful shutdown.

## Call a Model

`fino:ai` provides provider-neutral model calls, agents, and validated tools.
This step needs a provider credential — the `openai` adapter reads
`OPENAI_API_KEY` from the environment — and is safe to skip until you have one:

```ts
import { agent, openai, streamText } from 'fino:ai';
import { stdout } from 'fino:process';

const bot = agent({
  model: openai({ model: 'gpt-4o' }),
  instructions: 'Answer in one short paragraph.',
});

const encoder = new TextEncoder();
for await (const text of streamText(bot.stream('What is a JavaScript realm?'))) {
  await stdout().write(encoder.encode(text));
}
```

```sh
OPENAI_API_KEY=... fino ./ask.ts
```

Agents grow from here: validated tools, structured output, durable sessions,
and MCP are covered in the [AI section](./ai.md).

## Add Tests

Fino includes a TAP-producing test framework:

```ts
import { test } from 'fino:test/test';

test('math still works', (t) => {
  t.equal(1 + 1, 2);
});
```

Run a file:

```sh
fino test ./math.test.ts
```

Run a directory of tests:

```sh
fino test tests
```

The [testing and benchmarking guide](./testing-and-benchmarking.md) explains
test structure, filters, assertions, mocks, and benchmark files.

## Install Packages

Initialize a package and install dependencies when your code needs npm modules:

```sh
fino init --yes
fino install semver
```

Installed packages are stored under `.fino/`, and Fino writes a package map that
the module loader uses when resolving bare package specifiers.

See [modules and packages](./modules-and-packages.md) for the import model.

## Where to Go Next

- The [AI section](./ai.md) covers models, tools, agents, sessions, evals,
  skills, and MCP — the heart of an agentic application.
- [Realms](./realm.md) covers isolated execution: run skills, plugins, and
  untrusted code with only the imports you grant.
- The [documentation map](./documentation.md) indexes every guide and explains
  how to browse and search the generated API reference.
