---
weight: 33
---
# Interactive CLI Harness

Use a CLI harness when developing prompts, tools, sessions, and cancellation
locally before wiring an agent into a server. A good harness streams output,
persists thread state, exposes a few debug commands, and exits cleanly on
interrupt.

## Concept Map

- `agent()` owns the model and tool loop.
- `streamText()` renders only text deltas from an agent stream.
- `Session` and `sqliteStore()` persist durable conversation state.
- Tool `ctx.suspend()` returns a resumable session state for approval flows.
- `AbortController` gives each turn graceful cancellation.

## Recommended Shape

Keep the harness thin. It should translate terminal input into agent/session
calls, display text, and run debug commands such as `/new`, `/state`, `/cancel`,
and `/exit`. Keep product logic in tools and agent configuration so the same
agent can later run behind HTTP, WebSocket, or MCP.

The example below uses `Agent.stream()` for normal turns and stores a separate
durable session for workflows that need resume. For a production CLI that must
resume every turn after restart, drive all turns through `Session.start()`.

```ts
import { agent, streamText } from 'fino:ai/agent';
import { openai } from 'fino:ai/model';
import { Session, session } from 'fino:ai/session';
import { sqliteStore } from 'fino:store';
import { tool } from 'fino:ai/tool';
import { readLine, writeStdout } from 'fino:tty';
import { v } from 'fino:validate';

const approveDeploy = tool({
  name: 'approve_deploy',
  description: 'Request approval before marking a deployment as approved.',
  parameters: v.object({
    service: v.string().describe('Service name'),
    version: v.string().describe('Version to deploy'),
  }),
  execute: async ({ service, version }: { service: string; version: string }, ctx) => {
    ctx.suspend({
      reason: 'deployment approval required',
      payload: { service, version },
    });
  },
});

const bot = agent({
  model: openai({ model: 'gpt-4o' }),
  instructions: 'You are a local release-debug assistant. Be concise.',
  tools: [approveDeploy],
});

const store = await sqliteStore({ path: './cli-agent.db' });
let threadId = 'local';
let pending: { runId: string; token: string } | undefined;
let currentAbort: AbortController | undefined;

async function ask(line: string): Promise<void> {
  currentAbort = new AbortController();
  try {
    if (pending) {
      const result = await Session.resumeSuspended({
        store,
        agent: bot,
        threadId,
        runId: pending.runId,
        resumeToken: pending.token,
        value: line,
        signal: currentAbort.signal,
      });
      pending = undefined;
      await writeStdout(`${result.text ?? ''}\n`);
      return;
    }

    const stream = bot.stream({
      messages: [{ role: 'user', content: line }],
      signal: currentAbort.signal,
    });

    for await (const text of streamText(stream)) {
      await writeStdout(text);
    }
    await writeStdout('\n');
    await stream.result;
  } finally {
    currentAbort = undefined;
  }
}

async function askDurable(line: string): Promise<void> {
  currentAbort = new AbortController();
  try {
    const result = await session({ store, agent: bot, threadId }).start(line, {
      signal: currentAbort.signal,
    });
    if (result.status === 'suspended' && result.state.suspendedOn?.token) {
      pending = { runId: result.runId, token: result.state.suspendedOn.token };
      await writeStdout(`suspended: ${result.state.suspendedOn.reason}\n`);
      return;
    }
    await writeStdout(`${result.text ?? ''}\n`);
  } finally {
    currentAbort = undefined;
  }
}

async function handleCommand(line: string): Promise<boolean> {
  if (line === '/exit') return false;
  if (line === '/new') {
    threadId = `local-${Date.now()}`;
    pending = undefined;
    await writeStdout(`thread ${threadId}\n`);
    return true;
  }
  if (line === '/cancel') {
    currentAbort?.abort();
    pending = undefined;
    await writeStdout('cancelled\n');
    return true;
  }
  if (line === '/state') {
    await writeStdout(JSON.stringify({ threadId, pending }, null, 2) + '\n');
    return true;
  }
  if (line.startsWith('/durable ')) {
    await askDurable(line.slice('/durable '.length));
    return true;
  }
  return true;
}

while (true) {
  const raw = await readLine('> ');
  if (raw === null) break;
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith('/')) {
    if (!await handleCommand(line)) break;
    continue;
  }
  await ask(line);
}
```

## Command Handling

Use slash commands for harness behavior, not agent behavior. Commands such as
`/state`, `/cancel`, and `/new` should not be sent to the model unless you are
explicitly testing how the model reacts to them.

Recommended commands:

- `/new` starts a fresh thread id.
- `/state` prints current thread, run, and pending resume token metadata.
- `/cancel` aborts the current turn through `AbortController`.
- `/durable <message>` runs a turn through `Session` to exercise persistence
  and suspension.
- `/exit` closes the process after outstanding work settles.

## Durable State

Use `sqliteStore()` when local debug state should survive restarts. Use
`memoryStore()` for tests and experiments where process-local state is acceptable.
Durable state is especially important when tools can suspend or when a CLI is
debugging the same session behavior that an HTTP service will use.

## Cancellation

Create a new `AbortController` per turn and pass `signal` into the agent or
session call. Long-running tools should check `ctx.signal` or pass it into their
own I/O. Treat cancellation as a normal local control path, not as a model-visible
tool error.
