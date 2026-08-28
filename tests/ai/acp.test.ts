import { describe, it } from 'fino:test/test';
import { ACP_AUTH_REQUIRED, ACP_RESOURCE_NOT_FOUND, acpServer } from 'fino:ai/acp';
import type { AcpServerOptions } from 'fino:ai/acp';
import { commitConversationThread, loadConversationThread } from 'fino:ai/session';
import { memoryStore } from 'fino:store';
import { MessageHistory } from 'fino:ai/context';
import { agent } from 'fino:ai/agent';
import type { Agent } from 'fino:ai/agent';
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

function toolTurn(id: string, name: string, args: unknown): StreamEvent[] {
  return [
    { type: 'tool_call_start', index: 0, id, name },
    { type: 'tool_call_delta', index: 0, json: JSON.stringify(args) },
    { type: 'tool_call_end', index: 0 },
    { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
    { type: 'stop', reason: 'tool_use' },
  ];
}

interface WithServerOptions {
  tools?: Tool[];
  agent?: Agent | AcpServerOptions['agent'];
  server?: Omit<AcpServerOptions, 'agent'>;
  configureClient?(service: JsonRpcService, updates: Record<string, unknown>[]): void;
}

async function withServer(
  model: Model,
  run: (client: JsonRpcPeer, updates: Record<string, unknown>[]) => Promise<void>,
  opts: WithServerOptions = {},
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
  opts.configureClient?.(clientService, updates);
  const server = acpServer({
    ...opts.server,
    agent: opts.agent ?? agent({ model, tools: opts.tools }),
  });
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
  it('rejects invalid paths and ambiguous embedded resources', async (t) => {
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
      const created = (await client.call('session/new', {
        cwd: cwd(),
        mcpServers: [],
      })) as { sessionId: string };
      failure = undefined;
      try {
        await client.call('session/prompt', {
          sessionId: created.sessionId,
          prompt: [
            {
              type: 'resource',
              resource: { uri: 'file:///ambiguous', text: 'text', blob: 'YmxvYg==' },
            },
          ],
        });
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
        t.equal(capabilities.loadSession, true);
        t.deepEqual(capabilities.mcpCapabilities, { http: true, sse: true });
        t.deepEqual(capabilities.sessionCapabilities, {
          list: {},
          delete: {},
          additionalDirectories: {},
          resume: {},
          close: {},
        });
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
        t.ok(JSON.stringify(updates).includes('usage_update'));
      },
      { server: { contextWindowSize: 128_000 } },
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

  it('session/close waits for active work to cancel and keeps the session resumable', async (t) => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const model: Model = {
      name: 'close-spy',
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
      await client.call('session/close', { sessionId: created.sessionId });
      t.equal((await prompt).stopReason, 'cancelled');
      await client.call('session/resume', {
        sessionId: created.sessionId,
        cwd: cwd(),
        mcpServers: [],
      });
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
      { tools: [secured] },
    );
  });

  it('accepts every stable prompt content variant and maps it to model content', async (t) => {
    const requests: GenerateRequest[] = [];
    await withServer(scriptedModel([endTurn('rich')], requests), async (client) => {
      await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const created = (await client.call('session/new', {
        cwd: cwd(),
        mcpServers: [],
      })) as { sessionId: string };
      await client.call('session/prompt', {
        sessionId: created.sessionId,
        prompt: [
          { type: 'text', text: 'text' },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
          {
            type: 'resource',
            resource: { uri: 'file:///notes.txt', text: 'notes', mimeType: 'text/plain' },
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///data.bin',
              blob: 'YmluYXJ5',
              mimeType: 'application/octet-stream',
            },
          },
          {
            type: 'resource_link',
            name: 'spec',
            title: 'Specification',
            description: 'ACP v1',
            uri: 'https://agentclientprotocol.com/',
          },
        ],
      });
      const rendered = JSON.stringify(requests[0]!.messages);
      t.ok(rendered.includes('image/png'));
      t.ok(rendered.includes('audio/wav'));
      t.ok(rendered.includes('notes'));
      t.ok(rendered.includes('application/octet-stream'));
      t.ok(rendered.includes('https://agentclientprotocol.com/'));
    });
  });

  it('persists, lists, closes, resumes, loads with replay, and deletes sessions', async (t) => {
    const requests: GenerateRequest[] = [];
    const store = memoryStore();
    const ordinaryHistory = new MessageHistory();
    await commitConversationThread(store, {
      thread: {
        threadId: 'ordinary-conversation',
        historyRevisionId: ordinaryHistory.revisionId,
        createdAt: 1,
        updatedAt: 1,
        metadata: { owner: 'application' },
      },
      history: ordinaryHistory,
      expectedStoreVersion: null,
    });
    await withServer(
      scriptedModel([endTurn('first answer'), endTurn('second answer')], requests),
      async (client, updates) => {
        await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
        const created = (await client.call('session/new', {
          cwd: cwd(),
          additionalDirectories: ['/tmp'],
          mcpServers: [],
        })) as { sessionId: string };
        await client.call('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'first question' }],
        });
        const second = (await client.call('session/new', {
          cwd: cwd(),
          mcpServers: [],
        })) as { sessionId: string };
        await client.call('session/close', { sessionId: second.sessionId });
        const listed = (await client.call('session/list', { cwd: cwd() })) as {
          sessions: Array<Record<string, unknown>>;
          nextCursor?: string;
        };
        t.equal(listed.sessions.length, 1);
        t.equal(typeof listed.nextCursor, 'string');
        const nextPage = (await client.call('session/list', {
          cwd: cwd(),
          cursor: listed.nextCursor,
        })) as { sessions: Array<Record<string, unknown>> };
        t.equal(nextPage.sessions.length, 1);
        const allListed = [...listed.sessions, ...nextPage.sessions];
        t.ok(allListed.some((session) => session.sessionId === created.sessionId));
        t.ok(allListed.some((session) => session.sessionId === second.sessionId));
        t.deepEqual(
          allListed.find((session) => session.sessionId === created.sessionId)
            ?.additionalDirectories,
          ['/tmp'],
        );
        await client.call('session/close', { sessionId: created.sessionId });
        await client.call('session/resume', {
          sessionId: created.sessionId,
          cwd: cwd(),
          additionalDirectories: ['/var/tmp'],
          mcpServers: [],
        });
        await client.call('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'second question' }],
        });
        t.ok(JSON.stringify(requests[1]!.messages).includes('first question'));
        t.ok(JSON.stringify(requests[1]!.messages).includes('first answer'));
        await client.call('session/close', { sessionId: created.sessionId });
        updates.length = 0;
        await client.call('session/load', {
          sessionId: created.sessionId,
          cwd: cwd(),
          additionalDirectories: [],
          mcpServers: [],
        });
        const replay = JSON.stringify(updates);
        t.ok(replay.includes('user_message_chunk'));
        t.ok(replay.includes('agent_message_chunk'));
        t.ok(replay.includes('first question'));
        t.ok(replay.includes('second answer'));
        await client.call('session/delete', { sessionId: created.sessionId });
        await client.call('session/delete', { sessionId: second.sessionId });
        const empty = (await client.call('session/list', {})) as { sessions: unknown[] };
        t.equal(empty.sessions.length, 0);
        await t.rejects(
          () => client.call('session/delete', { sessionId: 'ordinary-conversation' }),
          (error: unknown) =>
            error instanceof JsonRpcError && error.code === ACP_RESOURCE_NOT_FOUND,
        );
        t.ok(await loadConversationThread(store, 'ordinary-conversation'));
        await t.rejects(
          () =>
            client.call('session/load', {
              sessionId: created.sessionId,
              cwd: cwd(),
              mcpServers: [],
            }),
          (error: unknown) =>
            error instanceof JsonRpcError && error.code === ACP_RESOURCE_NOT_FOUND,
        );
      },
      { server: { store, sessionListPageSize: 1 } },
    );
  });

  it('negotiates authentication, logout, terminal auth, and auth-required errors', async (t) => {
    const authenticated: string[] = [];
    let logout = false;
    let sharedAuthenticated = false;
    await withServer(
      scriptedModel([endTurn('unused')]),
      async (client) => {
        const initialized = (await client.call('initialize', {
          protocolVersion: 1,
          clientCapabilities: { auth: { terminal: false } },
        })) as Record<string, unknown>;
        const authMethods = initialized.authMethods as Array<Record<string, unknown>>;
        t.deepEqual(
          authMethods.map((method) => method.id),
          ['oauth'],
        );
        const caps = initialized.agentCapabilities as Record<string, unknown>;
        t.deepEqual(caps.auth, { logout: {} });
        await t.rejects(
          () => client.call('session/new', { cwd: cwd(), mcpServers: [] }),
          (error: unknown) => error instanceof JsonRpcError && error.code === ACP_AUTH_REQUIRED,
        );
        await client.call('authenticate', { methodId: 'oauth' });
        t.deepEqual(authenticated, ['oauth']);
        await client.call('session/new', { cwd: cwd(), mcpServers: [] });
        await client.call('logout', {});
        t.equal(logout, true);
        await t.rejects(
          () => client.call('session/list', {}),
          (error: unknown) => error instanceof JsonRpcError && error.code === ACP_AUTH_REQUIRED,
        );
        sharedAuthenticated = true;
        const afterTerminalAuth = (await client.call('session/list', {})) as {
          sessions: unknown[];
        };
        t.equal(afterTerminalAuth.sessions.length, 1);
      },
      {
        server: {
          authentication: {
            methods: [
              { id: 'oauth', name: 'OAuth' },
              { id: 'browser', name: 'Browser login', type: 'terminal', args: ['login'] },
            ],
            authenticate: (methodId) => {
              authenticated.push(methodId);
              sharedAuthenticated = true;
            },
            isAuthenticated: () => sharedAuthenticated,
            logout: () => {
              logout = true;
              sharedAuthenticated = false;
            },
          },
        },
      },
    );
  });

  it('applies negotiated modes and select/boolean session configuration', async (t) => {
    const contexts: Array<Record<string, unknown>> = [];
    const definition = agent({ model: scriptedModel([endTurn('configured')]) });
    await withServer(
      scriptedModel([]),
      async (client, updates) => {
        await client.call('initialize', {
          protocolVersion: 1,
          clientCapabilities: { session: { configOptions: { boolean: {} } } },
        });
        const created = (await client.call('session/new', {
          cwd: cwd(),
          mcpServers: [],
        })) as Record<string, unknown>;
        t.ok(created.modes);
        t.equal((created.configOptions as unknown[]).length, 2);
        await client.call('session/set_mode', { sessionId: created.sessionId, modeId: 'review' });
        await client.call('session/set_config_option', {
          sessionId: created.sessionId,
          configId: 'model',
          value: 'large',
        });
        await client.call('session/set_config_option', {
          sessionId: created.sessionId,
          configId: 'verbose',
          type: 'boolean',
          value: true,
        });
        await client.call('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'go' }],
        });
        t.equal(contexts.at(-1)?.modeId, 'review');
        const options = contexts.at(-1)?.configOptions as Array<Record<string, unknown>>;
        t.equal(options.find((option) => option.id === 'model')?.currentValue, 'large');
        t.equal(options.find((option) => option.id === 'verbose')?.currentValue, true);
        t.ok(JSON.stringify(updates).includes('current_mode_update'));
        t.ok(JSON.stringify(updates).includes('config_option_update'));
      },
      {
        agent: (context) => {
          contexts.push(context as unknown as Record<string, unknown>);
          return definition;
        },
        server: {
          modes: {
            currentModeId: 'code',
            availableModes: [
              { id: 'code', name: 'Code' },
              { id: 'review', name: 'Review' },
            ],
          },
          configOptions: [
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              currentValue: 'small',
              options: [
                { value: 'small', name: 'Small' },
                { value: 'large', name: 'Large' },
              ],
            },
            { type: 'boolean', id: 'verbose', name: 'Verbose', currentValue: false },
          ],
        },
      },
    );
  });

  it('automatically exposes negotiated filesystem, terminal, and form elicitation tools', async (t) => {
    const requests: GenerateRequest[] = [];
    const clientCalls: string[] = [];
    await withServer(
      scriptedModel(
        [
          toolTurn('read-1', 'acp_read_text_file', { path: '/tmp/input.txt' }),
          toolTurn('write-1', 'acp_write_text_file', { path: '/tmp/output.txt', content: 'saved' }),
          toolTurn('terminal-1', 'acp_terminal', { command: 'printf', args: ['done'] }),
          toolTurn('elicit-1', 'acp_elicit_form', {
            message: 'Choose a value',
            requestedSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          }),
          endTurn('complete'),
        ],
        requests,
      ),
      async (client, updates) => {
        await client.call('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            elicitation: { form: {} },
          },
        });
        const created = (await client.call('session/new', {
          cwd: cwd(),
          mcpServers: [],
        })) as { sessionId: string };
        await client.call('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'use client tools' }],
        });
        t.deepEqual(clientCalls, [
          'read:/tmp/input.txt',
          'write:/tmp/output.txt:saved',
          'create:printf',
          'wait:term-1',
          'output:term-1',
          'release:term-1',
          'elicit:form',
        ]);
        const definitions = requests[0]!.tools?.map((entry) => entry.name) ?? [];
        t.ok(definitions.includes('acp_read_text_file'));
        t.ok(definitions.includes('acp_write_text_file'));
        t.ok(definitions.includes('acp_terminal'));
        t.ok(definitions.includes('acp_elicit_form'));
        t.ok(JSON.stringify(updates).includes('"type":"terminal"'));
      },
      {
        configureClient(service) {
          service.method('fs/read_text_file').handle((params) => {
            const value = params as { path: string };
            clientCalls.push(`read:${value.path}`);
            return { content: 'input' };
          });
          service.method('fs/write_text_file').handle((params) => {
            const value = params as { path: string; content: string };
            clientCalls.push(`write:${value.path}:${value.content}`);
            return {};
          });
          service.method('terminal/create').handle((params) => {
            clientCalls.push(`create:${(params as { command: string }).command}`);
            return { terminalId: 'term-1' };
          });
          service.method('terminal/wait_for_exit').handle((params) => {
            clientCalls.push(`wait:${(params as { terminalId: string }).terminalId}`);
            return { exitCode: 0 };
          });
          service.method('terminal/output').handle((params) => {
            clientCalls.push(`output:${(params as { terminalId: string }).terminalId}`);
            return { output: 'done', truncated: false, exitStatus: { exitCode: 0 } };
          });
          service.method('terminal/release').handle((params) => {
            clientCalls.push(`release:${(params as { terminalId: string }).terminalId}`);
            return {};
          });
          service.method('terminal/kill').handle(() => ({}));
          service.method('elicitation/create').handle((params) => {
            clientCalls.push(`elicit:${(params as { mode: string }).mode}`);
            return { action: 'accept', content: { value: 'chosen' } };
          });
        },
      },
    );
  });

  it('supports plan/thought/commands, URL elicitation, and bidirectional extensions', async (t) => {
    const definition = agent({ model: scriptedModel([endTurn('extended')]) });
    const completed: string[] = [];
    await withServer(
      scriptedModel([]),
      async (client, updates) => {
        await client.call('initialize', {
          protocolVersion: 1,
          clientCapabilities: { elicitation: { url: {} }, terminal: true },
        });
        t.deepEqual(await client.call('_server_echo', { value: 4 }), { echoed: 4 });
        const created = (await client.call('session/new', {
          cwd: cwd(),
          mcpServers: [],
        })) as { sessionId: string };
        await client.call('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'extensions' }],
        });
        const rendered = JSON.stringify(updates);
        t.ok(rendered.includes('available_commands_update'));
        t.ok(rendered.includes('agent_thought_chunk'));
        t.ok(rendered.includes('"sessionUpdate":"plan"'));
        t.ok(rendered.includes('terminalKilled'));
        t.deepEqual(completed, ['url-1']);
      },
      {
        agent: async (context) => {
          t.deepEqual(await context.client.extension('_client_echo', { value: 3 }), { echoed: 3 });
          await context.client.notifyExtension('_client_notice', { value: 2 });
          await context.client.update({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'thinking' },
          });
          await context.client.update({
            sessionUpdate: 'plan',
            entries: [{ content: 'finish', priority: 'high', status: 'in_progress' }],
          });
          await context.client.elicit({
            mode: 'url',
            message: 'Authorize',
            elicitationId: 'url-1',
            url: 'https://example.com/auth',
          });
          await context.client.completeElicitation('url-1');
          const { terminalId } = await context.client.createTerminal({ command: 'sleep' });
          await context.client.killTerminal(terminalId);
          await context.client.releaseTerminal(terminalId);
          return definition;
        },
        server: {
          commands: [{ name: 'review', description: 'Review the workspace' }],
          extensions: {
            _server_echo: (params) => ({
              echoed: (params as { value: number }).value,
            }),
          },
        },
        configureClient(service, updates) {
          service.method('_client_echo').handle((params) => ({
            echoed: (params as { value: number }).value,
          }));
          service.method('_client_notice').handle((params) => {
            updates.push({ clientNotice: params });
          });
          service.method('elicitation/create').handle(() => ({ action: 'accept' }));
          service.method('elicitation/complete').handle((params) => {
            completed.push((params as { elicitationId: string }).elicitationId);
          });
          service.method('terminal/create').handle(() => ({ terminalId: 'kill-me' }));
          service.method('terminal/kill').handle((params) => {
            updates.push({ terminalKilled: params });
            return {};
          });
          service.method('terminal/release').handle(() => ({}));
        },
      },
    );
  });
});
