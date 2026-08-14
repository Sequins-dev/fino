---
weight: 32
---
# Complex Tools

Use tools when a model needs controlled access to application capabilities:
lookups, search, calculations, workflow actions, or external side effects. A
good tool is narrow, validated, explicit about side effects, and safe to retry
or deduplicate where possible.

## Concept Map

- `tool()` creates a model-callable `Tool`.
- `fino:validate` builders define typed arguments and provider-facing JSON
  Schema.
- `Tool.invoke()` validates model-supplied arguments before calling `execute`.
- Validation failures and normal executor errors become model-visible tool
  errors unless `throwOnError` is set.
- `ctx.signal`, `ctx.runId`, `ctx.step`, and `ctx.toolCallId` support
  cancellation, idempotency, and tracing.
- `ctx.suspend()` throws a suspension signal; `Session` turns that signal into
  durable suspended run state and a resume token.

## Ready-Made Workspace Tools

Before writing file or shell tools by hand, check `fino:ai/tools`. It ships the
set a coding agent needs — `list_files`, `read_file`, `search_files`, and, when
`writes` is enabled, `write_file`, `edit_file`, and `shell` — with the policy
decisions already made: output is capped so one call cannot flood the context
window, relative paths resolve against `cwd` (pass `confine` to refuse
anything outside it), and the mutating tools carry
`requiresApproval` unless `auto` is set, so a harness suspends for a human
decision before they run.

```ts
import { agent, openai } from 'fino:ai';
import { createWorkspaceTools } from 'fino:ai/tools';

const reviewer = agent({
  model: openai({ model: 'gpt-4o' }),
  instructions: 'Review the working tree and report problems. Do not change files.',
  tools: createWorkspaceTools({ cwd: '/repo', writes: false }),
});
```

Each tool is also exported on its own — `readFileTool({ cwd })`,
`shellTool({ cwd, auto: true })`, and so on — so an application can take the
two it wants and pair them with its own.

## Design Tool Boundaries

Keep each tool focused on one action. Prefer `lookup_ticket`, `quote_invoice`,
or `request_refund_approval` over a broad `crm` tool with many modes. Narrow
tools produce clearer provider-facing schemas and make it easier for the model
to repair invalid arguments.

Always use `fino:validate` builders for application tools:

```ts
import { tool } from 'fino:ai/tool';
import { v } from 'fino:validate';

const lookupTicket = tool({
  name: 'lookup_ticket',
  description: 'Read a support ticket by id without changing it.',
  parameters: v.object({
    id: v.string().describe('Ticket id, for example T-1001'),
    includeEvents: v.boolean().optional().describe('Whether to include recent events'),
  }),
  execute: async ({ id, includeEvents = false }: { id: string; includeEvents?: boolean }) => {
    return JSON.stringify({
      id,
      status: 'open',
      events: includeEvents ? ['created', 'customer_replied'] : [],
    });
  },
});
```

Descriptions are part of the contract. Describe arguments in terms the model
can use, and say whether the tool reads state or changes state.

## Errors and Repair

When arguments fail validation, the agent returns a tool result marked as an
error so the model can try again. Normal executor exceptions behave the same by
default. Use structured, concise error messages because they become prompt
material on the repair step.

```ts
const scheduleRefund = tool({
  name: 'schedule_refund',
  description: 'Schedule an approved refund. This changes billing state.',
  parameters: v.object({
    accountId: v.string().describe('Account id'),
    amountUsd: v.number().min(0).describe('Refund amount in USD'),
    approvalId: v.string().describe('Human approval id'),
  }),
  execute: async ({ accountId, amountUsd, approvalId }: {
    accountId: string;
    amountUsd: number;
    approvalId: string;
  }, ctx) => {
    if (!approvalId.startsWith('APR-')) {
      return { content: 'approvalId must start with APR-', isError: true };
    }

    const idempotencyKey = `${ctx.runId}:${ctx.toolCallId}`;
    await refunds.schedule({ accountId, amountUsd, approvalId, idempotencyKey });
    return `refund scheduled for ${accountId}`;
  },
});
```

Set `throwOnError: true` only when application code should fail the whole run
instead of giving the model a chance to repair. Cancellation and suspension are
control flow and are rethrown automatically.

## Suspension

Use suspension only when the agent run is being driven through `Session` or
another runtime that explicitly handles `SuspendSignal`. Inside a tool,
`ctx.suspend()` does not perform persistence by itself. It throws a control-flow
signal. `Agent.step()` reports that signal as `StepResult.suspend`, and
`Session` persists the run as `status: 'suspended'` with a resume token.

That distinction matters for local examples: a bare `Agent.generate()` can stop
when a tool suspends, but it does not give you a durable approval flow. Wrap the
agent in `Session` when approval, OAuth, missing human input, or any other
pause/resume workflow is part of the behavior.

```ts
import { agent } from 'fino:ai/agent';
import { openai } from 'fino:ai/model';
import { InMemorySessionStore, session } from 'fino:ai/session';
import { tool } from 'fino:ai/tool';
import { v } from 'fino:validate';

const requestRefund = tool({
  name: 'request_refund',
  description: 'Request a refund; pauses when human approval is required.',
  parameters: v.object({
    accountId: v.string(),
    amountUsd: v.number().min(0),
    reason: v.string(),
  }),
  execute: async ({ accountId, amountUsd, reason }: {
    accountId: string;
    amountUsd: number;
    reason: string;
  }, ctx) => {
    if (amountUsd > 100) {
      ctx.suspend({
        reason: 'refund approval required',
        payload: { accountId, amountUsd, reason },
      });
    }
    return `refund approved automatically for ${accountId}`;
  },
});

const bot = agent({
  model: openai({ model: 'gpt-4o' }),
  tools: [requestRefund],
});

const sess = session({
  store: new InMemorySessionStore(),
  agent: bot,
  threadId: 'customer-42',
});

const first = await sess.start('Refund $250 for account acct_123.');
if (first.status === 'suspended' && first.state.suspendedOn?.token) {
  const approved = { approvalId: 'APR-1001' };
  const resumed = await sess.approveTool(first.state.suspendedOn.token, {
    approval: approved,
  });
  console.log(resumed.status, resumed.text);
}
```

Approved tool calls execute exactly once and append a tool result before the
next model step. For non-tool external input suspensions, `resume()` still
injects a user message. Keep suspended payloads small and durable: ids, amounts, and reasons are
better than live objects or process-local handles.

## Idempotency and Side Effects

Models can retry calls, sessions can resume, and transports can repeat requests.
Tools that change state should be idempotent or explicitly deduplicated. Good
idempotency keys often include `ctx.runId`, `ctx.toolCallId`, and the business
object id.

```ts
const createTask = tool({
  name: 'create_task',
  description: 'Create one support follow-up task. This changes task state.',
  parameters: v.object({
    ticketId: v.string(),
    title: v.string(),
    dueHours: v.number().min(1).max(168),
  }),
  execute: async ({ ticketId, title, dueHours }: {
    ticketId: string;
    title: string;
    dueHours: number;
  }, ctx) => {
    const task = await tasks.createOnce({
      key: `${ctx.runId}:${ctx.toolCallId}`,
      ticketId,
      title,
      dueHours,
    });
    return JSON.stringify({ taskId: task.id, status: task.status });
  },
});
```

## Recommended Checklist

- Give each tool one clear purpose.
- Use `v.object()` with described properties for every parameter schema.
- Make read-only tools explicitly read-only in the description.
- Make write tools explicit about side effects and idempotency.
- Return compact strings or JSON that the model can quote or reason over.
- Use `ctx.signal` in long-running I/O so cancellation can stop work.
- Use `ctx.suspend()` for external approval only when a `Session` or workflow is
  responsible for persisting and resuming the run.
- Prefer model-visible tool errors for repairable failures and thrown errors
  for infrastructure failures that should stop the run.
