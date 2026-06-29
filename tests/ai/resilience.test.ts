import { describe, it } from 'fino:test/test';
import { agent } from 'fino:ai/agent';
import { ModelError } from 'fino:ai/model';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Model, ModelStream, GenerateRequest, StreamEvent } from 'fino:ai/model';

function endTurnEvents(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', index: 0, text },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
    { type: 'stop', reason: 'end_turn' },
  ];
}

function refusalEvents(): StreamEvent[] {
  return [
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 0 } },
    { type: 'stop', reason: 'refusal' },
  ];
}

function streamOf(events: StreamEvent[]): ModelStream {
  async function* gen() { yield* events; }
  return new ModelStreamImpl(gen());
}

function scriptModel(turns: Array<StreamEvent[] | 'throw429' | 'throw503'>): Model {
  let idx = 0;
  return {
    id: 'claude-test',
    name: 'claude-test',
    provider: 'anthropic',
    dimensions: 0,
    stream(_req: GenerateRequest): ModelStream {
      const turn = turns[idx % turns.length];
      idx++;
      if (turn === 'throw429') {
        throw new ModelError('Provider API error 429: rate limited', { status: 429, retryAfterMs: 50 });
      }
      if (turn === 'throw503') {
        throw new ModelError('Provider API error 503: unavailable', { status: 503 });
      }
      async function* gen() { yield* (turn as StreamEvent[]); }
      return new ModelStreamImpl(gen());
    },
    async generate(_req: GenerateRequest) { throw new Error('use stream'); },
    async embed() { return []; },
  };
}

function countingModel(name: string, results: Array<StreamEvent[] | Error>): { model: Model; callCount: () => number } {
  let count = 0;
  const model: Model = {
    id: name,
    name,
    provider: name.startsWith('gpt') ? 'openai' : 'anthropic',
    dimensions: 0,
    stream(_req: GenerateRequest): ModelStream {
      const result = results[count % results.length];
      count++;
      if (result instanceof Error) throw result;
      const events = result as StreamEvent[];
      async function* gen() { yield* events; }
      return new ModelStreamImpl(gen());
    },
    async generate(_req: GenerateRequest) { throw new Error('use stream'); },
    async embed() { return []; },
  };
  return { model, callCount: () => count };
}

describe('agent resilience', () => {
  it('succeeds on first attempt when no errors', async (t) => {
    const { model, callCount } = countingModel('claude-test', [endTurnEvents('hi')]);
    const h = agent({ model });
    const result = await h.generate({ messages: [{ role: 'user', content: 'hello' }] });
    t.equal(result.text, 'hi');
    t.equal(callCount(), 1, 'model called once');
  });

  it('retries on 429 and succeeds after retries', async (t) => {
    const { model, callCount } = countingModel('claude-test', [
      new ModelError('rate limited', { status: 429, retryAfterMs: 1 }),
      new ModelError('rate limited', { status: 429, retryAfterMs: 1 }),
      endTurnEvents('ok'),
    ]);
    const h = agent({ model, retry: { maxRetries: 3, baseDelayMs: 1 } });
    const result = await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(result.text, 'ok');
    t.equal(callCount(), 3, 'model called 3 times (2 retries + 1 success)');
  });

  it('retries on 503 and succeeds', async (t) => {
    const { model, callCount } = countingModel('claude-test', [
      new ModelError('unavailable', { status: 503 }),
      endTurnEvents('done'),
    ]);
    const h = agent({ model, retry: { maxRetries: 2, baseDelayMs: 1 } });
    const result = await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(result.text, 'done');
    t.equal(callCount(), 2);
  });

  it('does not retry 4xx errors (except 429)', async (t) => {
    const { model, callCount } = countingModel('claude-test', [
      new ModelError('API error 401: unauthorized', { status: 401 }),
    ]);
    const h = agent({ model, retry: { maxRetries: 3, baseDelayMs: 1 } });
    await t.rejects(
      () => h.generate({ messages: [{ role: 'user', content: 'hi' }] }),
      /401/,
    );
    t.equal(callCount(), 1, '401 is not retried');
  });

  it('throws after exhausting maxRetries', async (t) => {
    const { model, callCount } = countingModel('claude-test', [
      new ModelError('API error 429: rate limited', { status: 429, retryAfterMs: 1 }),
    ]);
    const h = agent({ model, retry: { maxRetries: 2, baseDelayMs: 1 } });
    await t.rejects(
      () => h.generate({ messages: [{ role: 'user', content: 'hi' }] }),
      /429/,
    );
    t.equal(callCount(), 3, 'tried 3 times (initial + 2 retries)');
  });

  it('falls back to secondary model when primary fails', async (t) => {
    const primary = countingModel('claude-primary', [
      new ModelError('rate limited', { status: 429, retryAfterMs: 1 }),
    ]);
    const secondary = countingModel('gpt-fallback', [endTurnEvents('fallback response')]);

    const h = agent({
      model: primary.model,
      fallback: [secondary.model],
      retry: { maxRetries: 0 },
    });
    const result = await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(result.text, 'fallback response', 'fallback model response used');
    t.equal(primary.callCount(), 1, 'primary tried once');
    t.equal(secondary.callCount(), 1, 'fallback tried once');
  });

  it('stream emits fallback lifecycle event when secondary model is used', async (t) => {
    const primary = countingModel('claude-primary', [
      new ModelError('rate limited', { status: 429, retryAfterMs: 1 }),
    ]);
    const secondary = countingModel('gpt-fallback', [endTurnEvents('fallback response')]);

    const h = agent({
      model: primary.model,
      fallback: [secondary.model],
      retry: { maxRetries: 0 },
    });
    const stream = h.stream({ messages: [{ role: 'user', content: 'hi' }] });
    const events: string[] = [];
    for await (const event of stream.reader) events.push(event.type);
    const result = await stream.result;

    t.equal(result.text, 'fallback response');
    t.ok(events.includes('fallback'), 'fallback event emitted');
  });

  it('advances to fallback model when primary refuses', async (t) => {
    const primary = countingModel('claude-primary', [refusalEvents()]);
    const secondary = countingModel('gpt-fallback', [endTurnEvents('alternative')]);

    const h = agent({
      model: primary.model,
      fallback: [secondary.model],
    });
    const result = await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(result.text, 'alternative', 'fallback model used after refusal');
    t.equal(primary.callCount(), 1);
    t.equal(secondary.callCount(), 1);
  });

  it('retries primary before falling back', async (t) => {
    const primary = countingModel('claude-primary', [
      new ModelError('429', { status: 429, retryAfterMs: 1 }),
      endTurnEvents('primary recovered'),
    ]);
    const secondary = countingModel('gpt-fallback', [endTurnEvents('should not be used')]);

    const h = agent({
      model: primary.model,
      fallback: [secondary.model],
      retry: { maxRetries: 2, baseDelayMs: 1 },
    });
    const result = await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(result.text, 'primary recovered');
    t.equal(primary.callCount(), 2, 'primary retried once');
    t.equal(secondary.callCount(), 0, 'fallback never used');
  });

  it('throws after all models exhausted', async (t) => {
    const primary = countingModel('claude-a', [new ModelError('API error 429: rate limited', { status: 429, retryAfterMs: 1 })]);
    const fallback = countingModel('gpt-b', [new ModelError('API error 503: unavailable', { status: 503 })]);

    const h = agent({
      model: primary.model,
      fallback: [fallback.model],
      retry: { maxRetries: 0 },
    });
    await t.rejects(
      () => h.generate({ messages: [{ role: 'user', content: 'hi' }] }),
      /503/,
    );
    t.equal(primary.callCount(), 1);
    t.equal(fallback.callCount(), 1);
  });

  it('custom retryOn predicate controls retry behaviour', async (t) => {
    const { model, callCount } = countingModel('gpt-test', [
      new ModelError('custom error', { status: 503 }),
      endTurnEvents('ok'),
    ]);
    const h = agent({
      model,
      retry: {
        maxRetries: 2,
        baseDelayMs: 1,
        retryOn: (err) => err instanceof ModelError && err.status === 503,
      },
    });
    const result = await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(result.text, 'ok');
    t.equal(callCount(), 2, 'custom retryOn accepted 503');
  });

  it('ModelError carries status and retryAfterMs', (t) => {
    const err = new ModelError('rate limited', { status: 429, retryAfterMs: 5000, body: 'too many requests' });
    t.equal(err.status, 429);
    t.equal(err.retryAfterMs, 5000);
    t.equal(err.body, 'too many requests');
    t.equal(err.name, 'ModelError');
    t.ok(err instanceof ModelError);
    t.ok(err instanceof Error);
  });
});
