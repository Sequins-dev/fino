---
weight: 100
---
# AI

`fino:ai` is the runtime's AI subsystem: provider-neutral model calls, validated
tools, agents, durable sessions, memory, evals, skills, and MCP adapters, all
designed to work with the rest of the runtime — HTTP routes, realms, sandboxed
processes, and OpenTelemetry. The root module re-exports the stable
application-facing APIs, so most applications only need
`import { ... } from 'fino:ai'`.

The subsystem is layered, and the layers map to how an application usually
grows.

**Model calls** are the base layer. A `Model` is a stateless,
provider-neutral contract: the caller owns the messages, sends a request, and
gets text, structured output, or a stream of normalized events back. Use a
direct `Model.generate()` or `Model.stream()` call for single-turn
summarization, classification, or extraction where no tools or durable state
are needed. Provider adapters (`openai`, `anthropic`, `local`), streaming
events, and response assembly are covered in
[Model Requests](./ai/model-requests.md).

**Tools** make behavior model-callable. A tool is an ordinary TypeScript
function with a name, a description, and a `fino:validate` schema for its
parameters; the runtime validates arguments before your code runs. Tools that
wrap subprocesses, call other agents, require human approval, or execute
untrusted code are covered in [Complex Tools](./ai/complex-tools.md) — and when
a tool loads code it should not trust, run that code in a
[realm](./realm.md) with narrowed imports rather than in the application
context.

**Agents** run the model loop. An `Agent` sends curated history to a model,
executes tool calls, applies guardrails, retries or falls back across models,
and stops when the model finishes or a stop condition fires. Agents also
produce validated structured output and stream text and events while the loop
runs. Reach for an agent as soon as the model may call tools or the output
must match a schema.

**Sessions** make multi-turn state durable. A `Session` persists agent runs,
threads, and suspend/resume state through a `SessionStore`, so a conversation
can survive process restarts or pause for human approval. The agent remains
the behavior boundary; the session is the durability boundary.

Around that core:

- [Interactive CLI Harness](./ai/interactive-cli-harness.md) shows how to wire
  agents, sessions, and tool approval into an interactive terminal app.
- [Agent MCP Server](./ai/agent-mcp-server.md) exposes tools and resources to
  external clients through the Model Context Protocol. MCP is a protocol
  boundary — use it when another process or product should discover your
  tools, not as an internal abstraction.
- [Evals and OpenTelemetry](./ai/evals-opentelemetry.md) turns AI behavior
  into test-runner cases with scorers and reporters. Keep evals close to the
  behavior they protect, like ordinary tests, and pin or stub models in CI.
- [Skills](./ai/skills.md) keeps optional expert instructions, resources, and
  tools discoverable without loading every instruction block into every
  prompt.

For durable multi-step orchestration around agent calls — checkpointed steps,
timers, external signals — combine agents with `fino:workflow` (see the
generated API reference).

## End-to-End Example

This support assistant has one validated tool, durable session state,
structured output, and an HTTP route that runs one session turn.

```ts
import { agent, InMemorySessionStore, openai, session, tool } from 'fino:ai';
import { App } from 'fino:net/http/app';
import { v } from 'fino:validate';

const ticketLookup = tool({
  name: 'lookup_ticket',
  description: 'Read a support ticket by id.',
  parameters: v.object({
    id: v.string().describe('Support ticket id, such as T-1001'),
  }),
  execute: async ({ id }: { id: string }) => {
    return JSON.stringify({ id, status: 'open', plan: 'business' });
  },
});

const bot = agent({
  model: openai({ model: 'gpt-4o' }),
  instructions: 'Answer as a concise support engineer. Ask before changing accounts.',
  tools: [ticketLookup],
  output: v.object({
    answer: v.string().describe('Customer-facing reply'),
    needsHuman: v.boolean().describe('Whether a human should review the answer'),
  }),
});

const store = new InMemorySessionStore();

const app = new App();
app.post('/chat', async (ctx) => {
  const body = await ctx.request.json() as { threadId?: string; text: string };
  const result = await session({
    store,
    agent: bot,
    threadId: body.threadId,
  }).start(body.text);

  return Response.json({
    text: result.text ?? '',
    runId: result.runId,
    status: result.status,
    resumeToken: result.state.suspendedOn?.token,
  });
});
app.listen({ port: 3000 });
```

The HTTP request body can stay application-specific:

```ts
await fetch('http://127.0.0.1:3000/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ threadId: 'customer-42', text: 'Check ticket T-1001' }),
});
```

To stream a reply token by token instead of waiting for the full turn, serve
the agent from an `app.sse()` route and write `streamText()` deltas as events —
the project README shows exactly that, and the
[server-sent events guide](./net/http/server-sent-events.md) covers the route
type.

## Common Decisions

- Prefer a direct `Model.generate()` or `Model.stream()` call for single-turn
  summarization, classification, or extraction where no tools or durable state
  are needed.
- Prefer `Agent` for tool loops and structured output repair.
- Prefer `Session` for durable multi-turn state and suspend/resume.
- Prefer `MCPServer` only when another process or product should discover and
  call your tools/resources through MCP.
- Keep tools small, validated, idempotent where possible, and explicit about
  side effects.
- Keep evals close to the behavior they protect, just like ordinary tests.
