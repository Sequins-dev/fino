import { describe, it } from 'fino:test/test';
import { agent } from 'fino:ai/agent';
import { Budget, BudgetExceededError } from 'fino:ai/budget';
import { InMemorySessionStore, session } from 'fino:ai/session';
import { tool } from 'fino:ai/tool';
import type { GenerateRequest, Model, ModelStream, StreamEvent } from 'fino:ai/model';
import { ModelStreamImpl } from 'internal:ai/shared';
function usageModel(calls: { count: number }): Model {
  return {
    name: 'budget-test',
    dimensions: 0,
    stream(_request: GenerateRequest): ModelStream {
      calls.count++;
      async function* events(): AsyncGenerator<StreamEvent> {
        yield {
          type: 'text_delta',
          index: 0,
          text: 'ok',
        };
        yield {
          type: 'usage',
          usage: {
            inputTokens: 3,
            outputTokens: 2,
          },
        };
        yield {
          type: 'stop',
          reason: 'end_turn',
        };
      }
      return new ModelStreamImpl(events());
    },
    async generate() {
      throw new Error('use stream');
    },
    async embed() {
      return [];
    },
  };
}
describe('AI budgets', () => {
  it('checks the budget before a model call and records actual usage', async (t) => {
    const calls = { count: 0 };
    const control = new Budget({ tokens: 5 });
    const bot = agent({
      model: usageModel(calls),
      budget: control,
      defaults: { maxTokens: 2 },
    });
    const first = await bot.generate('hi');
    t.equal(first.text, 'ok');
    t.equal(control.snapshot().usedTokens, 5);
    await t.rejects(() => bot.generate('again'), BudgetExceededError);
    t.equal(calls.count, 1, 'exhausted budget blocks before provider invocation');
  });
  it('reserves concurrent capacity atomically and releases provider failures', async (t) => {
    const control = new Budget({ tokens: 10 });
    const first = control.reserve({ tokens: 7 });
    t.throws(() => control.reserve({ tokens: 4 }), BudgetExceededError);
    first.release();
    const second = control.reserve({ tokens: 4 });
    second.commit(
      {
        inputTokens: 2,
        outputTokens: 1,
      },
      .25,
    );
    t.equal(control.snapshot().usedTokens, 3);
    t.equal(control.snapshot().usedUsd, .25);
  });
  it('suspends for approval and resumes from a durable snapshot after a grant', async (t) => {
    const control = new Budget({
      tokens: 4,
      onExhausted: 'suspend',
    });
    let suspended: unknown;
    try {
      control.reserve({ tokens: 5 });
    } catch (error) {
      suspended = error;
    }
    t.equal((suspended as Error).name, 'SuspendSignal');
    const restored = Budget.fromSnapshot(control.snapshot());
    restored.grant(
      { tokens: 6 },
      {
        approvedBy: 'operator@example.com',
        reason: 'finish run',
      },
    );
    const lease = restored.reserve({ tokens: 5 });
    lease.commit(
      {
        inputTokens: 2,
        outputTokens: 3,
      },
      0,
    );
    const snapshot = restored.snapshot();
    t.equal(snapshot.usedTokens, 5);
    t.equal(snapshot.grants.length, 1);
    t.equal(snapshot.grants[0]?.approvedBy, 'operator@example.com');
  });
  it('enforces wall-clock ceilings with an injected deterministic clock', (t) => {
    let now = 100;
    const control = new Budget({
      wallClockMs: 50,
      clock: () => now,
    });
    control.check();
    now = 151;
    t.throws(() => control.check(), BudgetExceededError);
  });
  it('persists suspension, accepts a grant, and resumes without replaying completed tools', async (t) => {
    let modelCalls = 0;
    let toolCalls = 0;
    const model: Model = {
      name: 'budget-session-test',
      dimensions: 0,
      stream(): ModelStream {
        modelCalls++;
        async function* events(): AsyncGenerator<StreamEvent> {
          if (modelCalls === 1) {
            yield {
              type: 'tool_call_start',
              index: 0,
              id: 'call-1',
              name: 'lookup',
            };
            yield {
              type: 'tool_call_delta',
              index: 0,
              json: '{}',
            };
            yield {
              type: 'tool_call_end',
              index: 0,
            };
            yield {
              type: 'usage',
              usage: {
                inputTokens: 3,
                outputTokens: 2,
              },
            };
            yield {
              type: 'stop',
              reason: 'tool_use',
            };
          } else {
            yield {
              type: 'text_delta',
              index: 0,
              text: 'finished',
            };
            yield {
              type: 'usage',
              usage: {
                inputTokens: 2,
                outputTokens: 1,
              },
            };
            yield {
              type: 'stop',
              reason: 'end_turn',
            };
          }
        }
        return new ModelStreamImpl(events());
      },
      async generate() {
        throw new Error('use stream');
      },
      async embed() {
        return [];
      },
    };
    const control = new Budget({
      tokens: 5,
      onExhausted: 'suspend',
    });
    const store = new InMemorySessionStore();
    const durable = session({
      store,
      agent: agent({
        model,
        budget: control,
        defaults: { maxTokens: 2 },
        tools: [
          tool({
            name: 'lookup',
            description: 'Lookup once',
            parameters: {
              type: 'object',
              properties: {},
            },
            execute: () => {
              toolCalls++;
              return 'found';
            },
          }),
        ],
      }),
    });
    const waiting = await durable.start('go');
    t.equal(waiting.status, 'suspended');
    t.equal(modelCalls, 1);
    t.equal(toolCalls, 1);
    control.grant({ tokens: 100 }, { approvedBy: 'operator' });
    const done = await durable.resume(waiting.state.suspendedOn!.token, { approved: true });
    t.equal(done.status, 'done');
    t.equal(done.text, 'finished');
    t.equal(modelCalls, 2);
    t.equal(toolCalls, 1, 'completed tool work was not replayed');
  });
});
