# Getting Started

Fino is a JavaScript runtime for building scripts, services, tests, and tools
with a focused set of built-in modules. Runtime APIs are imported through
`fino:*` specifiers.

This guide is the shortest path from an installed `fino` command to a useful
program.

## Run a Script

Create `hello.mts` and import runtime APIs with `fino:*` specifiers:

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
fino ./hello.mts
```

## Start an HTTP Server

The HTTP server API is intentionally close to Fetch's `Request` and `Response`
model:

```ts
import { serve } from 'fino:net/http/server';

const port = Number(process.env.PORT ?? 3000);

const server = serve({ port }, async (request) => {
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
PORT=3000 fino ./server.mts
```

The [HTTP guide](./net/http/guide.md) covers routing, request bodies, streaming
responses, server-sent events, WebSockets, and graceful shutdown.

## Add Tests

Fino includes a TAP-producing test framework:

```ts
import { test } from 'fino:test';

test('math still works', (t) => {
  t.equal(1 + 1, 2);
});
```

Run a file:

```sh
fino test ./math.test.mts
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

- [CLI](./cli.md) explains every command and the common development workflows.
- [Runtime model](./runtime-model.md) explains the event loop, module system,
  realms, and the main concepts behind Fino applications.
- [Files](./file/guide.md), [HTTP](./net/http/guide.md),
  [formats](./format/guide.md), and [SQLite](./database/guide.md) cover common
  application building blocks.
- [Realms](./realm/guide.md) covers isolation, worker-style execution,
  import rules, and parent-child communication.
