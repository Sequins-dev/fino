![fino logo](./logo.svg)

# fino

Fino is a JavaScript runtime for building modern, agentic applications: tools
that call models, expose actions, run untrusted or reloadable code, serve HTTP
APIs, and keep their capabilities explicit.

The runtime is designed around a simple idea: applications should be able to
combine ordinary TypeScript with strong execution boundaries. Fino gives you a
productive app platform, a permissioned module system, isolated realms,
sandbox-aware processes, durable AI workflows, and built-in observability in one
runtime instead of scattering those concerns across a pile of services and
framework glue.

Use Fino when you want to build:

- agentic web apps with model calls, tools, sessions, evals, and MCP support,
- internal automation that needs clear capability boundaries,
- services that combine HTTP routes, background work, local data, and model
  tools,
- plugin or skill systems where loaded code should only see approved modules,
- developer tools that start as scripts but grow into tested, documented
  project commands,
- systems that need JavaScript ergonomics without giving every task ambient
  access to the host.

Fino is experimental and still moving quickly, but its direction is clear: a
runtime for applications where AI, tools, permissions, and isolation are part of
the core architecture.

## The Shape of a Fino App

Fino apps are ordinary ES modules, but the runtime gives them first-class
building blocks for routing, validation, tools, models, sessions, and isolated
execution.

```ts
import { agent, openai, session, tool, InMemorySessionStore } from 'fino:ai';
import { App, body } from 'fino:net/http/app';
import { v } from 'fino:validate';

const lookupTicket = tool({
  name: 'lookup_ticket',
  description: 'Read a support ticket by id.',
  parameters: v.object({ id: v.string() }),
  execute: async ({ id }: { id: string }) => {
    return JSON.stringify({ id, status: 'open', plan: 'business' });
  },
});

const supportAgent = agent({
  model: openai({ model: 'gpt-4o' }),
  instructions: 'Answer as a concise support engineer.',
  tools: [lookupTicket],
  output: v.object({
    answer: v.string(),
    needsHuman: v.boolean(),
  }),
});

const sessions = new InMemorySessionStore();
const app = new App({ name: 'Support API' });

app.route('/chat')
  .post()
  .value('body', body.json(v.object({
    threadId: v.optional(v.string()),
    message: v.string(),
  })))
  .handle(async (ctx) => {
    const input = ctx.body as { threadId?: string; message: string };
    const result = await session({
      store: sessions,
      agent: supportAgent,
      threadId: input.threadId,
    }).start(input.message);

    return Response.json({
      text: result.text,
      runId: result.runId,
      status: result.status,
    });
  });

app.listen({ port: 3000 });
```

Run it with:

```sh
fino run --watch app.ts
```

This is the intended path: use the app router for request handling, use
validated tools for model-callable behavior, keep session state explicit, and
let the runtime provide the execution and observability layer around it.

## What Makes Fino Different

**Capabilities are explicit.** Runtime APIs are imported through public
`fino:*` modules instead of appearing as one ambient global bag. Application
code imports what it uses, and child realms can be given narrower import rules
than their parent. That makes capability boundaries visible in code review and
enforceable at runtime.

**Realms are built in.** A realm is an isolated JavaScript execution context
with its own global object, module graph, microtask queue, and event loop state.
Realms can run embedded, in a thread, in a process, or remotely, while keeping
the same messaging, facade, and import-rule model. Use them for plugin hosts,
reloadable workers, skill execution, and other code that should not freely
reach into the parent application.

**Imports are permissions.** Realm import maps let a parent decide exactly what
a child may import. Start from a deny-all baseline for untrusted code, open only
the modules it needs, or inherit most capabilities and block dangerous ones for
trusted workers. Children cannot grant themselves modules the parent has
already denied.

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

**Sandboxing is part of process execution.** Fino process APIs can request
sandbox policies and report what the current platform can enforce. Strict mode
fails closed when a requested security boundary is unavailable; best-effort mode
reports unsupported policy categories instead of pretending they were enforced.
That is important for agentic systems where tools may need filesystem, network,
process, or resource limits that can be audited.

**AI is a runtime subsystem, not an afterthought.** `fino:ai` provides
provider-neutral model calls, agents, validated tools, durable sessions, MCP
adapters, evals, skills, and memory. The pieces are designed to work with the
rest of the runtime: app routes, workflows, OpenTelemetry, realms, and
sandboxed process execution.

**HTTP apps use the router by default.** `fino:net/http/app` gives applications
an app/router model with middleware, context values, request body producers,
validation, sessions, cookies, static files, WebSocket routes, WebTransport
routes, JSON-RPC mounting, and OpenAPI generation while preserving direct
access to `Request` and `Response`.

**Observability is expected.** OpenTelemetry, benchmark commands, doc tests,
and profiling hooks are available from the runtime. The goal is to make agent
behavior, tool execution, request handling, and runtime performance measurable
while the application is being built.

## Core Building Blocks

- `fino:ai` for models, agents, tools, sessions, evals, skills, memory, and
  MCP.
- `fino:realm` for isolated execution, import capabilities, facades, messaging,
  watch mode, and realm pools.
- `fino:net/http/app` for application routing, middleware, validation, sessions,
  OpenAPI, WebSockets, and WebTransport.
- `fino:workflow` for durable multi-step orchestration around application and
  agent work.
- `fino:process` for subprocesses, environment, stdio, signals, and sandbox
  requests.
- `fino:context` and topics for async-local state and application event flow.
- `fino:file`, `fino:format/*`, and `fino:database/*` for local data work.
- `fino:opentelemetry` for tracing, metrics, logs, propagation, and exporters.

The CLI is built on the same task model used by application code:

```sh
fino run app.ts
fino test tests
fino bench benchmarks
fino task build
fino doc build --format html js
```

## Why It Matters for Agentic Apps

Agentic applications need more than a model client. They need controlled tool
execution, isolation for loaded skills, durable state, observable behavior,
HTTP surfaces for humans and machines, and a way to test prompts and tools as
the system changes.

Fino is built around those requirements:

- model-callable tools are ordinary validated TypeScript functions,
- app routes can call agents and workflows directly,
- sessions keep multi-turn state explicit,
- evals turn AI behavior into testable cases,
- MCP adapters expose tools and resources to other clients,
- realms and import rules narrow what dynamically loaded code can do,
- sandboxed processes provide a stronger boundary for tool execution when the
  platform supports it.

That combination lets a project grow from a script into a real agentic system
without changing runtimes or rebuilding the architecture around each new
capability.

## Documentation

Start with the authored guides in `js/`:

- [Getting Started](./js/getting-started.md)
- [AI Guide](./js/ai.md)
- [Runtime Model](./js/runtime-model.md)
- [Realms](./js/realm.md)
- [Import Capabilities](./js/realm/capabilities.md)
- [HTTP App Routing](./js/net/http/routing.md)
- [CLI](./js/cli.md)
- [Modules and Packages](./js/modules-and-packages.md)

Generated API documentation can be built from the repository sources with
`fino doc build`.

## Project Status

Fino is under active development. Some APIs are broad, some are new, and not
every Node/npm ecosystem behavior is implemented or intended. Treat documented
public `fino:*` modules and authored guides as the supported application
surface, and expect low-level internals to change as the runtime evolves.

For build instructions, repository layout, and development workflow, see
[CONTRIBUTING.md](./CONTRIBUTING.md).
