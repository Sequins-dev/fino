import { describe, it } from 'fino:test/test';
import {
  MessageHistory,
  appendOnlyHistoryStrategy,
  signalHistoryStrategy,
  summarizingHistoryStrategy,
  selectiveSummaryHistoryStrategy,
  estimateTokens,
  PRICING,
  costOf,
  maxTokens,
  maxCost,
} from 'fino:ai/context';
import type { ModelMessage, Usage } from 'fino:ai/model';
import { ModelStreamImpl } from 'internal:ai/shared';
import { agent } from 'fino:ai/agent';
import type { Model, GenerateRequest, StreamEvent } from 'fino:ai/model';
// ── Helpers ────────────────────────────────────────────────────────────────────
function userMsg(text: string): ModelMessage {
  return {
    role: 'user',
    content: text,
  };
}
function assistantMsg(text: string): ModelMessage {
  return {
    role: 'assistant',
    content: text,
  };
}
function endTurnEvents(text: string): StreamEvent[] {
  return [
    {
      type: 'text_delta',
      index: 0,
      text,
    },
    {
      type: 'usage',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    },
    {
      type: 'stop',
      reason: 'end_turn',
    },
  ];
}
function scriptModel(turns: StreamEvent[][]): Model {
  let idx = 0;
  return {
    name: 'mock',
    dimensions: 0,
    stream(_req: GenerateRequest): ReturnType<Model['stream']> {
      const turn = turns[idx % turns.length] ?? [];
      idx++;
      async function* gen() {
        yield* turn;
      }
      return new ModelStreamImpl(gen());
    },
    async generate(_req: GenerateRequest) {
      throw new Error('mock: use stream()');
    },
    async embed() {
      return [];
    },
  };
}
function scriptGenerateModel(responses: string[]): Model {
  let idx = 0;
  return {
    name: 'mock',
    dimensions: 0,
    stream(_req: GenerateRequest): ReturnType<Model['stream']> {
      throw new Error('use generate');
    },
    async generate(_req: GenerateRequest) {
      const text = responses[idx++ % responses.length] ?? '';
      return {
        text,
        toolCalls: [],
        usage: {
          inputTokens: 5,
          outputTokens: 5,
        },
        stopReason: 'end_turn' as const,
      };
    },
    async embed() {
      return [];
    },
  };
}
describe('MessageHistory', () => {
  it('append is immutable and render returns the active sequence', async (t) => {
    const h1 = new MessageHistory();
    const h2 = await h1.append(userMsg('a'));
    const h3 = await h2.append(assistantMsg('b'));
    t.equal(h1.render().length, 0, 'original remains empty');
    t.deepEqual(
      h2.render().map((m) => m.content),
      ['a'],
    );
    t.deepEqual(
      h3.render().map((m) => m.content),
      ['a', 'b'],
    );
  });
  it('edit removes, replaces, inserts, moves, and restores summaries', async (t) => {
    let h = new MessageHistory();
    h = await h.append(userMsg('a'));
    h = await h.append(assistantMsg('b'));
    h = await h.append(userMsg('c'));
    const [a, b, c] = h.refs();
    h = await h.edit([
      {
        op: 'insertAfter',
        id: a!.id,
        entries: [userMsg('after-a')],
      },
      {
        op: 'replace',
        id: b!.id,
        entries: [assistantMsg('b1'), assistantMsg('b2')],
      },
      {
        op: 'move',
        ids: [c!.id],
        before: a!.id,
      },
      {
        op: 'remove',
        id: a!.id,
      },
    ]);
    t.deepEqual(
      h.render().map((m) => m.content),
      ['c', 'after-a', 'b1', 'b2'],
    );
    const sourceIds = h
      .refs()
      .slice(0, 2)
      .map((entry) => entry.id);
    h = await h.edit({
      op: 'summary',
      sourceIds,
      entry: { message: userMsg('[summary]') },
      replace: true,
    });
    t.deepEqual(
      h.render().map((m) => m.content),
      ['[summary]', 'b1', 'b2'],
    );
    t.deepEqual(
      h.restore().map((m) => m.content),
      ['c', 'after-a', 'b1', 'b2'],
    );
  });
  it('fork and withView create independent immutable revisions', async (t) => {
    let h = new MessageHistory();
    h = await h.append(userMsg('base'));
    const forked = await h.fork();
    const changed = await forked.append(assistantMsg('branch'));
    t.deepEqual(
      h.render().map((m) => m.content),
      ['base'],
    );
    t.deepEqual(
      changed.render().map((m) => m.content),
      ['base', 'branch'],
    );
    const baseId = changed.refs()[0]!.id;
    const view = changed.withView([baseId]);
    t.deepEqual(
      view.render().map((m) => m.content),
      ['base'],
    );
  });
  it('toSnapshot() and fromSnapshot() round-trip graph lineage', async (t) => {
    let h = new MessageHistory();
    h = await h.append(userMsg('persisted'));
    h = await h.append(assistantMsg('reply'));
    const baseRevisionId = h.revisionId;
    const forked = await (await h.fork()).append(userMsg('branch'));
    const loaded = MessageHistory.fromSnapshot(forked.toSnapshot());
    t.deepEqual(
      loaded.render().map((m) => m.content),
      ['persisted', 'reply', 'branch'],
    );
    t.deepEqual(
      loaded
        .withView(baseRevisionId)
        .render()
        .map((m) => m.content),
      ['persisted', 'reply'],
    );
  });
  it('changesSince() returns only new graph entries and revisions', async (t) => {
    let h = new MessageHistory();
    h = await h.append(userMsg('base'));
    const baseEntryId = h.refs()[0]!.id;
    const baseRevisionId = h.revisionId;
    h = await h.append(assistantMsg('new'));
    const delta = h.changesSince(baseRevisionId);
    t.equal(delta.base, baseRevisionId, 'delta records its base revision');
    t.equal(delta.revisions.length, 1, 'only the new revision is exported');
    t.deepEqual(
      delta.entries.map((entry) => entry.message.content),
      ['new'],
    );
    t.ok(!delta.entries.some((entry) => entry.id === baseEntryId), 'base entry is not duplicated');
  });
  it('summary source restoration survives snapshot export', async (t) => {
    let h = new MessageHistory();
    h = await h.append(userMsg('a'));
    h = await h.append(assistantMsg('b'));
    const sourceIds = h.refs().map((entry) => entry.id);
    h = await h.edit({
      op: 'summary',
      sourceIds,
      entry: { message: userMsg('[summary]') },
      replace: true,
    });
    const loaded = MessageHistory.fromSnapshot(h.toSnapshot());
    t.deepEqual(
      loaded.render().map((m) => m.content),
      ['[summary]'],
    );
    t.deepEqual(
      loaded.restore().map((m) => m.content),
      ['a', 'b'],
    );
  });
});
// ── estimateTokens ────────────────────────────────────────────────────────────
describe('estimateTokens', () => {
  it('estimates string content as chars/4 rounded up', async (t) => {
    const msgs: ModelMessage[] = [
      {
        role: 'user',
        content: 'abcd',
      },
    ];
    t.equal(estimateTokens(msgs), 1);
  });
  it('handles array content via JSON serialization', async (t) => {
    const msgs: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'hi',
          },
        ],
      },
    ];
    const tokens = estimateTokens(msgs);
    t.ok(tokens > 0, 'non-zero token estimate');
  });
  it('accumulates across multiple messages', async (t) => {
    const msgs: ModelMessage[] = [
      {
        role: 'user',
        content: 'aaaa',
      },
      {
        role: 'assistant',
        content: 'bbbb',
      },
    ];
    t.equal(estimateTokens(msgs), 2);
  });
});
// ── PRICING / costOf ──────────────────────────────────────────────────────────
describe('costOf', () => {
  it('returns 0 for unknown model', async (t) => {
    const usage: Usage = {
      inputTokens: 1e3,
      outputTokens: 500,
    };
    t.equal(costOf(usage, 'unknown-model-xyz'), 0);
  });
  it('computes correct cost for claude-opus-4-8', async (t) => {
    const usage: Usage = {
      inputTokens: 1e6,
      outputTokens: 1e6,
    };
    const cost = costOf(usage, 'claude-opus-4-8');
    t.equal(cost, 30, '5 input + 25 output per million = $30');
  });
  it('includes cache read cost', async (t) => {
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1e6,
    };
    const cost = costOf(usage, 'claude-opus-4-8');
    t.equal(cost, .5, '$0.5 per million cache read');
  });
  it('includes cache write cost', async (t) => {
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1e6,
    };
    const cost = costOf(usage, 'claude-opus-4-8');
    t.equal(cost, 6.25, '$6.25 per million cache write');
  });
  it('PRICING table has all expected models', async (t) => {
    const expected = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
    for (const model of expected) {
      t.ok(PRICING[model] !== undefined, `${model} is priced`);
    }
  });
});
// ── maxTokens / maxCost ───────────────────────────────────────────────────────
describe('maxTokens', () => {
  it('returns false below the limit', async (t) => {
    const cond = maxTokens(100);
    const state = {
      usage: {
        inputTokens: 40,
        outputTokens: 40,
      },
      stepIndex: 0,
      messages: [],
    };
    t.ok(!cond(state as never, { stopReason: 'end_turn' }));
  });
  it('returns true at or above the limit', async (t) => {
    const cond = maxTokens(100);
    const state = {
      usage: {
        inputTokens: 60,
        outputTokens: 40,
      },
      stepIndex: 0,
      messages: [],
    };
    t.ok(cond(state as never, { stopReason: 'end_turn' }));
  });
});
describe('maxCost', () => {
  it('returns false below the budget', async (t) => {
    const cond = maxCost(1);
    const state = {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      cost: .5,
      stepIndex: 0,
      messages: [],
    };
    t.ok(!cond(state as never, { stopReason: 'end_turn' }));
  });
  it('returns true at or above the budget', async (t) => {
    const cond = maxCost(1);
    const state = {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      cost: 1,
      stepIndex: 0,
      messages: [],
    };
    t.ok(cond(state as never, { stopReason: 'end_turn' }));
  });
  it('treats missing cost as 0', async (t) => {
    const cond = maxCost(.5);
    const state = {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      stepIndex: 0,
      messages: [],
    };
    t.ok(!cond(state as never, { stopReason: 'end_turn' }));
  });
});
// ── HistoryStrategy ──────────────────────────────────────────────────────────
describe('HistoryStrategy', () => {
  it('signalHistoryStrategy tracks strategy history replacements', async (t) => {
    const wrapped = signalHistoryStrategy(appendOnlyHistoryStrategy());
    const revisions: number[] = [];
    wrapped.history.subscribe((history) => revisions.push(history.refs().length));
    await wrapped.strategy.onAppend(userMsg('hello'), {});
    t.equal(wrapped.history.get().refs().length, 1, 'history signal retains appended message');
    t.deepEqual(revisions, [1], 'subscriber saw history replacement');
  });
  it('summarizingHistoryStrategy compacts lazily on read', async (t) => {
    const summaryModel = scriptGenerateModel(['lazy summary']);
    const strategy = summarizingHistoryStrategy({
      model: summaryModel,
      triggerTokens: 1,
      keepRecent: 1,
    });
    await strategy.onAppend(userMsg('alpha alpha alpha'), {
      model: summaryModel,
      budgetTokens: 10,
    });
    await strategy.onAppend(assistantMsg('beta beta beta'), {
      model: summaryModel,
      budgetTokens: 10,
    });
    await strategy.onAppend(userMsg('recent'), {
      model: summaryModel,
      budgetTokens: 10,
    });
    const before = strategy.history.revisionId;
    const view = await strategy.onRead({
      model: summaryModel,
      budgetTokens: 10,
    });
    t.ok(
      view.history.revisionId !== before,
      'read hook compacted by assigning a new immutable revision',
    );
    t.deepEqual(
      view.messages.map((m) => m.content),
      ['[Conversation summary]\nlazy summary', 'recent'],
    );
  });
  it('read hooks can select a temporary view without persisting it', async (t) => {
    const base = appendOnlyHistoryStrategy();
    await base.onAppend(userMsg('hidden'), {
      model: scriptGenerateModel([]),
      budgetTokens: 100,
    });
    await base.onAppend(assistantMsg('visible'), {
      model: scriptGenerateModel([]),
      budgetTokens: 100,
    });
    const originalRevision = base.history.revisionId;
    const selected = base.history.render([base.history.refs()[1]!.id]);
    t.deepEqual(
      selected.map((m) => m.content),
      ['visible'],
    );
    t.equal(
      base.history.revisionId,
      originalRevision,
      'temporary render does not persist a new revision',
    );
    t.deepEqual(
      base.history.render().map((m) => m.content),
      ['hidden', 'visible'],
    );
  });
  it('selectiveSummaryHistoryStrategy summarizes an arbitrary selected subset', async (t) => {
    const summaryModel = scriptGenerateModel(['selected subset summary']);
    const strategy = selectiveSummaryHistoryStrategy({
      model: summaryModel,
      summaryPrompt: 'Summarize only selected entries.',
      selector: (history) =>
        history
          .refs()
          .filter((_, i) => i !== 1)
          .map((entry) => entry.id),
    });
    await strategy.onAppend(userMsg('first'), {
      model: summaryModel,
      budgetTokens: 100,
    });
    await strategy.onAppend(assistantMsg('middle'), {
      model: summaryModel,
      budgetTokens: 100,
    });
    await strategy.onAppend(userMsg('last'), {
      model: summaryModel,
      budgetTokens: 100,
    });
    const view = await strategy.onRead({
      model: summaryModel,
      budgetTokens: 100,
    });
    t.deepEqual(
      view.messages.map((m) => m.content),
      ['[Selected history summary]\nselected subset summary', 'middle'],
    );
    t.deepEqual(
      strategy.history.restore().map((m) => m.content),
      ['first', 'last', 'middle'],
    );
  });
  it('strategies can extract partial content and replace active entries', async (t) => {
    const model = scriptGenerateModel([]);
    const strategy = appendOnlyHistoryStrategy();
    await strategy.onAppend(userMsg('public | secret'), {
      model,
      budgetTokens: 100,
    });
    const original = strategy.history.refs()[0]!;
    strategy.history = await strategy.history.edit({
      op: 'split',
      id: original.id,
      entries: [
        {
          message: userMsg('public'),
          meta: { labels: ['retained'] },
        },
        {
          message: userMsg('secret'),
          meta: { labels: ['extracted'] },
        },
      ],
    });
    const extracted = strategy.history
      .refs()
      .find((entry) => entry.meta?.labels?.includes('extracted'))!;
    strategy.history = await strategy.history.edit({
      op: 'remove',
      id: extracted.id,
    });
    t.deepEqual(
      strategy.history.render().map((m) => m.content),
      ['public'],
    );
    t.deepEqual(
      strategy.history.refs().map((entry) => entry.meta?.labels?.[0]),
      ['retained'],
    );
  });
  it('memory emission is owned entirely by the strategy', async (t) => {
    const ingested: {
      text: string;
      metadata?: Record<string, unknown>;
    }[] = [];
    const summaryModel = scriptGenerateModel(['memory summary']);
    const strategy = summarizingHistoryStrategy({
      model: summaryModel,
      triggerTokens: 1,
      keepRecent: 0,
      memoryStore: {
        async ingest(docs) {
          ingested.push(...docs);
        },
      },
    });
    await strategy.onAppend(userMsg('memory source'), {
      model: summaryModel,
      budgetTokens: 10,
    });
    await strategy.onAppend(assistantMsg('memory response'), {
      model: summaryModel,
      budgetTokens: 10,
    });
    await strategy.onRead({
      model: summaryModel,
      budgetTokens: 10,
    });
    t.deepEqual(
      ingested.map((doc) => doc.text),
      ['memory summary'],
    );
    t.equal(ingested[0]!.metadata?.['kind'], 'conversation_summary');
  });
});
// ── Agent integration ────────────────────────────────────────────────────────
describe('Agent integration', () => {
  it('AgentResult.cost is populated when pricing is available', async (t) => {
    const h = agent({
      model: {
        ...scriptModel([endTurnEvents('hi')]),
        name: 'claude-opus-4-8',
      },
      stopWhen: (state) => state.stepIndex >= 1,
    });
    const result = await h.generate({ messages: [userMsg('hello')] });
    t.ok(typeof result.cost === 'number', 'cost is a number');
    t.ok(result.cost! >= 0, 'cost is non-negative');
  });
  it('AgentResult.cost is 0 for unknown model', async (t) => {
    const h = agent({
      model: scriptModel([endTurnEvents('hi')]),
      stopWhen: (state) => state.stepIndex >= 1,
    });
    const result = await h.generate({ messages: [userMsg('hello')] });
    t.equal(result.cost, 0, 'unknown model cost is 0');
  });
  it('maxTokens stop condition halts the loop', async (t) => {
    const { maxTokens: mkMaxTokens } = await import('fino:ai/context');
    const h = agent({
      model: scriptModel([endTurnEvents('step1'), endTurnEvents('step2'), endTurnEvents('step3')]),
      stopWhen: mkMaxTokens(12),
    });
    const result = await h.generate({ messages: [userMsg('go')] });
    t.equal(result.steps.length, 1, 'stopped after 1 step due to token limit');
  });
});
