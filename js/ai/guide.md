---
weight: 30
---
# AI Guide

Use `fino:ai` first when an application needs model calls, tool use, durable
multi-turn work, external tool exposure, evals, or reusable agent skills. The
root module re-exports the stable application-facing APIs. Reach for subsystem
imports when you want narrower type imports or are documenting an advanced
boundary.

## Concept Map

- `fino:ai` is the happy-path application surface for agents, tools, models,
  sessions, memory, evals, skills, and MCP adapters.
- `fino:ai/model` is the stateless provider-neutral model contract.
- `fino:ai/agent` runs a model loop with history policy, tools, structured
  output, guardrails, retries, fallbacks, and streaming.
- `fino:ai/tool` defines validated model-callable actions.
- `fino:ai/context` owns message history strategies, token estimates, cost
  helpers, and stop conditions.
- `fino:ai/session` persists agent runs, threads, history revisions, and
  suspend/resume state.
- `fino:ai/mcp` exposes or consumes tools and resources through the Model
  Context Protocol.
- `fino:ai/eval` turns AI behavior into test-runner cases with scorers and
  reporters.
- `fino:ai/skill` keeps optional instructions, resources, and tools
  discoverable but lazily loaded.

## Choose the Right Layer

Use `fino:ai/model` for one request where the caller owns all messages and
parses the answer. Keep these calls stateless unless history, tools, durable
sessions, or model-repair loops are needed.

Use `fino:ai/agent` when the model may call tools, produce validated structured
output, stream through a loop, use guardrails, retry or fall back across models,
or apply a custom history strategy.

Use `fino:ai/session` when a run must survive process restarts, fork a thread,
resume after human approval, or keep durable state across request boundaries.
Sessions are the durable boundary; the agent remains the behavior boundary.

Use `fino:workflow` with `fino:ai/agent` when an application needs durable
multi-step orchestration around one or more agent calls. Keep ordinary
TypeScript branching, loops, `Promise.all`, and external waits in the workflow,
and put agent calls inside checkpointed workflow steps when duplicate model or
tool execution would be unsafe.

Use `fino:ai/mcp` when the capabilities need to be available to external MCP
clients. MCP is a protocol boundary, not an internal-only abstraction for code
that already lives in the same process.

Use `fino:ai/eval` as tests for prompt, tool, retrieval, and provider behavior.
Pin or stub models in CI where possible, and add OpenTelemetry reporting when
you need observability across eval runs.

Use `fino:ai/skill` for optional expert guidance that should be discoverable
without loading every instruction block into every prompt. Keep skills focused,
named clearly, and loaded only when relevant.

## Recommended Architecture

A typical advanced application separates the pieces:

1. Define narrow tools with `fino:ai/tool` and `fino:validate`.
2. Configure an `Agent` with a provider model, instructions, tools, and any
   output schema or guardrails.
3. Add a `SessionStore` when threads need durability or suspend/resume.
4. Wrap agent calls in `fino:workflow` when the surrounding process has multiple
   durable steps, timers, or external signals.
5. Expose the workflow through your application routes, or through
   `fino:ai/mcp` when external MCP clients need protocol-level discovery.
6. Cover important behavior with `fino:ai/eval`, using stubs or pinned models
   for CI and OpenTelemetry for traceable reports.
7. Move optional domain-specific prompting into `fino:ai/skill` once the base
   agent would otherwise carry too much rarely used context.

## End-to-End Example

This support assistant has one validated tool, durable session state, structured
output, and an HTTP route that runs one session turn.

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
