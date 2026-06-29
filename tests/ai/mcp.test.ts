import { describe, it } from 'fino:test/test';
import { MCPClient, mcpServer, mountMcp } from 'fino:ai/mcp';
import { JsonRpcService, JsonRpcServer, JsonRpcPeer } from 'fino:jsonrpc';
import { agent } from 'fino:ai/agent';
import { tool } from 'fino:ai/tool';
import { task } from 'fino:task';
import { App } from 'fino:net/http/app';
import { parseEventStream } from 'fino:net/http/eventstream';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Transport } from 'fino:jsonrpc';
import type { Model, GenerateRequest } from 'fino:ai/model';
// ---------------------------------------------------------------------------
// In-memory transport pair
// ---------------------------------------------------------------------------
class MessageQueue {
  #buf: string[] = [];
  #waiters: Array<(s: string) => void> = [];
  #closed = false;
  push(msg: string): void {
    const w = this.#waiters.shift();
    if (w) {
      w(msg);
    } else {
      this.#buf.push(msg);
    }
  }
  close(): void {
    this.#closed = true;
    for (const w of this.#waiters) w('');
    this.#waiters = [];
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.#buf.length > 0) {
        yield this.#buf.shift()!;
      } else if (this.#closed) {
        return;
      } else {
        const msg = await new Promise<string>((resolve) => {
          this.#waiters.push(resolve);
        });
        if (msg === '' && this.#closed) return;
        if (msg) yield msg;
      }
    }
  }
}
function loopbackPair(): [Transport, Transport] {
  const aToB = new MessageQueue();
  const bToA = new MessageQueue();
  const a: Transport = {
    send: (msg) => {
      aToB.push(msg);
    },
    receive: () => bToA,
    close: () => {
      aToB.close();
      bToA.close();
    }
  };
  const b: Transport = {
    send: (msg) => {
      bToA.push(msg);
    },
    receive: () => aToB,
    close: () => {
      aToB.close();
      bToA.close();
    }
  };
  return [a, b];
}
// ---------------------------------------------------------------------------
// Mock MCP server via JsonRpcService + JsonRpcServer
// ---------------------------------------------------------------------------
const MOCK_TOOLS = [{
  name: 'get_weather',
  description: 'Get the weather for a location',
  inputSchema: {
    type: 'object',
    properties: { location: {
      type: 'string',
      description: 'City name'
    } },
    required: ['location']
  }
}, {
  name: 'search',
  description: 'Search the web',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query']
  }
}];
const MOCK_RESOURCES = [{
  uri: 'file:///data/report.txt',
  name: 'report.txt',
  description: 'Monthly report',
  mimeType: 'text/plain'
}, {
  uri: 'file:///data/config.json',
  name: 'config.json',
  mimeType: 'application/json'
}];
const MOCK_RESOURCE_TEMPLATES = [{
  uriTemplate: 'file:///data/{name}.txt',
  name: 'data-file',
  description: 'Data file by name',
  mimeType: 'text/plain'
}];
const MOCK_PROMPTS = [{
  name: 'summarize',
  description: 'Summarize text',
  arguments: [{
    name: 'text',
    required: true
  }]
}];
function makeMockMcpService(): JsonRpcService {
  return new JsonRpcService().method('initialize').handle(() => ({
    protocolVersion: '2025-06-18',
    capabilities: {
      tools: {},
      resources: {}
    },
    serverInfo: {
      name: 'mock-mcp-server',
      version: '1.0.0'
    }
  })).method('notifications/initialized').handle(() => undefined).method('tools/list').handle(() => ({ tools: MOCK_TOOLS })).method('tools/call').handle((params) => {
    const p = params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    if (p.name === 'get_weather') {
      const location = (p.arguments as {
        location?: string;
      })?.location ?? 'unknown';
      return {
        content: [{
          type: 'text',
          text: `Sunny, 22°C in ${location}`
        }],
        isError: false
      };
    }
    if (p.name === 'search') {
      const query = (p.arguments as {
        query?: string;
      })?.query ?? '';
      return {
        content: [{
          type: 'text',
          text: `Results for: ${query}`
        }],
        isError: false
      };
    }
    return {
      content: [{
        type: 'text',
        text: `Unknown tool: ${p.name}`
      }],
      isError: true
    };
  }).method('resources/list').handle(() => ({ resources: MOCK_RESOURCES })).method('resources/templates/list').handle(() => ({ resourceTemplates: MOCK_RESOURCE_TEMPLATES })).method('resources/read').handle((params) => {
    const p = params as {
      uri: string;
    };
    if (p.uri === 'file:///data/report.txt') {
      return { contents: [{
        uri: p.uri,
        mimeType: 'text/plain',
        text: 'Monthly sales: $42,000'
      }] };
    }
    return { contents: [{
      uri: p.uri,
      mimeType: 'application/json',
      text: '{"key":"value"}'
    }] };
  }).method('prompts/list').handle(() => ({ prompts: MOCK_PROMPTS })).method('prompts/get').handle((params) => {
    const p = params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    return {
      description: `Prompt ${p.name}`,
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Summarize: ${p.arguments?.text ?? ''}`
        }
      }]
    };
  });
}
function startMockServer(serverTransport: Transport): JsonRpcServer {
  const server = new JsonRpcServer(makeMockMcpService());
  void server.serve(serverTransport);
  return server;
}
describe('fino:ai/mcp — MCPClient', () => {
  it('connect() performs initialize + notifications/initialized handshake', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    t.ok(true, 'connect() resolved without error');
    await client.close();
  });
  it('listTools() returns Tool instances matching server tool definitions', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const tools = await client.listTools();
    t.equal(tools.length, 2, 'two tools returned');
    t.equal(tools[0]?.name, 'get_weather', 'first tool is get_weather');
    t.equal(tools[1]?.name, 'search', 'second tool is search');
    t.equal(tools[0]?.description, 'Get the weather for a location', 'description preserved');
    await client.close();
  });
  it('page list methods expose nextCursor metadata', async (t) => {
    const svc = new JsonRpcService().method('initialize').handle(() => ({
      protocolVersion: '2025-06-18',
      capabilities: {},
      serverInfo: {
        name: 'mock',
        version: '1'
      }
    })).method('notifications/initialized').handle(() => undefined).method('tools/list').handle((params) => {
      const p = params as {
        cursor?: string;
      } | undefined;
      return p?.cursor === 'next' ? { tools: [MOCK_TOOLS[1]] } : {
        tools: [MOCK_TOOLS[0]],
        nextCursor: 'next'
      };
    }).method('resources/list').handle((params) => {
      const p = params as {
        cursor?: string;
      } | undefined;
      return p?.cursor === 'next' ? { resources: [MOCK_RESOURCES[1]] } : {
        resources: [MOCK_RESOURCES[0]],
        nextCursor: 'next'
      };
    }).method('resources/templates/list').handle((params) => {
      const p = params as {
        cursor?: string;
      } | undefined;
      return p?.cursor === 'next' ? { resourceTemplates: [] } : {
        resourceTemplates: MOCK_RESOURCE_TEMPLATES,
        nextCursor: 'next'
      };
    }).method('prompts/list').handle((params) => {
      const p = params as {
        cursor?: string;
      } | undefined;
      return p?.cursor === 'next' ? { prompts: [] } : {
        prompts: MOCK_PROMPTS,
        nextCursor: 'next'
      };
    });
    const [clientTransport, serverTransport] = loopbackPair();
    void new JsonRpcServer(svc).serve(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const tools = await client.listToolsPage();
    t.equal(tools.nextCursor, 'next');
    t.equal(tools.items[0]?.name, 'get_weather');
    const toolsNext = await client.listToolsPage({ cursor: tools.nextCursor });
    t.equal(toolsNext.items[0]?.name, 'search');
    const resources = await client.listResourcesPage();
    t.equal(resources.nextCursor, 'next');
    t.equal(resources.items[0]?.uri, 'file:///data/report.txt');
    const templates = await client.listResourceTemplatesPage();
    t.equal(templates.nextCursor, 'next');
    t.equal(templates.items[0]?.uriTemplate, 'file:///data/{name}.txt');
    const prompts = await client.listPromptsPage();
    t.equal(prompts.nextCursor, 'next');
    t.equal(prompts.items[0]?.name, 'summarize');
    await client.close();
  });
  it('tool.invoke() proxies tools/call to the MCP server', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const tools = await client.listTools();
    const weatherTool = tools.find((tool) => tool.name === 'get_weather')!;
    t.ok(weatherTool, 'get_weather tool found');
    const ctx = {
      signal: new AbortController().signal,
      toolCallId: 'tc1',
      step: 0,
      runId: 'r1',
      messages: []
    };
    const result = await weatherTool.invoke({ location: 'Paris' }, ctx);
    t.equal(result.content, 'Sunny, 22°C in Paris', 'tool call returned expected content');
    t.ok(!result.isError, 'result is not an error');
    await client.close();
  });
  it('tool.invoke() surfaces isError when server signals a tool error', async (t) => {
    const svc = new JsonRpcService().method('initialize').handle(() => ({
      protocolVersion: '2025-06-18',
      capabilities: {},
      serverInfo: {
        name: 'mock',
        version: '1'
      }
    })).method('notifications/initialized').handle(() => undefined).method('tools/list').handle(() => ({ tools: [{
      name: 'bad_tool',
      description: 'bad',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }] })).method('tools/call').handle(() => ({
      content: [{
        type: 'text',
        text: 'error occurred'
      }],
      isError: true
    }));
    const [ct, st] = loopbackPair();
    void new JsonRpcServer(svc).serve(st);
    const badClient = new MCPClient({ transport: ct });
    await badClient.connect();
    const badTools = await badClient.listTools();
    const ctx = {
      signal: new AbortController().signal,
      toolCallId: 'tc1',
      step: 0,
      runId: 'r1',
      messages: []
    };
    const result = await badTools[0]!.invoke({}, ctx);
    t.equal(result.isError, true, 'isError is true');
    t.equal(result.content, 'error occurred', 'error content surfaced');
    await badClient.close();
  });
  it('listResources() returns resource definitions from the server', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const resources = await client.listResources();
    t.equal(resources.length, 2, 'two resources returned');
    t.equal(resources[0]?.uri, 'file:///data/report.txt', 'first resource uri correct');
    t.equal(resources[0]?.name, 'report.txt', 'first resource name correct');
    t.equal(resources[0]?.mimeType, 'text/plain', 'first resource mimeType correct');
    t.equal(resources[1]?.uri, 'file:///data/config.json', 'second resource uri correct');
    await client.close();
  });
  it('readResource() returns resource content by URI', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const contents = await client.readResource('file:///data/report.txt');
    t.equal(contents.length, 1, 'one content item returned');
    t.equal(contents[0]?.uri, 'file:///data/report.txt', 'content uri matches request');
    t.equal(contents[0]?.text, 'Monthly sales: $42,000', 'text content correct');
    t.equal(contents[0]?.mimeType, 'text/plain', 'mimeType correct');
    await client.close();
  });
  it('listResourceTemplates() returns resource template definitions', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const templates = await client.listResourceTemplates();
    t.deepEqual(templates, MOCK_RESOURCE_TEMPLATES);
    await client.close();
  });
  it('listPrompts() and getPrompt() return prompt content', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const prompts = await client.listPrompts();
    const prompt = await client.getPrompt('summarize', { text: 'hello' });
    t.deepEqual(prompts, MOCK_PROMPTS);
    t.equal(prompt.messages[0]?.role, 'user');
    t.equal(prompt.messages[0]?.content.type, 'text');
    t.equal((prompt.messages[0]?.content as {
      text?: string;
    }).text, 'Summarize: hello');
    await client.close();
  });
  it('listTools() throws if connect() has not been called', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await t.rejects(() => client.listTools(), /connect/i);
    await client.close();
  });
  it('MCP tools integrate with Agent for agent tool use', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const mcpTools = await client.listTools();
    let toolCallSeen = false;
    const toolModel: Model = {
      id: 'mock-model',
      name: 'mock-model',
      provider: 'test',
      dimensions: 0,
      stream(req: GenerateRequest) {
        const hasWeatherTool = req.tools?.some((tool) => tool.name === 'get_weather');
        async function* gen() {
          if (hasWeatherTool && !toolCallSeen) {
            toolCallSeen = true;
            yield {
              type: 'tool_call_start' as const,
              index: 0,
              id: 'tc1',
              name: 'get_weather'
            };
            yield {
              type: 'tool_call_delta' as const,
              index: 0,
              json: '{"location":"Tokyo"}'
            };
            yield {
              type: 'tool_call_end' as const,
              index: 0
            };
            yield {
              type: 'usage' as const,
              usage: {
                inputTokens: 10,
                outputTokens: 5
              }
            };
            yield {
              type: 'stop' as const,
              reason: 'tool_use' as const
            };
          } else {
            yield {
              type: 'text_delta' as const,
              index: 0,
              text: 'The weather in Tokyo is sunny.'
            };
            yield {
              type: 'usage' as const,
              usage: {
                inputTokens: 5,
                outputTokens: 8
              }
            };
            yield {
              type: 'stop' as const,
              reason: 'end_turn' as const
            };
          }
        }
        return new ModelStreamImpl(gen());
      },
      generate: async () => {
        throw new Error('use stream');
      },
      embed: async () => []
    };
    const h = agent({
      model: toolModel,
      tools: mcpTools
    });
    const result = await h.generate({ messages: [{
      role: 'user',
      content: 'What is the weather in Tokyo?'
    }] });
    t.ok(toolCallSeen, 'tool was called by the agent');
    t.equal(result.text, 'The weather in Tokyo is sunny.', 'final text is correct');
    const toolResultMsg = result.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && (m.content as Array<{
      type: string;
    }>).some((c) => c.type === 'tool_result'));
    t.ok(toolResultMsg, 'tool result message present in history');
    await client.close();
  });
  it('client handles server-initiated roots, sampling, and elicitation requests', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    const server = new JsonRpcPeer(serverTransport, makeMockMcpService());
    const client = new MCPClient({
      transport: clientTransport,
      roots: [{
        uri: 'file:///repo',
        name: 'repo'
      }],
      sampling: async (params) => ({
        role: 'assistant',
        content: {
          type: 'text',
          text: `sampled:${params.messages.length}`
        },
        model: 'test-model',
        stopReason: 'endTurn'
      }),
      elicitation: async (params) => ({
        action: 'accept',
        content: { value: params.message }
      })
    });
    await client.connect();
    const roots = await server.call('roots/list') as {
      roots: Array<{
        uri: string;
        name?: string;
      }>;
    };
    t.deepEqual(roots.roots, [{
      uri: 'file:///repo',
      name: 'repo'
    }]);
    const sampled = await server.call('sampling/createMessage', {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: 'hello'
        }
      }],
      maxTokens: 8
    }) as {
      role: string;
      content: {
        type: string;
        text?: string;
      };
      model: string;
    };
    t.equal(sampled.content.text, 'sampled:1');
    t.equal(sampled.model, 'test-model');
    const elicited = await server.call('elicitation/create', {
      message: 'Need input',
      requestedSchema: {
        type: 'object',
        properties: { value: { type: 'string' } }
      }
    }) as {
      action: string;
      content?: {
        value?: string;
      };
    };
    t.equal(elicited.action, 'accept');
    t.equal(elicited.content?.value, 'Need input');
    await client.close();
    await server.close();
  });
  it('client rejects malformed roots, sampling, and elicitation params', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    const server = new JsonRpcPeer(serverTransport, makeMockMcpService());
    const client = new MCPClient({
      transport: clientTransport,
      roots: [{ uri: 'file:///repo' }],
      sampling: () => ({
        role: 'assistant',
        content: {
          type: 'text',
          text: 'unused'
        }
      }),
      elicitation: () => ({ action: 'decline' })
    });
    await client.connect();
    await t.rejects(() => server.call('roots/list', { unexpected: true }), /Invalid roots\/list params/i);
    await t.rejects(() => server.call('sampling/createMessage', { maxTokens: 1 }), /Invalid sampling params/i);
    await t.rejects(() => server.call('elicitation/create', { requestedSchema: {} }), /Invalid elicitation params/i);
    await client.close();
    await server.close();
  });
  it('client notification callbacks handle server list/resource notifications', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    const server = mcpServer({
      tools: [],
      resources: [{ uri: 'memo://one' }],
      readResource: (uri) => ({
        uri,
        text: 'one'
      }),
      prompts: [{ name: 'p' }],
      listChanged: {
        tools: true,
        resources: true,
        prompts: true
      }
    });
    void server.serve(serverTransport);
    const seen: string[] = [];
    const client = new MCPClient({
      transport: clientTransport,
      onToolsChanged: () => {
        seen.push('tools');
      },
      onResourcesChanged: () => {
        seen.push('resources');
      },
      onPromptsChanged: () => {
        seen.push('prompts');
      },
      onResourceUpdated: (uri) => {
        seen.push(`updated:${uri}`);
      }
    });
    await client.connect();
    await client.subscribeResource('memo://one');
    await server.notifyToolsChanged();
    await server.notifyResourcesChanged();
    await server.notifyPromptsChanged();
    await server.notifyResourceUpdated('memo://one');
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.deepEqual(seen, [
      'tools',
      'resources',
      'prompts',
      'updated:memo://one'
    ]);
    seen.length = 0;
    await client.unsubscribeResource('memo://one');
    await server.notifyResourceUpdated('memo://one');
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.deepEqual(seen, [], 'unsubscribed resources no longer receive updates');
    await client.close();
  });
  it('routes resource update notifications to the matching custom transport subscription', async (t) => {
    const server = mcpServer({
      resources: [{ uri: 'memo://one' }, { uri: 'memo://two' }],
      readResource: (uri) => ({
        uri,
        text: uri
      })
    });
    const [clientOneTransport, serverOneTransport] = loopbackPair();
    const [clientTwoTransport, serverTwoTransport] = loopbackPair();
    void server.serve(serverOneTransport);
    void server.serve(serverTwoTransport);
    const seenOne: string[] = [];
    const seenTwo: string[] = [];
    const clientOne = new MCPClient({
      transport: clientOneTransport,
      onResourceUpdated: (uri) => {
        seenOne.push(uri);
      }
    });
    const clientTwo = new MCPClient({
      transport: clientTwoTransport,
      onResourceUpdated: (uri) => {
        seenTwo.push(uri);
      }
    });
    await clientOne.connect();
    await clientTwo.connect();
    await clientOne.subscribeResource('memo://one');
    await clientTwo.subscribeResource('memo://two');
    await server.notifyResourceUpdated('memo://one');
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.deepEqual(seenOne, ['memo://one']);
    t.deepEqual(seenTwo, [], 'second peer did not receive first peer subscription update');
    await server.notifyResourceUpdated('memo://two');
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.deepEqual(seenOne, ['memo://one']);
    t.deepEqual(seenTwo, ['memo://two']);
    await clientOne.close();
    await clientTwo.close();
  });
});
describe('fino:ai/mcp — MCPServer', () => {
  it('initialize returns server capabilities and creates an HTTP session', async (t) => {
    const server = mcpServer({
      name: 'test-mcp',
      version: '1.2.3',
      instructions: 'Use carefully.',
      tools: [tool({
        name: 'echo',
        description: 'Echo input text.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text']
        },
        execute: ({ text }: {
          text: string;
        }) => text
      })],
      resources: [{
        uri: 'memo://one',
        name: 'memo',
        mimeType: 'text/plain'
      }],
      resourceTemplates: [{
        uriTemplate: 'memo://{id}',
        name: 'memo-template'
      }],
      readResource: (uri) => ({
        uri,
        mimeType: 'text/plain',
        text: 'memo text'
      }),
      prompts: [{
        name: 'reply',
        description: 'Draft a reply'
      }],
      getPrompt: (name, args) => ({
        description: name,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: String(args.text ?? '')
          }
        }]
      })
    });
    const res = await server.httpHandler()(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://127.0.0.1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test',
            version: '1'
          }
        }
      })
    }));
    t.equal(res.status, 200, 'initialize returns success');
    t.ok(res.headers.get('mcp-session-id'), 'session id header is set');
    const json = await res.json() as {
      result: {
        protocolVersion: string;
        serverInfo: {
          name: string;
          version: string;
        };
        capabilities: Record<string, unknown>;
        instructions?: string;
      };
    };
    t.equal(json.result.protocolVersion, '2025-06-18', 'protocol version is negotiated');
    t.deepEqual(json.result.serverInfo, {
      name: 'test-mcp',
      version: '1.2.3'
    }, 'server info returned');
    t.ok(json.result.capabilities.tools, 'tools capability advertised');
    t.ok(json.result.capabilities.resources, 'resources capability advertised');
    t.ok(json.result.capabilities.prompts, 'prompts capability advertised');
    t.equal(json.result.instructions, 'Use carefully.', 'instructions included');
  });
  it('serves Fino tools and resources over an in-memory MCP transport', async (t) => {
    const echo = tool({
      name: 'echo',
      description: 'Echo input text.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      execute: ({ text }: {
        text: string;
      }) => ({ content: [{
        type: 'text',
        text
      }, {
        type: 'image',
        mediaType: 'image/png',
        data: 'aW1n'
      }] })
    });
    const server = mcpServer({
      name: 'loopback',
      tools: [echo],
      resources: [{
        uri: 'memo://one',
        name: 'memo',
        mimeType: 'text/plain'
      }],
      resourceTemplates: [{
        uriTemplate: 'memo://{id}',
        name: 'memo-template'
      }],
      readResource: (uri) => ({
        uri,
        mimeType: 'text/plain',
        text: 'memo text'
      }),
      prompts: [{
        name: 'reply',
        description: 'Draft a reply'
      }],
      getPrompt: (_name, args) => ({ messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: String(args.text ?? '')
        }
      }] })
    });
    const [clientTransport, serverTransport] = loopbackPair();
    void server.serve(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const tools = await client.listTools();
    t.equal(tools.length, 1, 'one tool exposed');
    t.equal(tools[0]?.name, 'echo', 'tool name exposed');
    const result = await tools[0]!.invoke({ text: 'hello' }, {
      signal: new AbortController().signal,
      toolCallId: 'tc1',
      step: 0,
      runId: 'r1',
      messages: []
    });
    t.equal(result.content, 'hello', 'client sees text tool output');
    const resources = await client.listResources();
    t.deepEqual(resources, [{
      uri: 'memo://one',
      name: 'memo',
      mimeType: 'text/plain'
    }], 'resources exposed');
    const contents = await client.readResource('memo://one');
    t.deepEqual(contents, [{
      uri: 'memo://one',
      mimeType: 'text/plain',
      text: 'memo text'
    }], 'resource content returned');
    t.deepEqual(await client.listResourceTemplates(), [{
      uriTemplate: 'memo://{id}',
      name: 'memo-template'
    }], 'resource templates exposed');
    const prompt = await client.getPrompt('reply', { text: 'hello' });
    t.equal((prompt.messages[0]?.content as {
      text?: string;
    }).text, 'hello', 'prompt content returned');
    await client.close();
  });
  it('serves Task values directly as MCP tools', async (t) => {
    const echo = task({
      name: 'task_echo',
      description: 'Echo input text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      outputMode: 'text',
      run: ({ text }: {
        text: string;
      }) => text
    });
    const server = mcpServer({
      name: 'task-server',
      tools: [echo]
    });
    const [clientTransport, serverTransport] = loopbackPair();
    void server.serve(serverTransport);
    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const tools = await client.listTools();
    t.equal(tools[0]?.name, 'task_echo');
    const result = await tools[0]!.invoke({ text: 'hello task' }, {
      signal: new AbortController().signal,
      toolCallId: 'tc1',
      step: 0,
      runId: 'r1',
      messages: []
    });
    t.equal(result.content, 'hello task');
    await client.close();
  });
  it('mounts on App routes and preserves middleware behavior', async (t) => {
    const server = mcpServer({ tools: [tool({
      name: 'echo',
      description: 'Echo input text.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      execute: ({ text }: {
        text: string;
      }) => text
    })] });
    const app = new App().use((ctx, next) => {
      if (ctx.request.headers.get('authorization') !== 'Bearer ok') return new Response('blocked', { status: 401 });
      return next();
    });
    mountMcp(app, '/mcp', server);
    const blocked = await app.handle(new Request('http://local.test/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://local.test'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test',
            version: '1'
          }
        }
      })
    }));
    t.equal(blocked.status, 401, 'app middleware can block MCP route');
    const ok = await app.handle(new Request('http://local.test/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://local.test',
        authorization: 'Bearer ok'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test',
            version: '1'
          }
        }
      })
    }));
    t.equal(ok.status, 200, 'authorized initialize reaches MCP route');
  });
  it('enforces Streamable HTTP session, GET, DELETE, and origin behavior', async (t) => {
    const server = mcpServer({ name: 'http-state' });
    const handler = server.httpHandler();
    const beforeInit = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://127.0.0.1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'tools/list'
      })
    }));
    t.equal(beforeInit.status, 400, 'requests before initialize are rejected');
    const init = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://127.0.0.1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test',
            version: '1'
          }
        }
      })
    }));
    const sessionId = init.headers.get('mcp-session-id')!;
    t.ok(sessionId, 'initialize creates a session');
    const missingSession = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://127.0.0.1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      })
    }));
    t.equal(missingSession.status, 400, 'missing session id is rejected after initialization');
    const get = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        Origin: 'http://127.0.0.1',
        'mcp-session-id': sessionId
      }
    }));
    t.equal(get.status, 200, 'GET opens an SSE stream');
    t.equal(get.headers.get('content-type')?.split(';')[0], 'text/event-stream');
    const deleted = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'DELETE',
      headers: {
        Origin: 'http://127.0.0.1',
        'mcp-session-id': sessionId
      }
    }));
    t.equal(deleted.status, 202, 'DELETE terminates the session');
    const afterDelete = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://127.0.0.1',
        'mcp-session-id': sessionId
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list'
      })
    }));
    t.equal(afterDelete.status, 404, 'terminated session is gone');
    const blockedOrigin = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://evil.test'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test',
            version: '1'
          }
        }
      })
    }));
    t.equal(blockedOrigin.status, 403, 'cross-origin request is rejected by default');
  });
  it('HTTP GET SSE receives notifications and replays after Last-Event-ID', async (t) => {
    const server = mcpServer({
      name: 'http-sse',
      tools: [],
      listChanged: { tools: true }
    });
    const handler = server.httpHandler();
    const init = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://127.0.0.1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test',
            version: '1'
          }
        }
      })
    }));
    const sessionId = init.headers.get('mcp-session-id')!;
    const firstStream = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        Origin: 'http://127.0.0.1',
        'mcp-session-id': sessionId
      }
    }));
    const firstIter = parseEventStream(firstStream.body!)[Symbol.asyncIterator]();
    await server.notifyToolsChanged();
    const first = await firstIter.next();
    t.equal(first.value.type, 'message');
    t.ok(first.value.id, 'SSE event has an id');
    t.equal(JSON.parse(first.value.data).method, 'notifications/tools/list_changed');
    await server.notifyToolsChanged();
    const replay = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        Origin: 'http://127.0.0.1',
        'mcp-session-id': sessionId,
        'last-event-id': first.value.id
      }
    }));
    const replayIter = parseEventStream(replay.body!)[Symbol.asyncIterator]();
    const replayed = await replayIter.next();
    t.equal(JSON.parse(replayed.value.data).method, 'notifications/tools/list_changed');
    t.ok(replayed.value.id !== first.value.id, 'replayed event advances the cursor');
    const deliveredToOriginal = await firstIter.next();
    t.equal(deliveredToOriginal.value.id, replayed.value.id, 'second event was also delivered on the original open stream');
    const deleted = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'DELETE',
      headers: {
        Origin: 'http://127.0.0.1',
        'mcp-session-id': sessionId
      }
    }));
    t.equal(deleted.status, 202);
    const closed = await firstIter.next();
    t.equal(closed.done, true, 'DELETE closes the open SSE stream');
  });
  it('paginated list handlers return nextCursor from cursor-aware sources', async (t) => {
    const server = mcpServer({
      tools: ({ cursor }) => cursor === '2' ? { items: [tool({
        name: 'b',
        description: 'B',
        parameters: {
          type: 'object',
          properties: {}
        },
        execute: () => 'b'
      })] } : {
        items: [tool({
          name: 'a',
          description: 'A',
          parameters: {
            type: 'object',
            properties: {}
          },
          execute: () => 'a'
        })],
        nextCursor: '2'
      },
      resources: ({ cursor }) => cursor === '2' ? { items: [{ uri: 'memo://b' }] } : {
        items: [{ uri: 'memo://a' }],
        nextCursor: '2'
      },
      resourceTemplates: ({ cursor }) => cursor === '2' ? { items: [{ uriTemplate: 'memo://b/{id}' }] } : {
        items: [{ uriTemplate: 'memo://a/{id}' }],
        nextCursor: '2'
      },
      prompts: ({ cursor }) => cursor === '2' ? { items: [{ name: 'b' }] } : {
        items: [{ name: 'a' }],
        nextCursor: '2'
      }
    });
    const handler = server.httpHandler();
    const init = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        Origin: 'http://127.0.0.1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test',
            version: '1'
          }
        }
      })
    }));
    const sessionId = init.headers.get('mcp-session-id')!;
    const call = async (id: number, method: string, params?: unknown) => {
      const res = await handler(new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          Origin: 'http://127.0.0.1',
          'mcp-session-id': sessionId
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          ...params !== undefined ? { params } : {}
        })
      }));
      return await res.json() as {
        result: Record<string, unknown>;
      };
    };
    t.equal((await call(2, 'tools/list')).result.nextCursor, '2');
    t.equal(((await call(3, 'tools/list', { cursor: '2' })).result.tools as Array<{
      name: string;
    }>)[0]?.name, 'b');
    t.equal((await call(4, 'resources/list')).result.nextCursor, '2');
    t.equal((await call(5, 'resources/templates/list')).result.nextCursor, '2');
    t.equal((await call(6, 'prompts/list')).result.nextCursor, '2');
  });
});
