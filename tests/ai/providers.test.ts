import { describe, it } from 'fino:test/test';
import { env } from 'fino:process';
import { anthropic, openai } from 'fino:ai/model';
import type { StreamEvent, GenerateResult } from 'fino:ai/model';
const enc = new TextEncoder();
function sseFrame(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}
function sseBytes(...frames: string[]): AsyncIterable<Uint8Array> {
  const buf = enc.encode(frames.join(''));
  return {
    [Symbol.asyncIterator]: async function* () {
      yield buf;
    },
  };
}
interface FakeResponse {
  status: number;
  body: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
function fakeClient(responses: FakeResponse[]) {
  let idx = 0;
  return {
    capturedUrls: [] as string[],
    capturedBodies: [] as unknown[],
    capturedHeaders: [] as Record<string, string>[],
    request(
      url: string,
      init?: {
        body?: string | null;
        headers?: Record<string, string>;
      },
    ) {
      this.capturedUrls.push(url);
      if (init?.body) this.capturedBodies.push(JSON.parse(init.body));
      if (init?.headers) this.capturedHeaders.push(init.headers);
      return Promise.resolve(responses[idx++] ?? responses[responses.length - 1]);
    },
  };
}
function streamResponse(body: AsyncIterable<Uint8Array>): FakeResponse {
  return {
    status: 200,
    body,
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({}),
  };
}
function jsonResponse(data: unknown): FakeResponse {
  return {
    status: 200,
    body: null,
    text: () => Promise.resolve(''),
    json: () => Promise.resolve(data),
  };
}
function errorResponse(status: number, msg: string): FakeResponse {
  return {
    status,
    body: null,
    text: () => Promise.resolve(msg),
    json: () => Promise.resolve({}),
  };
}
// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
const anthropicTextSse = [
  sseFrame('message_start', {
    message: {
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  }),
  sseFrame('content_block_start', {
    index: 0,
    content_block: {
      type: 'text',
      text: '',
    },
  }),
  sseFrame('content_block_delta', {
    index: 0,
    delta: {
      type: 'text_delta',
      text: 'Hi',
    },
  }),
  sseFrame('content_block_delta', {
    index: 0,
    delta: {
      type: 'text_delta',
      text: ' there',
    },
  }),
  sseFrame('content_block_stop', { index: 0 }),
  sseFrame('message_delta', {
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 5 },
  }),
  sseFrame('message_stop', {}),
];
const anthropicToolSse = [
  sseFrame('message_start', {
    message: {
      usage: {
        input_tokens: 20,
        output_tokens: 0,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 0,
      },
    },
  }),
  sseFrame('content_block_start', {
    index: 0,
    content_block: {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'calculator',
    },
  }),
  sseFrame('content_block_delta', {
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"op',
    },
  }),
  sseFrame('content_block_delta', {
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: '":"add","a":1,"b":2}',
    },
  }),
  sseFrame('content_block_stop', { index: 0 }),
  sseFrame('message_delta', {
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 12 },
  }),
  sseFrame('message_stop', {}),
];
describe('anthropic provider', () => {
  it('streams text and assembles result', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...anthropicTextSse))]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    const result = await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
      })
      .result();
    t.equal(result.text, 'Hi there');
    t.equal(result.stopReason, 'end_turn');
    t.equal(result.usage.inputTokens, 10);
    t.equal(result.usage.outputTokens, 5);
  });
  it('yields StreamEvents in order when iterating', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...anthropicTextSse))]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    const collected: StreamEvent[] = [];
    for await (const event of model.stream({
      messages: [
        {
          role: 'user',
          content: 'hi',
        },
      ],
    })) {
      collected.push(event);
    }
    t.ok(
      collected.some((e) => e.type === 'text_delta'),
      'has text_delta events',
    );
    t.ok(
      collected.some((e) => e.type === 'usage'),
      'has usage event',
    );
    t.ok(
      collected.some((e) => e.type === 'stop'),
      'has stop event',
    );
  });
  it('streams tool calls and assembles args', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...anthropicToolSse))]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    const result = await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'calc',
          },
        ],
      })
      .result();
    t.equal(result.stopReason, 'tool_use');
    t.equal(result.toolCalls.length, 1);
    t.equal(result.toolCalls[0].id, 'toolu_1');
    t.equal(result.toolCalls[0].name, 'calculator');
    t.deepEqual(result.toolCalls[0].args, {
      op: 'add',
      a: 1,
      b: 2,
    });
  });
  it('propagates cache token counts', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...anthropicToolSse))]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    const result = await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'calc',
          },
        ],
      })
      .result();
    t.equal(result.usage.cacheReadInputTokens, 80);
  });
  it('generate() returns assembled result from JSON response', async (t) => {
    const responseData = {
      content: [
        {
          type: 'text',
          text: 'Done.',
        },
      ],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 5,
        output_tokens: 2,
      },
    };
    const client = fakeClient([jsonResponse(responseData)]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    const result = await model.generate({
      messages: [
        {
          role: 'user',
          content: 'test',
        },
      ],
    });
    t.equal(result.text, 'Done.');
    t.equal(result.stopReason, 'end_turn');
    t.equal(result.usage.inputTokens, 5);
    t.ok(
      result.providerMetadata?.anthropic,
      'raw Anthropic response is exposed as provider metadata',
    );
  });
  it('generate() returns tool calls from JSON response', async (t) => {
    const responseData = {
      content: [
        {
          type: 'text',
          text: '',
        },
        {
          type: 'tool_use',
          id: 'toolu_x',
          name: 'search',
          input: { query: 'fino' },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 8,
      },
    };
    const client = fakeClient([jsonResponse(responseData)]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    const result = await model.generate({
      messages: [
        {
          role: 'user',
          content: 'search',
        },
      ],
    });
    t.equal(result.toolCalls.length, 1);
    t.deepEqual(result.toolCalls[0].args, { query: 'fino' });
  });
  it('throws on non-2xx streaming response', async (t) => {
    const client = fakeClient([errorResponse(401, '{"error":"unauthorized"}')]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    await t.rejects(
      () =>
        model
          .stream({
            messages: [
              {
                role: 'user',
                content: 'hi',
              },
            ],
          })
          .result(),
      /401/,
    );
  });
  it('throws on non-2xx generate response', async (t) => {
    const client = fakeClient([errorResponse(429, 'rate limited')]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    await t.rejects(
      () =>
        model.generate({
          messages: [
            {
              role: 'user',
              content: 'hi',
            },
          ],
        }),
      /429/,
    );
  });
  it('embed() rejects with clear unsupported message', async (t) => {
    const model = anthropic({
      apiKey: 'test',
      client: fakeClient([]),
    });
    await t.rejects(() => model.embed(['hello']), /does not provide a native embeddings endpoint/i);
  });
  it('sends correct request shape for tools', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...anthropicTextSse))]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'go',
          },
        ],
        tools: [
          {
            name: 'fn',
            description: 'does thing',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        ],
        toolChoice: 'auto',
      })
      .result();
    const body = client.capturedBodies[0] as Record<string, unknown>;
    t.ok(Array.isArray(body.tools), 'tools array present');
    const tool = (body.tools as Array<Record<string, unknown>>)[0];
    t.equal(tool.name, 'fn');
    t.ok('input_schema' in tool, 'uses input_schema key for Anthropic');
    t.deepEqual(body.tool_choice, { type: 'auto' });
  });
  it('sends topP and Anthropic provider options', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...anthropicTextSse))]);
    const model = anthropic({
      apiKey: 'test',
      client,
      topP: .8,
      providerOptions: { anthropic: { metadata: { user_id: 'u1' } } },
    });
    await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'go',
          },
        ],
        topP: .7,
      })
      .result();
    const body = client.capturedBodies[0] as Record<string, unknown>;
    t.equal(body.top_p, .7);
    t.deepEqual(body.metadata, { user_id: 'u1' });
  });
  it('sends x-api-key and anthropic-version headers', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...anthropicTextSse))]);
    const model = anthropic({
      apiKey: 'my-key',
      client,
    });
    await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
      })
      .result();
    const headers = client.capturedHeaders[0];
    t.equal(headers['x-api-key'], 'my-key');
    t.ok(headers['anthropic-version'], 'anthropic-version header present');
  });
  it('uses baseUrl override in request URL', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...anthropicTextSse))]);
    const model = anthropic({
      apiKey: 'test',
      baseUrl: 'https://proxy.example.com',
      client,
    });
    await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
      })
      .result();
    t.ok(client.capturedUrls[0].startsWith('https://proxy.example.com'), 'uses custom baseUrl');
  });
  it('maps refusal stop reason to refusal', async (t) => {
    const frames = [
      sseFrame('message_start', {
        message: {
          usage: {
            input_tokens: 5,
            output_tokens: 0,
          },
        },
      }),
      sseFrame('message_delta', {
        delta: { stop_reason: 'refusal' },
        usage: { output_tokens: 0 },
      }),
      sseFrame('message_stop', {}),
    ];
    const client = fakeClient([streamResponse(sseBytes(...frames))]);
    const model = anthropic({
      apiKey: 'test',
      client,
    });
    const result = await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
      })
      .result();
    t.equal(result.stopReason, 'refusal', 'refusal stop reason preserved');
  });
});
// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------
const openaiTextSse = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\n',
  'data: [DONE]\n\n',
];
const openaiToolSse = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\""}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"fino\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n',
  'data: [DONE]\n\n',
];
describe('openai provider', () => {
  it('sends max_completion_tokens for reasoning-era model families', async (t) => {
    for (const [modelName, expectedKey] of [
      ['gpt-5.6-sol', 'max_completion_tokens'],
      ['o3-mini', 'max_completion_tokens'],
      ['gpt-4o', 'max_tokens'],
      ['llama-3.1-8b-instruct', 'max_tokens'],
    ] as const) {
      const client = fakeClient([streamResponse(sseBytes(...openaiTextSse))]);
      const model = openai({ apiKey: 'test', client, model: modelName });
      await model.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 77 }).result();
      const body = client.capturedBodies[0] as Record<string, unknown>;
      t.equal(body[expectedKey], 77, `${modelName} uses ${expectedKey}`);
      const otherKey = expectedKey === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
      t.equal(body[otherKey], undefined, `${modelName} omits ${otherKey}`);
    }
  });
  it('streams text and assembles result', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...openaiTextSse))]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    const result = await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
      })
      .result();
    t.equal(result.text, 'Hello!');
    t.equal(result.stopReason, 'end_turn');
    t.equal(result.usage.inputTokens, 8);
    t.equal(result.usage.outputTokens, 3);
  });
  it('streams tool calls and assembles args', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...openaiToolSse))]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    const result = await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'search',
          },
        ],
      })
      .result();
    t.equal(result.stopReason, 'tool_use');
    t.equal(result.toolCalls.length, 1);
    t.equal(result.toolCalls[0].id, 'call_1');
    t.equal(result.toolCalls[0].name, 'search');
    t.deepEqual(result.toolCalls[0].args, { q: 'fino' });
  });
  it('generate() returns assembled result from JSON response', async (t) => {
    const responseData = {
      choices: [
        {
          message: {
            content: 'World',
            tool_calls: null,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
      },
    };
    const client = fakeClient([jsonResponse(responseData)]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    const result = await model.generate({
      messages: [
        {
          role: 'user',
          content: 'hi',
        },
      ],
    });
    t.equal(result.text, 'World');
    t.equal(result.stopReason, 'end_turn');
    t.equal(result.usage.inputTokens, 5);
    t.equal(result.usage.outputTokens, 2);
    t.ok(result.providerMetadata?.openai, 'raw OpenAI response is exposed as provider metadata');
  });
  it('generate() returns tool calls from JSON response', async (t) => {
    const responseData = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_x',
                type: 'function',
                function: {
                  name: 'fn',
                  arguments: '{"k":"v"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 6,
      },
    };
    const client = fakeClient([jsonResponse(responseData)]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    const result = await model.generate({
      messages: [
        {
          role: 'user',
          content: 'go',
        },
      ],
    });
    t.equal(result.toolCalls.length, 1);
    t.deepEqual(result.toolCalls[0].args, { k: 'v' });
    t.equal(result.stopReason, 'tool_use');
  });
  it('throws on non-2xx streaming response', async (t) => {
    const client = fakeClient([errorResponse(401, '{"error":"invalid_api_key"}')]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    await t.rejects(
      () =>
        model
          .stream({
            messages: [
              {
                role: 'user',
                content: 'hi',
              },
            ],
          })
          .result(),
      /401/,
    );
  });
  it('throws on non-2xx generate response', async (t) => {
    const client = fakeClient([errorResponse(429, 'rate limited')]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    await t.rejects(
      () =>
        model.generate({
          messages: [
            {
              role: 'user',
              content: 'hi',
            },
          ],
        }),
      /429/,
    );
  });
  it('embed() returns Float32Array per input text', async (t) => {
    const embedData = {
      data: [
        {
          embedding: [.1, .2, .3],
          index: 0,
        },
        {
          embedding: [.4, .5, .6],
          index: 1,
        },
      ],
    };
    const client = fakeClient([jsonResponse(embedData)]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    const result = await model.embed(['hello', 'world']);
    t.equal(result.length, 2);
    t.ok(result[0] instanceof Float32Array, 'returns Float32Array');
    t.equal(result[0][0], .10000000149011612);
    t.equal(result[1][2], .6000000238418579);
  });
  it('embed() returns embeddings in index order when response is unordered', async (t) => {
    const embedData = {
      data: [
        {
          embedding: [.9, .8],
          index: 1,
        },
        {
          embedding: [.1, .2],
          index: 0,
        },
      ],
    };
    const client = fakeClient([jsonResponse(embedData)]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    const result = await model.embed(['a', 'b']);
    t.equal(result[0][0], .10000000149011612);
    t.equal(result[1][0], .8999999761581421);
  });
  it('embed() throws on non-2xx response', async (t) => {
    const client = fakeClient([errorResponse(500, 'server error')]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    await t.rejects(() => model.embed(['text']), /500/);
  });
  it('sends correct request shape for tools', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...openaiTextSse))]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'go',
          },
        ],
        tools: [
          {
            name: 'fn',
            description: 'does thing',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        ],
        toolChoice: 'any',
      })
      .result();
    const body = client.capturedBodies[0] as Record<string, unknown>;
    t.ok(Array.isArray(body.tools), 'tools array present');
    const tool = (body.tools as Array<Record<string, unknown>>)[0];
    t.equal((tool.function as Record<string, unknown>).name, 'fn');
    t.equal(tool.type, 'function');
    t.equal(body.tool_choice, 'required', 'any maps to required');
  });
  it('sends topP, seed, and OpenAI provider options', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...openaiTextSse))]);
    const model = openai({
      apiKey: 'test',
      client,
      topP: .9,
      seed: 123,
      providerOptions: { openai: { user: 'user-1' } },
    });
    await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'go',
          },
        ],
        topP: .5,
      })
      .result();
    const body = client.capturedBodies[0] as Record<string, unknown>;
    t.equal(body.top_p, .5);
    t.equal(body.seed, 123);
    t.equal(body.user, 'user-1');
  });
  it('sends Authorization header and stream_options', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...openaiTextSse))]);
    const model = openai({
      apiKey: 'sk-test',
      client,
    });
    await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
      })
      .result();
    const headers = client.capturedHeaders[0];
    t.equal(headers['authorization'], 'Bearer sk-test');
    const body = client.capturedBodies[0] as Record<string, unknown>;
    t.deepEqual(body.stream_options, { include_usage: true });
  });
  it('sends req.system as a system message when messages has none', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...openaiTextSse))]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
        system: 'You are helpful.',
      })
      .result();
    const body = client.capturedBodies[0] as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    t.equal(messages[0].role, 'system', 'first message has role system');
    t.equal(messages[0].content, 'You are helpful.', 'system content matches req.system');
    t.equal(messages[1].role, 'user', 'user message follows');
  });
  it('does not duplicate system when messages already has role:system', async (t) => {
    const client = fakeClient([streamResponse(sseBytes(...openaiTextSse))]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    await model
      .stream({
        messages: [
          {
            role: 'system',
            content: 'From messages.',
          },
          {
            role: 'user',
            content: 'hi',
          },
        ],
        system: 'From req.system.',
      })
      .result();
    const body = client.capturedBodies[0] as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    const sysMsgs = messages.filter((m) => m.role === 'system');
    t.equal(sysMsgs.length, 1, 'only one system message');
    t.equal(sysMsgs[0].content, 'From messages.', 'messages system wins over req.system');
  });
  it('parses prompt_tokens_details.cached_tokens in streaming usage', async (t) => {
    const cachedSse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":15}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const client = fakeClient([streamResponse(sseBytes(...cachedSse))]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    const result = await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
      })
      .result();
    t.equal(
      result.usage.cacheReadInputTokens,
      15,
      'cacheReadInputTokens from prompt_tokens_details.cached_tokens',
    );
  });
  it('parses prompt_tokens_details.cached_tokens in generate() response', async (t) => {
    const responseData = {
      choices: [
        {
          message: { content: 'Done' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 15 },
      },
    };
    const client = fakeClient([jsonResponse(responseData)]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    const result = await model.generate({
      messages: [
        {
          role: 'user',
          content: 'hi',
        },
      ],
    });
    t.equal(
      result.usage.cacheReadInputTokens,
      15,
      'cacheReadInputTokens from generate() prompt_tokens_details.cached_tokens',
    );
  });
  it('maps content_filter finish reason', async (t) => {
    const contentFilterSse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n',
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":0}}\n\n',
      'data: [DONE]\n\n',
    ];
    const client = fakeClient([streamResponse(sseBytes(...contentFilterSse))]);
    const model = openai({
      apiKey: 'test',
      client,
    });
    const result = await model
      .stream({
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
      })
      .result();
    t.equal(result.stopReason, 'content_filter', 'content_filter stop reason preserved');
  });
});
// ---------------------------------------------------------------------------
// Shared: API key resolution
// ---------------------------------------------------------------------------
describe('provider API key resolution', () => {
  it('anthropic throws when no key is provided', async (t) => {
    const old = env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    try {
      t.throws(() => anthropic({ client: fakeClient([]) }), /No API key found/);
    } finally {
      if (old !== undefined) env.ANTHROPIC_API_KEY = old;
    }
  });
  it('openai throws when no key is provided', async (t) => {
    const old = env.OPENAI_API_KEY;
    delete env.OPENAI_API_KEY;
    try {
      t.throws(() => openai({ client: fakeClient([]) }), /No API key found/);
    } finally {
      if (old !== undefined) env.OPENAI_API_KEY = old;
    }
  });
});
