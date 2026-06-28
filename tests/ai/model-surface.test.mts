import { describe, it } from 'fino:test/test';
import { openai, anthropic } from 'fino:ai/model';
import { openai as directOpenAI } from 'fino:ai/model/openai';
import { anthropic as directAnthropic } from 'fino:ai/model/anthropic';
import { GuardrailError } from 'fino:ai/runtime';
import { agent } from 'fino:ai/agent';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Model, GenerateRequest, StreamEvent } from 'fino:ai/model';

type FakeClient = {
  lastBody: Record<string, unknown> | null;
  request(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | null }): Promise<{
    status: number;
    body: null;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
};

function makeOpenAIClient(responseText: string): FakeClient {
  const client: FakeClient = {
    lastBody: null,
    request(_url, init) {
      client.lastBody = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return Promise.resolve({
        status: 200,
        body: null,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({
          choices: [{ message: { content: responseText, role: 'assistant' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      });
    },
  };
  return client;
}

function makeAnthropicClient(responseText: string): FakeClient {
  const client: FakeClient = {
    lastBody: null,
    request(_url, init) {
      client.lastBody = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return Promise.resolve({
        status: 200,
        body: null,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({
          content: [{ type: 'text', text: responseText }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      });
    },
  };
  return client;
}

function stubModel(events: StreamEvent[]): Model {
  return {
    name: 'claude-test',
    dimensions: 0,
    stream(_req: GenerateRequest): import('fino:ai/model').ModelStream {
      async function* gen() { yield* events; }
      return new ModelStreamImpl(gen());
    },
    generate: async () => { throw new Error('use stream'); },
    embed: async () => [],
  };
}

describe('model surface — responseFormat (structured output)', () => {
  it('provider adapters resolve from nested model specifiers', async (t) => {
    const o = directOpenAI({ client: makeOpenAIClient('ok') as never, model: 'gpt-direct', apiKey: 'test' });
    const a = directAnthropic({ client: makeAnthropicClient('ok') as never, model: 'claude-direct', apiKey: 'test' });

    t.equal(o.provider, 'openai', 'OpenAI nested specifier creates OpenAI model');
    t.equal(o.id, 'gpt-direct');
    t.equal(a.provider, 'anthropic', 'Anthropic nested specifier creates Anthropic model');
    t.equal(a.id, 'claude-direct');
  });

  it('providers expose explicit id, provider, and capabilities metadata', async (t) => {
    const o = openai({ client: makeOpenAIClient('ok') as never, model: 'gpt-test', apiKey: 'test' });
    const a = anthropic({ client: makeAnthropicClient('ok') as never, model: 'claude-test', apiKey: 'test' });

    t.equal(o.id, 'gpt-test', 'OpenAI id is explicit');
    t.equal(o.provider, 'openai', 'OpenAI provider is explicit');
    t.equal(o.capabilities?.responseFormat, true, 'OpenAI declares native structured output');

    t.equal(a.id, 'claude-test', 'Anthropic id is explicit');
    t.equal(a.provider, 'anthropic', 'Anthropic provider is explicit');
    t.equal(a.capabilities?.responseFormat, true, 'Anthropic declares native structured output');
  });

  it('OpenAI: serializes responseFormat into response_format in request body', async (t) => {
    const client = makeOpenAIClient('{"name":"Alice"}');
    const model = openai({ client: client as never, model: 'gpt-4o', apiKey: 'test' });
    await model.generate({
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: {
        type: 'json_schema',
        name: 'person',
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    });

    t.ok(client.lastBody, 'request was made');
    const rf = client.lastBody?.response_format as Record<string, unknown> | undefined;
    t.equal(rf?.type, 'json_schema', 'type is json_schema');
    const js = rf?.json_schema as Record<string, unknown> | undefined;
    t.equal(js?.name, 'person', 'name passed through');
    t.equal(js?.strict, true, 'strict defaults to true');
    t.ok(js?.schema, 'schema present');
  });

  it('OpenAI: omits response_format when responseFormat is not set', async (t) => {
    const client = makeOpenAIClient('hello');
    const model = openai({ client: client as never, model: 'gpt-4o', apiKey: 'test' });
    await model.generate({ messages: [{ role: 'user', content: 'hi' }] });

    t.ok(client.lastBody, 'request was made');
    t.equal(client.lastBody?.response_format, undefined, 'no response_format when not requested');
  });

  it('Anthropic: serializes responseFormat into output_config in request body', async (t) => {
    const client = makeAnthropicClient('{"name":"Bob"}');
    const model = anthropic({ client: client as never, model: 'claude-opus-4-8', apiKey: 'test' });
    await model.generate({
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: {
        type: 'json_schema',
        name: 'person',
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        strict: false,
      },
    });

    t.ok(client.lastBody, 'request was made');
    const oc = client.lastBody?.output_config as Record<string, unknown> | undefined;
    t.ok(oc, 'output_config present');
    const fmt = (oc?.format as Record<string, unknown> | undefined);
    t.equal(fmt?.type, 'json_schema', 'format type is json_schema');
    const js = fmt?.json_schema as Record<string, unknown> | undefined;
    t.equal(js?.name, 'person', 'name passed through');
    t.equal(js?.strict, false, 'explicit strict value preserved');
  });

  it('Anthropic: omits output_config when responseFormat is not set', async (t) => {
    const client = makeAnthropicClient('hello');
    const model = anthropic({ client: client as never, model: 'claude-opus-4-8', apiKey: 'test' });
    await model.generate({ messages: [{ role: 'user', content: 'hi' }] });

    t.ok(client.lastBody, 'request was made');
    t.equal(client.lastBody?.output_config, undefined, 'no output_config when not requested');
  });
});

describe('model surface — DocumentPart', () => {
  it('OpenAI: serializes DocumentPart into file block in request body', async (t) => {
    const client = makeOpenAIClient('summary');
    const model = openai({ client: client as never, model: 'gpt-4o', apiKey: 'test' });
    await model.generate({
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          mediaType: 'application/pdf',
          data: 'base64encodeddata',
          name: 'report.pdf',
        }],
      }],
    });

    t.ok(client.lastBody, 'request was made');
    const msgs = client.lastBody?.messages as Array<Record<string, unknown>> | undefined;
    const userMsg = msgs?.find((m) => m.role === 'user');
    t.ok(userMsg, 'user message present');
    const parts = userMsg?.content as Array<Record<string, unknown>> | undefined;
    const docPart = parts?.find((p) => p.type === 'file');
    t.ok(docPart, 'file part present');
    const file = docPart?.file as Record<string, unknown> | undefined;
    t.equal(file?.filename, 'report.pdf', 'filename matches name');
    t.equal(file?.file_data, 'data:application/pdf;base64,base64encodeddata', 'file_data is data URI');
  });

  it('OpenAI: uses "document" as default filename when name is not set', async (t) => {
    const client = makeOpenAIClient('ok');
    const model = openai({ client: client as never, model: 'gpt-4o', apiKey: 'test' });
    await model.generate({
      messages: [{
        role: 'user',
        content: [{ type: 'document', mediaType: 'text/plain', data: 'aGVsbG8=' }],
      }],
    });

    const msgs = client.lastBody?.messages as Array<Record<string, unknown>> | undefined;
    const userMsg = msgs?.find((m) => m.role === 'user');
    const parts = userMsg?.content as Array<Record<string, unknown>> | undefined;
    const filePart = parts?.find((p) => p.type === 'file');
    const file = filePart?.file as Record<string, unknown> | undefined;
    t.equal(file?.filename, 'document', 'default filename is "document"');
  });

  it('Anthropic: serializes DocumentPart into document block with base64 source', async (t) => {
    const client = makeAnthropicClient('summary');
    const model = anthropic({ client: client as never, model: 'claude-opus-4-8', apiKey: 'test' });
    await model.generate({
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          mediaType: 'application/pdf',
          data: 'base64encodeddata',
          name: 'report.pdf',
        }],
      }],
    });

    t.ok(client.lastBody, 'request was made');
    const msgs = client.lastBody?.messages as Array<Record<string, unknown>> | undefined;
    const userMsg = msgs?.find((m) => m.role === 'user');
    const parts = userMsg?.content as Array<Record<string, unknown>> | undefined;
    const docPart = parts?.find((p) => p.type === 'document');
    t.ok(docPart, 'document part present');
    const source = docPart?.source as Record<string, unknown> | undefined;
    t.equal(source?.type, 'base64', 'source type is base64');
    t.equal(source?.media_type, 'application/pdf', 'media_type preserved');
    t.equal(source?.data, 'base64encodeddata', 'data preserved');
    t.equal(docPart?.title, 'report.pdf', 'title set from name');
  });

  it('Anthropic: omits title when name is not set', async (t) => {
    const client = makeAnthropicClient('ok');
    const model = anthropic({ client: client as never, model: 'claude-opus-4-8', apiKey: 'test' });
    await model.generate({
      messages: [{
        role: 'user',
        content: [{ type: 'document', mediaType: 'text/plain', data: 'aGVsbG8=' }],
      }],
    });

    const msgs = client.lastBody?.messages as Array<Record<string, unknown>> | undefined;
    const userMsg = msgs?.find((m) => m.role === 'user');
    const parts = userMsg?.content as Array<Record<string, unknown>> | undefined;
    const docPart = parts?.find((p) => p.type === 'document');
    t.equal(docPart?.title, undefined, 'no title when name is absent');
  });
});

describe('model surface — guardrails', () => {
  it('blocking input guardrail throws GuardrailError before the model is called', async (t) => {
    let modelCalled = false;
    const trackingModel: Model = {
      name: 'claude-test',
      dimensions: 0,
      stream(_req: GenerateRequest) {
        modelCalled = true;
        async function* gen() {
          yield { type: 'text_delta' as const, index: 0, text: 'should not reach' };
          yield { type: 'usage' as const, usage: { inputTokens: 1, outputTokens: 1 } };
          yield { type: 'stop' as const, reason: 'end_turn' as const };
        }
        return new ModelStreamImpl(gen());
      },
      generate: async () => { throw new Error('use stream'); },
      embed: async () => [],
    };

    const h = agent({
      model: trackingModel,
      guardrails: {
        input: (messages) => {
          const hasBlocked = messages.some(
            (m) => typeof m.content === 'string' && m.content.includes('blocked'),
          );
          return { action: hasBlocked ? 'block' : 'allow', reason: 'blocked content detected' };
        },
      },
    });

    await t.rejects(
      () => h.generate({ messages: [{ role: 'user', content: 'this is blocked content' }] }),
      /blocked content detected/,
    );
    t.equal(modelCalled, false, 'model is never called when input is blocked');
  });

  it('blocking input guardrail error name is GuardrailError', async (t) => {
    const model = stubModel([
      { type: 'text_delta', index: 0, text: 'x' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'stop', reason: 'end_turn' },
    ]);
    const h = agent({
      model,
      guardrails: {
        input: () => ({ action: 'block', reason: 'policy violation' }),
      },
    });

    let caught: unknown;
    try {
      await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    } catch (err) {
      caught = err;
    }

    t.ok(caught instanceof GuardrailError, 'throws GuardrailError instance');
    t.equal((caught as GuardrailError).name, 'GuardrailError', 'name is GuardrailError');
    t.equal((caught as GuardrailError).reason, 'policy violation', 'reason is preserved');
  });

  it('redacting input guardrail rewrites messages before model call', async (t) => {
    let seenMessages: import('fino:ai/model').ModelMessage[] = [];
    const model: Model = {
      name: 'gpt-test',
      dimensions: 0,
      stream(req: GenerateRequest) {
        seenMessages = req.messages;
        async function* gen() {
          yield { type: 'text_delta' as const, index: 0, text: 'ok' };
          yield { type: 'usage' as const, usage: { inputTokens: 2, outputTokens: 1 } };
          yield { type: 'stop' as const, reason: 'end_turn' as const };
        }
        return new ModelStreamImpl(gen());
      },
      generate: async () => { throw new Error('use stream'); },
      embed: async () => [],
    };

    const h = agent({
      model,
      guardrails: {
        input: (messages) => ({
          action: 'redact',
          messages: messages.map((m) => ({
            ...m,
            content: typeof m.content === 'string' ? '[REDACTED]' : m.content,
          })),
        }),
      },
    });

    await h.generate({ messages: [{ role: 'user', content: 'secret info' }] });
    t.equal(seenMessages.length, 1, 'one message sent');
    t.equal(seenMessages[0]?.content, '[REDACTED]', 'message was redacted');
  });

  it('blocking output guardrail throws GuardrailError after model responds', async (t) => {
    const model = stubModel([
      { type: 'text_delta', index: 0, text: 'UNSAFE OUTPUT' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
      { type: 'stop', reason: 'end_turn' },
    ]);

    const h = agent({
      model,
      guardrails: {
        output: (text) => ({
          action: text.includes('UNSAFE') ? 'block' : 'allow',
          reason: 'unsafe content detected',
        }),
      },
    });

    let caught: unknown;
    try {
      await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    } catch (err) {
      caught = err;
    }

    t.ok(caught instanceof GuardrailError, 'throws GuardrailError');
    t.equal((caught as GuardrailError).reason, 'unsafe content detected', 'reason preserved');
  });

  it('redacting output guardrail rewrites response text', async (t) => {
    const model = stubModel([
      { type: 'text_delta', index: 0, text: 'My SSN is 123-45-6789' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
      { type: 'stop', reason: 'end_turn' },
    ]);

    const h = agent({
      model,
      guardrails: {
        output: (text) => ({
          action: 'redact',
          text: text.replace(/\d{3}-\d{2}-\d{4}/g, '[SSN REDACTED]'),
        }),
      },
    });

    const result = await h.generate({ messages: [{ role: 'user', content: 'tell me your ssn' }] });
    t.equal(result.text, 'My SSN is [SSN REDACTED]', 'SSN is redacted in result text');

    const lastMsg = result.messages[result.messages.length - 1];
    t.equal(
      typeof lastMsg?.content === 'string' ? lastMsg.content : '',
      'My SSN is [SSN REDACTED]',
      'redacted text stored in conversation history',
    );
  });

  it('allow guardrail does not interfere', async (t) => {
    const model = stubModel([
      { type: 'text_delta', index: 0, text: 'hello world' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
      { type: 'stop', reason: 'end_turn' },
    ]);

    const h = agent({
      model,
      guardrails: {
        input: () => ({ action: 'allow' }),
        output: () => ({ action: 'allow' }),
      },
    });

    const result = await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(result.text, 'hello world', 'allow guardrail does not modify response');
  });
});

describe('model surface — forced-tool structured output fallback', () => {
  it('Agent with output schema falls back to forced-tool path for unknown provider', async (t) => {
    let toolCallSeen = false;
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

    const toolModel: Model = {
      name: 'unknown-model-xyz',
      dimensions: 0,
      stream(req: GenerateRequest) {
        const hasRespondTool = req.tools?.some((t) => t.name === 'respond');
        async function* gen() {
          if (hasRespondTool && req.toolChoice && typeof req.toolChoice === 'object' && (req.toolChoice as { name: string }).name === 'respond') {
            toolCallSeen = true;
            yield { type: 'tool_call_start' as const, index: 0, id: 'tc1', name: 'respond' };
            yield { type: 'tool_call_delta' as const, index: 0, json: '{"answer":"42"}' };
            yield { type: 'tool_call_end' as const, index: 0 };
            yield { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 5 } };
            yield { type: 'stop' as const, reason: 'tool_use' as const };
          } else {
            yield { type: 'text_delta' as const, index: 0, text: 'fallback text' };
            yield { type: 'usage' as const, usage: { inputTokens: 2, outputTokens: 2 } };
            yield { type: 'stop' as const, reason: 'end_turn' as const };
          }
        }
        return new ModelStreamImpl(gen());
      },
      generate: async () => { throw new Error('use stream'); },
      embed: async () => [],
    };

    const h = agent({ model: toolModel, output: schema });
    const result = await h.generate({ messages: [{ role: 'user', content: 'what is the answer?' }] });

    t.ok(toolCallSeen, 'forced-tool path used for unknown provider');
    t.deepEqual(result.object, { answer: '42' }, 'structured object returned');
  });
});
