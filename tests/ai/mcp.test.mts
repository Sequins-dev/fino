import { describe, it } from 'fino:test/test';
import { MCPClient } from 'fino:ai/mcp';
import { JsonRpcService, JsonRpcServer, JsonRpcPeer } from 'fino:jsonrpc';
import { agent } from 'fino:ai/agent';
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
    if (w) { w(msg); } else { this.#buf.push(msg); }
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
        const msg = await new Promise<string>((resolve) => { this.#waiters.push(resolve); });
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
    send: (msg) => { aToB.push(msg); },
    receive: () => bToA,
    close: () => { aToB.close(); bToA.close(); },
  };
  const b: Transport = {
    send: (msg) => { bToA.push(msg); },
    receive: () => aToB,
    close: () => { aToB.close(); bToA.close(); },
  };
  return [a, b];
}

// ---------------------------------------------------------------------------
// Mock MCP server via JsonRpcService + JsonRpcServer
// ---------------------------------------------------------------------------

const MOCK_TOOLS = [
  {
    name: 'get_weather',
    description: 'Get the weather for a location',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string', description: 'City name' } },
      required: ['location'],
    },
  },
  {
    name: 'search',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

const MOCK_RESOURCES = [
  { uri: 'file:///data/report.txt', name: 'report.txt', description: 'Monthly report', mimeType: 'text/plain' },
  { uri: 'file:///data/config.json', name: 'config.json', mimeType: 'application/json' },
];

function makeMockMcpService(): JsonRpcService {
  return new JsonRpcService()
    .method('initialize').handle(() => ({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
    }))
    .method('notifications/initialized').handle(() => undefined)
    .method('tools/list').handle(() => ({ tools: MOCK_TOOLS }))
    .method('tools/call').handle((params) => {
      const p = params as { name: string; arguments?: Record<string, unknown> };
      if (p.name === 'get_weather') {
        const location = (p.arguments as { location?: string })?.location ?? 'unknown';
        return { content: [{ type: 'text', text: `Sunny, 22°C in ${location}` }], isError: false };
      }
      if (p.name === 'search') {
        const query = (p.arguments as { query?: string })?.query ?? '';
        return { content: [{ type: 'text', text: `Results for: ${query}` }], isError: false };
      }
      return { content: [{ type: 'text', text: `Unknown tool: ${p.name}` }], isError: true };
    })
    .method('resources/list').handle(() => ({ resources: MOCK_RESOURCES }))
    .method('resources/read').handle((params) => {
      const p = params as { uri: string };
      if (p.uri === 'file:///data/report.txt') {
        return { contents: [{ uri: p.uri, mimeType: 'text/plain', text: 'Monthly sales: $42,000' }] };
      }
      return { contents: [{ uri: p.uri, mimeType: 'application/json', text: '{"key":"value"}' }] };
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

  it('tool.invoke() proxies tools/call to the MCP server', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    startMockServer(serverTransport);

    const client = new MCPClient({ transport: clientTransport });
    await client.connect();
    const tools = await client.listTools();

    const weatherTool = tools.find((tool) => tool.name === 'get_weather')!;
    t.ok(weatherTool, 'get_weather tool found');

    const ctx = { signal: new AbortController().signal, toolCallId: 'tc1', step: 0, runId: 'r1', messages: [] };
    const result = await weatherTool.invoke({ location: 'Paris' }, ctx);

    t.equal(result.content, 'Sunny, 22°C in Paris', 'tool call returned expected content');
    t.ok(!result.isError, 'result is not an error');
    await client.close();
  });

  it('tool.invoke() surfaces isError when server signals a tool error', async (t) => {
    const svc = new JsonRpcService()
      .method('initialize').handle(() => ({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock', version: '1' } }))
      .method('notifications/initialized').handle(() => undefined)
      .method('tools/list').handle(() => ({ tools: [{ name: 'bad_tool', description: 'bad', inputSchema: { type: 'object', properties: {} } }] }))
      .method('tools/call').handle(() => ({ content: [{ type: 'text', text: 'error occurred' }], isError: true }));

    const [ct, st] = loopbackPair();
    void new JsonRpcServer(svc).serve(st);
    const badClient = new MCPClient({ transport: ct });
    await badClient.connect();
    const badTools = await badClient.listTools();

    const ctx = { signal: new AbortController().signal, toolCallId: 'tc1', step: 0, runId: 'r1', messages: [] };
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
      name: 'mock-model',
      dimensions: 0,
      stream(req: GenerateRequest) {
        const hasWeatherTool = req.tools?.some((tool) => tool.name === 'get_weather');
        async function* gen() {
          if (hasWeatherTool && !toolCallSeen) {
            toolCallSeen = true;
            yield { type: 'tool_call_start' as const, index: 0, id: 'tc1', name: 'get_weather' };
            yield { type: 'tool_call_delta' as const, index: 0, json: '{"location":"Tokyo"}' };
            yield { type: 'tool_call_end' as const, index: 0 };
            yield { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 5 } };
            yield { type: 'stop' as const, reason: 'tool_use' as const };
          } else {
            yield { type: 'text_delta' as const, index: 0, text: 'The weather in Tokyo is sunny.' };
            yield { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 8 } };
            yield { type: 'stop' as const, reason: 'end_turn' as const };
          }
        }
        return new ModelStreamImpl(gen());
      },
      generate: async () => { throw new Error('use stream'); },
      embed: async () => [],
    };

    const h = agent({ model: toolModel, tools: mcpTools });
    const result = await h.generate({ messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }] });

    t.ok(toolCallSeen, 'tool was called by the agent');
    t.equal(result.text, 'The weather in Tokyo is sunny.', 'final text is correct');

    const toolResultMsg = result.messages.find((m) =>
      m.role === 'user' &&
      Array.isArray(m.content) &&
      (m.content as Array<{ type: string }>).some((c) => c.type === 'tool_result'),
    );
    t.ok(toolResultMsg, 'tool result message present in history');

    await client.close();
  });
});
