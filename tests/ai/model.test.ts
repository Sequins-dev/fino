import { describe, it } from 'fino:test/test';
import { assembleResult } from 'fino:ai/model';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { StreamEvent } from 'fino:ai/model';
async function* events(...items: StreamEvent[]) {
  for (const item of items) yield item;
}
describe('assembleResult', () => {
  it('assembles plain text from text_delta events', async (t) => {
    const result = await assembleResult(
      events(
        {
          type: 'text_delta',
          index: 0,
          text: 'Hello',
        },
        {
          type: 'text_delta',
          index: 0,
          text: ', world',
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
      ),
    );
    t.equal(result.text, 'Hello, world');
    t.deepEqual(result.toolCalls, []);
    t.equal(result.stopReason, 'end_turn');
    t.equal(result.usage.inputTokens, 10);
    t.equal(result.usage.outputTokens, 5);
  });
  it('concatenates text across multiple indices in order', async (t) => {
    const result = await assembleResult(
      events(
        {
          type: 'text_delta',
          index: 0,
          text: 'first',
        },
        {
          type: 'text_delta',
          index: 1,
          text: 'second',
        },
        {
          type: 'text_delta',
          index: 0,
          text: '-cont',
        },
        {
          type: 'stop',
          reason: 'end_turn',
        },
      ),
    );
    t.equal(result.text, 'first-contsecond');
  });
  it('assembles a single tool call', async (t) => {
    const result = await assembleResult(
      events(
        {
          type: 'tool_call_start',
          index: 0,
          id: 'toolu_1',
          name: 'get_weather',
        },
        {
          type: 'tool_call_delta',
          index: 0,
          json: '{"loc',
        },
        {
          type: 'tool_call_delta',
          index: 0,
          json: 'ation":"NYC"}',
        },
        {
          type: 'tool_call_end',
          index: 0,
        },
        {
          type: 'usage',
          usage: {
            inputTokens: 20,
            outputTokens: 8,
          },
        },
        {
          type: 'stop',
          reason: 'tool_use',
        },
      ),
    );
    t.equal(result.toolCalls.length, 1);
    t.equal(result.toolCalls[0].id, 'toolu_1');
    t.equal(result.toolCalls[0].name, 'get_weather');
    t.deepEqual(result.toolCalls[0].args, { location: 'NYC' });
    t.equal(result.stopReason, 'tool_use');
  });
  it('assembles multiple tool calls in index order', async (t) => {
    const result = await assembleResult(
      events(
        {
          type: 'tool_call_start',
          index: 1,
          id: 'toolu_b',
          name: 'tool_b',
        },
        {
          type: 'tool_call_start',
          index: 0,
          id: 'toolu_a',
          name: 'tool_a',
        },
        {
          type: 'tool_call_delta',
          index: 0,
          json: '{"x":1}',
        },
        {
          type: 'tool_call_delta',
          index: 1,
          json: '{"y":2}',
        },
        {
          type: 'tool_call_end',
          index: 0,
        },
        {
          type: 'tool_call_end',
          index: 1,
        },
        {
          type: 'stop',
          reason: 'tool_use',
        },
      ),
    );
    t.equal(result.toolCalls.length, 2);
    t.equal(result.toolCalls[0].name, 'tool_a');
    t.equal(result.toolCalls[1].name, 'tool_b');
    t.deepEqual(result.toolCalls[0].args, { x: 1 });
    t.deepEqual(result.toolCalls[1].args, { y: 2 });
  });
  it('handles malformed tool args JSON gracefully', async (t) => {
    const result = await assembleResult(
      events(
        {
          type: 'tool_call_start',
          index: 0,
          id: 'id',
          name: 'fn',
        },
        {
          type: 'tool_call_delta',
          index: 0,
          json: '{bad json',
        },
        {
          type: 'tool_call_end',
          index: 0,
        },
        {
          type: 'stop',
          reason: 'end_turn',
        },
      ),
    );
    t.deepEqual(result.toolCalls[0].args, {});
  });
  it('accumulates cache usage fields when present', async (t) => {
    const result = await assembleResult(
      events(
        {
          type: 'usage',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 80,
            cacheCreationInputTokens: 20,
            localCacheReadInputTokens: 100,
            localCacheReadOutputTokens: 50,
          },
        },
        {
          type: 'stop',
          reason: 'end_turn',
        },
      ),
    );
    t.equal(result.usage.cacheReadInputTokens, 80);
    t.equal(result.usage.cacheCreationInputTokens, 20);
    t.equal(result.usage.localCacheReadInputTokens, 100);
    t.equal(result.usage.localCacheReadOutputTokens, 50);
  });
  it('omits cache usage fields when absent', async (t) => {
    const result = await assembleResult(
      events(
        {
          type: 'usage',
          usage: {
            inputTokens: 5,
            outputTokens: 3,
          },
        },
        {
          type: 'stop',
          reason: 'end_turn',
        },
      ),
    );
    t.equal('cacheReadInputTokens' in result.usage, false);
    t.equal('cacheCreationInputTokens' in result.usage, false);
    t.equal('localCacheReadInputTokens' in result.usage, false);
    t.equal('localCacheReadOutputTokens' in result.usage, false);
  });
  it('maps each StopReason variant through unmodified', async (t) => {
    const reasons = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'] as const;
    for (const reason of reasons) {
      const result = await assembleResult(
        events({
          type: 'stop',
          reason,
        }),
      );
      t.equal(result.stopReason, reason, `stopReason ${reason}`);
    }
  });
  it('throws on error event', async (t) => {
    await t.rejects(
      () =>
        assembleResult(
          events({
            type: 'error',
            message: 'upstream failed',
          }),
        ),
      /upstream failed/,
    );
  });
  it('returns defaults when stream is empty', async (t) => {
    const result = await assembleResult(events());
    t.equal(result.text, '');
    t.deepEqual(result.toolCalls, []);
    t.equal(result.stopReason, 'end_turn');
    t.equal(result.usage.inputTokens, 0);
    t.equal(result.usage.outputTokens, 0);
  });
});

describe('ModelStream.state', () => {
  it('folds streamed model events while result consumes the stream', async (t) => {
    const stream = new ModelStreamImpl(
      events(
        {
          type: 'text_delta',
          index: 0,
          text: 'Hel',
        },
        {
          type: 'text_delta',
          index: 0,
          text: 'lo',
        },
        {
          type: 'usage',
          usage: {
            inputTokens: 2,
            outputTokens: 1,
          },
        },
        {
          type: 'stop',
          reason: 'end_turn',
        },
      ),
    );
    const seen: string[] = [];
    stream.state.subscribe((state) => seen.push(`${state.text}:${state.stopReason}`));
    const result = await stream.result();
    t.equal(result.text, 'Hello', 'result still assembles the stream');
    t.equal(stream.state.get().text, 'Hello', 'state retains final text');
    t.equal(stream.state.get().usage.inputTokens, 2, 'state retains usage');
    t.equal(stream.state.get().stopReason, 'end_turn', 'state retains stop reason');
    t.ok(seen.includes('Hello:end_turn'), 'subscriber saw final folded state');
  });
});
