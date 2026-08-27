import { describe, it } from 'fino:test/test';
import { memoryStore } from 'fino:store';
import { GatewayRateLimitError, gatewayModel, GatewayPolicy, modelFacade } from 'fino:ai/gateway';
import type { GenerateRequest, GenerateResult, Model, ModelStream } from 'fino:ai/model';
import { ImportMap, Realm } from 'fino:realm';
import { ModelStreamImpl } from 'internal:ai/shared';
function modelNamed(name: string, calls: string[]): Model {
  const result: GenerateResult = {
    text: name,
    toolCalls: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
    },
    stopReason: 'end_turn',
  };
  return {
    name,
    dimensions: 0,
    stream(_request: GenerateRequest): ModelStream {
      calls.push(name);
      async function* events() {
        yield {
          type: 'text_delta' as const,
          index: 0,
          text: name,
        };
        yield {
          type: 'usage' as const,
          usage: result.usage,
        };
        yield {
          type: 'stop' as const,
          reason: 'end_turn' as const,
        };
      }
      return new ModelStreamImpl(events());
    },
    async generate() {
      calls.push(name);
      return result;
    },
    async embed() {
      return [];
    },
  };
}
describe('AI gateway policy', () => {
  it('isolates quotas per tenant and returns deterministic retry metadata', async (t) => {
    let now = 1e3;
    const store = memoryStore({ clock: { now: () => now } });
    const policy = new GatewayPolicy({
      store,
      requests: 2,
      windowMs: 100,
      clock: () => now,
    });
    await policy.acquire('tenant-a');
    await policy.acquire('tenant-a');
    let rejected: unknown;
    try {
      await policy.acquire('tenant-a');
    } catch (error) {
      rejected = error;
    }
    t.ok(rejected instanceof GatewayRateLimitError);
    t.equal((rejected as GatewayRateLimitError).retryAfterMs, 100);
    await policy.acquire('tenant-b');
    now = 1101;
    await policy.acquire('tenant-a');
  });
  it('wraps provider calls without putting credentials into child policy state', async (t) => {
    const calls: string[] = [];
    const policy = new GatewayPolicy({
      store: memoryStore(),
      requests: 1,
      windowMs: 1e3,
    });
    const wrapped = gatewayModel(modelNamed('parent-provider', calls), {
      policy,
      key: 'tenant-a',
    });
    await wrapped.generate({
      messages: [
        {
          role: 'user',
          content: 'hi',
        },
      ],
    });
    await t.rejects(
      () =>
        wrapped.generate({
          messages: [
            {
              role: 'user',
              content: 'again',
            },
          ],
        }),
      GatewayRateLimitError,
    );
    t.deepEqual(calls, ['parent-provider']);
  });
  it('resolves the parent model on every facade call for rotation and revocation', async (t) => {
    const calls: string[] = [];
    let active: Model | null = modelNamed('first', calls);
    const facade = modelFacade(() => active, { specifier: 'app:model' });
    const call = async () => {
      const realm = new Realm<() => Promise<string>>({
        entry: new URL('../realm/fixtures/model-facade-call.ts', import.meta.url).pathname,
        overrides: ImportMap.deny([
          {
            pattern: 'internal:runtime/loop',
            directive: 'inherit',
          },
          {
            pattern: 'app:model',
            directive: facade,
          },
        ]),
      });
      try {
        return await realm.call();
      } finally {
        realm.terminate();
      }
    };
    t.equal(await call(), 'first');
    active = modelNamed('rotated', calls);
    t.equal(await call(), 'rotated');
    active = null;
    await t.rejects(() => call(), /revoked/i);
  });
});
