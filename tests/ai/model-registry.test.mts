import { describe, it } from 'fino:test/test';
import {
  ModelRegistry,
  anthropicProvider,
  modelRegistry,
  openai,
  openaiProvider,
} from 'fino:ai/model';

interface FakeResponse {
  status: number;
  body: null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function jsonResponse(data: unknown): FakeResponse {
  return { status: 200, body: null, text: () => Promise.resolve(''), json: () => Promise.resolve(data) };
}

function errorResponse(status: number, body: string): FakeResponse {
  return { status, body: null, text: () => Promise.resolve(body), json: () => Promise.resolve({}) };
}

function fakeClient(responses: FakeResponse[]) {
  let idx = 0;
  return {
    capturedUrls: [] as string[],
    capturedHeaders: [] as Record<string, string>[],
    request(url: string, init?: { headers?: Record<string, string> }) {
      this.capturedUrls.push(url);
      if (init?.headers) this.capturedHeaders.push(init.headers);
      return Promise.resolve(responses[idx++] ?? responses[responses.length - 1]);
    },
  };
}

describe('ModelRegistry', () => {
  it('lists OpenAI-compatible models and ModelInfo.create constructs a model', async (t) => {
    const client = fakeClient([
      jsonResponse({
        object: 'list',
        data: [
          { id: 'gpt-a', object: 'model', created: 123, owned_by: 'openai' },
          { id: 'gpt-b', object: 'model', created: 456, owned_by: 'team' },
        ],
      }),
    ]);
    const provider = openaiProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example.com/v1',
      client,
      temperature: 0.1,
    });

    const models = await provider.listModels();

    t.equal(client.capturedUrls[0], 'https://proxy.example.com/v1/models');
    t.equal(client.capturedHeaders[0].authorization, 'Bearer sk-test');
    t.equal(models.length, 2);
    t.equal(models[0].id, 'gpt-a');
    t.equal(models[0].provider, 'openai');
    t.equal(models[0].createdAt, 123);
    t.equal(models[0].ownedBy, 'openai');

    const model = models[0].create({ maxTokens: 128 });
    t.equal(model.id, 'gpt-a');
    t.equal(model.provider, 'openai');
    t.equal(model.name, 'gpt-a');
  });

  it('lists Anthropic models and ModelInfo.create constructs a model', async (t) => {
    const client = fakeClient([
      jsonResponse({
        data: [
          {
            id: 'claude-a',
            type: 'model',
            display_name: 'Claude A',
            created_at: '2026-01-02T03:04:05Z',
          },
        ],
        has_more: false,
      }),
    ]);
    const provider = anthropicProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://anthropic.example.com',
      client,
    });

    const models = await provider.listModels();

    t.equal(client.capturedUrls[0], 'https://anthropic.example.com/v1/models');
    t.equal(client.capturedHeaders[0]['x-api-key'], 'anthropic-key');
    t.equal(client.capturedHeaders[0]['anthropic-version'], '2023-06-01');
    t.equal(models[0].id, 'claude-a');
    t.equal(models[0].provider, 'anthropic');
    t.equal(models[0].displayName, 'Claude A');
    t.equal(models[0].createdAt, Date.parse('2026-01-02T03:04:05Z'));

    const model = models[0].create();
    t.equal(model.id, 'claude-a');
    t.equal(model.provider, 'anthropic');
  });

  it('aggregates providers, caches by default, and refreshes on request', async (t) => {
    const openaiClient = fakeClient([
      jsonResponse({ data: [{ id: 'gpt-a', created: 1, owned_by: 'openai' }] }),
      jsonResponse({ data: [{ id: 'gpt-c', created: 2, owned_by: 'openai' }] }),
    ]);
    const anthropicClient = fakeClient([
      jsonResponse({ data: [{ id: 'claude-a', display_name: 'Claude A' }] }),
    ]);
    const registry = modelRegistry([
      openaiProvider({ apiKey: 'openai-key', client: openaiClient }),
      anthropicProvider({ apiKey: 'anthropic-key', client: anthropicClient }),
    ]);

    const first = await registry.list();
    const second = await registry.list();
    const refreshed = await registry.list({ provider: 'openai', refresh: true });

    t.deepEqual(first.map((m) => `${m.provider}:${m.id}`), ['openai:gpt-a', 'anthropic:claude-a']);
    t.equal(second.length, 2, 'second list uses cached entries');
    t.equal(openaiClient.capturedUrls.length, 2, 'OpenAI fetched once initially and once on refresh');
    t.equal(anthropicClient.capturedUrls.length, 1, 'Anthropic stayed cached');
    t.equal(refreshed[0].id, 'gpt-c');
  });

  it('creates by id and requires provider when ids are ambiguous', async (t) => {
    const first = openaiProvider({
      apiKey: 'first-key',
      client: fakeClient([jsonResponse({ data: [{ id: 'shared' }] })]),
    });
    const second = anthropicProvider({
      apiKey: 'second-key',
      client: fakeClient([jsonResponse({ data: [{ id: 'shared' }] })]),
    });
    const registry = new ModelRegistry([first, second]);

    await t.rejects(() => registry.create('shared'), /ambiguous/i);

    const model = await registry.create('shared', { provider: 'anthropic' });
    t.equal(model.id, 'shared');
    t.equal(model.provider, 'anthropic');
  });

  it('returns null for unknown ids and preserves direct factory defaults', async (t) => {
    const registry = modelRegistry([
      openaiProvider({
        apiKey: 'openai-key',
        client: fakeClient([jsonResponse({ data: [{ id: 'gpt-a' }] })]),
      }),
    ]);

    t.equal(await registry.get('missing'), null);
    const direct = openai({ apiKey: 'test', client: fakeClient([]) });
    t.equal(direct.id, 'gpt-4o');
  });

  it('throws ModelError when model listing fails', async (t) => {
    const provider = openaiProvider({
      apiKey: 'openai-key',
      client: fakeClient([errorResponse(500, 'no models')]),
    });

    await t.rejects(() => provider.listModels(), /500/);
  });

  it('throws a clear unsupported-listing error for providers without a models route', async (t) => {
    const provider = openaiProvider({
      apiKey: 'openai-key',
      baseUrl: 'https://minimal.example.com/v1',
      client: fakeClient([errorResponse(404, 'not found'), errorResponse(404, 'not found')]),
    });
    const registry = modelRegistry([provider]);

    await t.rejects(
      () => provider.listModels(),
      /does not support model listing/i,
    );
    await t.rejects(
      () => registry.list({ refresh: true }),
      /does not support model listing/i,
    );
  });
});
