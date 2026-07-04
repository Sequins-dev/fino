![fino logo](./logo.svg)

# fino

Fino is a JavaScript runtime for building fast, self-contained tools, services,
agents, and local-first applications. It gives TypeScript and ES module programs
a practical standard library: HTTP servers and clients, files, streams,
formats, databases, tasks, tests, benchmarks, OpenTelemetry, realms, and more
are available through explicit `fino:*` modules.

The goal is to make useful runtime capabilities feel close at hand without
assembling a large framework stack first. A Fino program can start as a script,
grow into a service, add tests and benchmarks, install npm packages, isolate
work in child realms, and expose project-specific commands through the same
runtime.

Fino is still experimental, but it is already useful for:

- command-line tools and project automation,
- HTTP services and protocol experiments,
- test and benchmark suites that should run inside the runtime they exercise,
- local data processing with files, formats, SQLite, and streams,
- agent, workflow, and tool runtimes that need isolation and observability,
- systems work that benefits from JavaScript ergonomics plus native runtime
  capabilities.

## A Small Server

Fino's HTTP APIs use the familiar Fetch model: handlers receive `Request`
objects and return `Response` objects.

```ts
import { serveHttp } from 'fino:net/http/server';

const server = serveHttp({ port: 3000 }, async (request) => {
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

Run it with:

```sh
fino run server.ts
```

Use watch mode while editing:

```sh
fino run --watch server.ts
```

## What Fino Provides

**A runtime standard library.** Public APIs live under `fino:*` specifiers, so
programs can import only the runtime capabilities they need:

```ts
import { DiskFileSystem } from 'fino:file';
import { parse as parseToml } from 'fino:format/toml';
import { Database } from 'fino:database/sqlite';
import { Realm } from 'fino:realm';
```

**Web-compatible foundations.** Fino includes Web-style globals such as
`fetch`, `Request`, `Response`, `Headers`, `URL`, timers, Web Streams, `Blob`,
`FormData`, `crypto`, `MessageChannel`, and `BroadcastChannel`.

**A productive CLI.** The `fino` command runs scripts, starts a REPL, runs
tests and benchmarks, installs packages, formats and lints source, builds docs,
and loads project-local tasks.

```sh
fino run app.ts --config config.toml
fino test tests
fino bench benchmarks
fino task build --target release
fino doc build --format html js
```

**Package support without a `node_modules` runtime dependency.** `fino install`
resolves npm packages into `.fino/` and writes a package map used by the module
loader for bare package imports.

**Isolation when you need it.** Realms provide isolated JavaScript environments
with explicit import rules. They are useful for workers, reloadable application
contexts, sandboxed tools, and controlled agent execution.

**Observability and performance tools.** Fino includes OpenTelemetry support,
benchmarking, and CPU profiling hooks so runtime behavior can be measured while
you build.

## Why Use It

Fino is designed for software that sits between "a quick script" and "a full
application platform." It lets you keep the directness of JavaScript while
having runtime-owned building blocks for common systems tasks:

- Write a file-processing script today, then add a task command and tests when
  it becomes project automation.
- Start an HTTP endpoint with `Request` and `Response`, then add routing,
  streaming, WebSockets, or OpenTelemetry as the service grows.
- Build local tools that parse config, query SQLite, spawn subprocesses, and
  expose a clean CLI without stitching together separate packages first.
- Run untrusted or reloadable code in realms with narrowed imports instead of
  giving every module access to the whole runtime.

The result is a platform that aims to stay explicit and composable: import the
capabilities you use, keep application code in standard ES modules, and let the
runtime provide the operational pieces around it.

## Documentation

Start with the authored guides in `js/`:

- [Getting Started](./js/getting-started.md)
- [Runtime Model](./js/runtime-model.md)
- [CLI](./js/cli.md)
- [Modules and Packages](./js/modules-and-packages.md)
- [HTTP](./js/net/http/guide.md)
- [Realms](./js/realm/guide.md)
- [Testing and Benchmarking](./js/testing-and-benchmarking.md)

Generated API documentation can be built from the repository sources with
`fino doc build`.

## Project Status

Fino is under active development. The runtime surface is broad, but not every
Node/npm ecosystem behavior is implemented or intended. Treat public `fino:*`
modules and the authored guides as the supported application surface, and
expect low-level internals to change as the runtime evolves.

For build instructions, repository layout, and development workflow, see
[CONTRIBUTING.md](./CONTRIBUTING.md).
