/**
 * Tests for fino:ai/cache — exact and semantic model cache wrappers.
 */
import { describe, it } from 'fino:test/test';
import { cache } from 'fino:cache';
import { memoryStore } from 'fino:store';
import { cachedModel } from 'fino:ai/cache';
import { ModelStreamImpl } from 'internal:ai/shared';
import type {
  EmbeddingModel,
  GenerateRequest,
  GenerateResult,
  Model,
  ModelStream,
  StreamEvent,
} from 'fino:ai/model';

function streamFrom(events: StreamEvent[]): ModelStream {
  async function* gen() {
    yield* events;
  }
  return new ModelStreamImpl(gen());
}

function fakeModel(): Model & { calls: number } {
  return {
    id: 'fake-chat',
    name: 'fake-chat',
    provider: 'test',
    calls: 0,
    stream(req: GenerateRequest): ModelStream {
      this.calls++;
      const text = `answer:${req.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('|')}`;
      return streamFrom([
        { type: 'text_delta', index: 0, text },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
        { type: 'stop', reason: 'end_turn' },
      ]);
    },
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      return this.stream(req).result();
    },
  };
}

function fakeEmbedder(): EmbeddingModel {
  return {
    id: 'fake-embed',
    name: 'fake-embed',
    provider: 'test',
    dimensions: 2,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        if (/refund|return/i.test(text)) return new Float32Array([1, 0]);
        return new Float32Array([0, 1]);
      });
    },
  };
}

describe('fino:ai/cache', () => {
  it('exact cache prevents repeated generate calls and reports avoided tokens', async (t) => {
    const base = fakeModel();
    const model = cachedModel(base, { cache: cache(memoryStore()) });
    const req = { messages: [{ role: 'user' as const, content: 'hello' }] };
    const first = await model.generate(req);
    const second = await model.generate({
      messages: [{ content: 'hello', role: 'user' as const }],
    });
    t.equal(base.calls, 1, 'second generate was served from cache');
    t.equal(first.text, second.text);
    t.deepEqual(second.usage, {
      inputTokens: 0,
      outputTokens: 0,
      localCacheReadInputTokens: 10,
      localCacheReadOutputTokens: 4,
    });
    t.deepEqual(second.providerMetadata?.finoCache, { hit: true, tier: 'exact' });
  });

  it('stream cache hits replay cached events', async (t) => {
    const base = fakeModel();
    const model = cachedModel(base, { cache: cache(memoryStore()) });
    const req = { messages: [{ role: 'user' as const, content: 'stream me' }] };
    const first = await model.stream(req).result();
    const events: StreamEvent[] = [];
    for await (const event of model.stream(req)) events.push(event);
    const second = await model.stream(req).result();
    t.equal(base.calls, 1, 'stream replay did not call base model');
    t.equal(first.text, second.text);
    t.ok(
      events.some(
        (event) => event.type === 'usage' && event.usage.localCacheReadOutputTokens === 4,
      ),
      'replayed usage reports saved output tokens',
    );
  });

  it('semantic cache serves similar requests and bypasses tool requests', async (t) => {
    const base = fakeModel();
    const model = cachedModel(base, {
      cache: cache(memoryStore()),
      semantic: {
        cache: cache(memoryStore()),
        embedder: fakeEmbedder(),
        threshold: 0.9,
      },
    });
    const first = await model.generate({
      messages: [{ role: 'user', content: 'What is the refund policy?' }],
    });
    const second = await model.generate({
      messages: [{ role: 'user', content: 'Can I return this?' }],
    });
    t.equal(base.calls, 1, 'semantic hit avoided base model');
    t.equal(second.text, first.text);
    t.equal((second.providerMetadata?.finoCache as Record<string, unknown>).tier, 'semantic');
    const toolReq: GenerateRequest = {
      messages: [{ role: 'user', content: 'Can I return this?' }],
      tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }],
    };
    await model.generate(toolReq);
    t.equal(base.calls, 2, 'tool request bypassed semantic cache');
  });
});
