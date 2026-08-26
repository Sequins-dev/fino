import { describe, it } from 'fino:test/test';
import { acpServer } from 'fino:ai/acp';
import { agent } from 'fino:ai/agent';
import { tool } from 'fino:ai/tool';
import type { Tool } from 'fino:ai/tool';
import { INVALID_PARAMS, JsonRpcError, JsonRpcPeer, JsonRpcService } from 'fino:jsonrpc';
import type { Transport } from 'fino:jsonrpc';
import { cwd, execPath } from 'fino:process';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { GenerateRequest, Model, ModelStream, StreamEvent } from 'fino:ai/model';
import { v } from 'fino:validate';

class MessageQueue {
  #messages: string[] = [];
  #waiters: Array<(message: string | null) => void> = [];
  #closed = false;
  push(message: string): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(message);
    else this.#messages.push(message);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters) waiter(null);
    this.#waiters = [];
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.#messages.length > 0) {
        yield this.#messages.shift()!;
        continue;
      }
      if (this.#closed) return;
      const message = await new Promise<string | null>((resolve) => this.#waiters.push(resolve));
      if (message === null) return;
      yield message;
    }
  }
}

function transportPair(): [Transport, Transport] {
  const clientInbound = new MessageQueue();
  const serverInbound = new MessageQueue();
  const close = () => {
    clientInbound.close();
    serverInbound.close();
  };
  return [
    {
      send: (message) => serverInbound.push(message),
      receive: () => clientInbound,
      close,
    },
    {
      send: (message) => clientInbound.push(message),
      receive: () => serverInbound,
      close,
    },
  ];
}

function endTurn(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', index: 0, text },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    { type: 'stop', reason: 'end_turn' },
  ];
}

function scriptedModel(turns: StreamEvent[][], requests: GenerateRequest[] = []): Model {
  let index = 0;
  return {
    name: 'acp-script',
    dimensions: 0,
    stream(request: GenerateRequest): ModelStream {
      requests.push(request);
      const events = turns[index++] ?? endTurn('done');
      async function* generate() {
        yield* events;
      }
      return new ModelStreamImpl(generate());
    },
    async generate() {
      throw new Error('use stream');
    },
    async embed() {
      return [];
    },
  };
}

async function withServer(
  model: Model,
  run: (client: JsonRpcPeer, updates: Record<string, unknown>[]) => Promise<void>,
  tools: Tool[] = [],
): Promise<void> {
  const [clientTransport, serverTransport] = transportPair();
  const updates: Record<string, unknown>[] = [];
  const clientService = new JsonRpcService();
  clientService.method('session/update').handle((params) => {
    updates.push(params as Record<string, unknown>);
  });
  clientService.method('session/request_permission').handle((params) => {
    updates.push({ permissionRequest: params });
    return {
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    };
  });
  const server = acpServer({ agent: agent({ model, tools }) });
  const serving = server.serve(serverTransport);
  const client = new JsonRpcPeer(clientTransport, clientService);
  try {
    await run(client, updates);
  } finally {
    await client.close();
    await serving;
  }
}

describe('fino:ai/acp', () => {
  it('rejects non-absolute session paths with ACP invalid params', async (t) => {
    await withServer(scriptedModel([endTurn('unused')]), async (client) => {
      await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
      let failure: unknown;
      try {
        await client.call('session/new', { cwd: 'relative/path', mcpServers: [] });
      } catch (error) {
        failure = error;
      }
      t.ok(failure instanceof JsonRpcError);
      t.equal((failure as JsonRpcError).code, INVALID_PARAMS);
    });
  });

  it('initializes, creates an isolated session, and streams baseline prompt content', async (t) => {
    const requests: GenerateRequest[] = [];
    await withServer(
      scriptedModel([endTurn('hello from ACP')], requests),
      async (client, updates) => {
        const initialized = (await client.call('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        })) as Record<string, unknown>;
        t.equal(initialized.protocolVersion, 1);
        const capabilities = initialized.agentCapabilities as Record<string, unknown>;
        t.equal(capabilities.loadSession, false);
        const created = (await client.call('session/new', {
          cwd: cwd(),
          mcpServers: [],
        })) as { sessionId: string };
        const result = (await client.call('session/prompt', {
          sessionId: created.sessionId,
          prompt: [
            { type: 'text', text: 'review this' },
            { type: 'resource_link', name: 'spec', uri: 'file:///workspace/spec.md' },
          ],
        })) as { stopReason: string };
        t.equal(result.stopReason, 'end_turn');
        t.ok(JSON.stringify(requests[0]!.messages).includes('review this'));
        t.ok(JSON.stringify(requests[0]!.messages).includes('file:///workspace/spec.md'));
        t.ok(JSON.stringify(updates).includes('agent_message_chunk'));
        t.ok(JSON.stringify(updates).includes('hello from ACP'));
      },
    );
  });

  it('connects session-provided MCP stdio tools and reports tool lifecycle updates', async (t) => {
    const toolTurn: StreamEvent[] = [
      { type: 'tool_call_start', index: 0, id: 'call-1', name: 'echo' },
      { type: 'tool_call_delta', index: 0, json: '{"value":"ok"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
      { type: 'stop', reason: 'tool_use' },
    ];
    await withServer(
      scriptedModel([toolTurn, endTurn('tool complete')]),
      async (client, updates) => {
        await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
        const created = (await client.call('session/new', {
          cwd: cwd(),
          mcpServers: [
            {
              name: 'fixture',
              command: execPath,
              args: ['tests/fixtures/acp-mcp-server.ts'],
              env: [],
            },
          ],
        })) as { sessionId: string };
        const result = (await client.call('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'use echo' }],
        })) as { stopReason: string };
        t.equal(result.stopReason, 'end_turn');
        const rendered = JSON.stringify(updates);
        t.ok(rendered.includes('tool_call'));
        t.ok(rendered.includes('in_progress'));
        t.ok(rendered.includes('completed'));
        t.ok(rendered.includes('echo:ok'));
      },
    );
  });

  it('returns the required cancelled stop reason after session/cancel', async (t) => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const model: Model = {
      name: 'cancel-spy',
      dimensions: 0,
      stream(request: GenerateRequest): ModelStream {
        async function* generate() {
          markStarted();
          await new Promise<void>((_resolve, reject) => {
            request.signal!.addEventListener('abort', () => reject(request.signal!.reason), {
              once: true,
            });
          });
          yield* endTurn('unreachable');
        }
        return new ModelStreamImpl(generate());
      },
      async generate() {
        throw new Error('use stream');
      },
      async embed() {
        return [];
      },
    };
    await withServer(model, async (client) => {
      await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const created = (await client.call('session/new', {
        cwd: cwd(),
        mcpServers: [],
      })) as { sessionId: string };
      const prompt = client.call('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'wait' }],
      }) as Promise<{ stopReason: string }>;
      await started;
      await client.notify('session/cancel', { sessionId: created.sessionId });
      t.equal((await prompt).stopReason, 'cancelled');
    });
  });

  it('maps approval-required tools to session/request_permission', async (t) => {
    let executed = false;
    const secured = tool({
      name: 'secured',
      description: 'A side-effecting operation.',
      parameters: v.object({ value: v.string() }),
      requiresApproval: true,
      sideEffects: true,
      execute: ({ value }: { value: string }) => {
        executed = true;
        return `approved:${value}`;
      },
    });
    const toolTurn: StreamEvent[] = [
      { type: 'tool_call_start', index: 0, id: 'secure-1', name: 'secured' },
      { type: 'tool_call_delta', index: 0, json: '{"value":"yes"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
      { type: 'stop', reason: 'tool_use' },
    ];
    await withServer(
      scriptedModel([toolTurn, endTurn('approved')]),
      async (client, updates) => {
        await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
        const created = (await client.call('session/new', {
          cwd: cwd(),
          mcpServers: [],
        })) as { sessionId: string };
        await client.call('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'run secured' }],
        });
        t.ok(executed);
        const rendered = JSON.stringify(updates);
        t.ok(rendered.includes('permissionRequest'));
        t.ok(rendered.includes('allow_once'));
        t.ok(rendered.includes('pending'));
        t.ok(rendered.includes('approved:yes'));
      },
      [secured],
    );
  });
});
