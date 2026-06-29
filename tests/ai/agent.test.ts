import { describe, it } from 'fino:test/test';
import { agent, streamText } from 'fino:ai/agent';
import { MessageHistory } from 'fino:ai/context';
import type { HistoryStrategy } from 'fino:ai/context';
import { tool } from 'fino:ai/tool';
import { v } from 'fino:validate';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Model, ModelStream, GenerateRequest, StreamEvent } from 'fino:ai/model';
function scriptModel(turns: StreamEvent[][]): Model {
  let idx = 0;
  return {
    name: 'mock-model',
    dimensions: 0,
    stream(_req: GenerateRequest): ModelStream {
      const turn = turns[idx % turns.length] ?? [];
      idx++;
      async function* gen() {
        yield* turn;
      }
      return new ModelStreamImpl(gen());
    },
    async generate(_req: GenerateRequest) {
      throw new Error('use stream');
    },
    async embed() {
      return [];
    }
  };
}
function endTurn(text: string): StreamEvent[] {
  return [
    {
      type: 'text_delta',
      index: 0,
      text
    },
    {
      type: 'usage',
      usage: {
        inputTokens: 5,
        outputTokens: 3
      }
    },
    {
      type: 'stop',
      reason: 'end_turn'
    }
  ];
}
function toolCallTurn(id: string, name: string, argsJson: string): StreamEvent[] {
  return [
    {
      type: 'tool_call_start',
      index: 0,
      id,
      name
    },
    {
      type: 'tool_call_delta',
      index: 0,
      json: argsJson
    },
    {
      type: 'tool_call_end',
      index: 0
    },
    {
      type: 'usage',
      usage: {
        inputTokens: 8,
        outputTokens: 4
      }
    },
    {
      type: 'stop',
      reason: 'tool_use'
    }
  ];
}
describe('Agent', () => {
  it('delegates append and read history decisions to the strategy', async (t) => {
    const appended: string[] = [];
    let requestMessages: import('fino:ai/model').ModelMessage[] = [];
    const model: Model = {
      name: 'spy',
      dimensions: 0,
      stream(req: GenerateRequest): ModelStream {
        requestMessages = req.messages;
        async function* gen() {
          yield {
            type: 'text_delta' as const,
            index: 0,
            text: 'viewed'
          };
          yield {
            type: 'usage' as const,
            usage: {
              inputTokens: 1,
              outputTokens: 1
            }
          };
          yield {
            type: 'stop' as const,
            reason: 'end_turn' as const
          };
        }
        return new ModelStreamImpl(gen());
      },
      async generate() {
        throw new Error('use stream');
      },
      async embed() {
        return [];
      }
    };
    const strategy: HistoryStrategy = {
      history: new MessageHistory(),
      async onAppend(message) {
        appended.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
        this.history = await this.history.append(message);
      },
      async onRead() {
        return {
          history: this.history,
          messages: [{
            role: 'user',
            content: 'temporary view only'
          }]
        };
      }
    };
    const a = agent({
      model,
      history: strategy
    });
    const result = await a.generate('real input');
    t.deepEqual(requestMessages.map((m) => m.content), ['temporary view only']);
    t.ok(appended.includes('real input'), 'inbound user message appended through strategy');
    t.ok(appended.includes('viewed'), 'assistant message appended through strategy');
    t.deepEqual(result.messages.map((m) => m.content), ['real input', 'viewed']);
  });
  it('generate(string) runs the loop and returns text', async (t) => {
    const a = agent({
      model: scriptModel([toolCallTurn('c1', 'greet', '{"name":"Alice"}'), endTurn('Hi Alice!')]),
      tools: [tool<{
        name: string;
      }>({
        name: 'greet',
        description: 'Greets',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        },
        execute: (args) => `hello ${args.name}`
      })]
    });
    const result = await a.generate('say hi');
    t.equal(result.text, 'Hi Alice!');
    t.equal(result.steps.length, 2);
  });
  it('stream().text() yields only text_delta content', async (t) => {
    const a = agent({ model: scriptModel([endTurn('Hello')]) });
    const stream = a.stream('hi');
    t.ok(stream.reader, 'stream exposes a Reader');
    t.ok(stream.result instanceof Promise, 'stream exposes result promise');
    const parts: string[] = [];
    for await (const chunk of streamText(stream)) {
      parts.push(chunk);
    }
    t.equal(parts.join(''), 'Hello');
    const result = await stream.result;
    t.equal(result.text, 'Hello');
  });
  it('stream().result() without iteration completes successfully', async (t) => {
    const a = agent({ model: scriptModel([endTurn('OK')]) });
    const result = await a.stream('hi').result;
    t.equal(result.text, 'OK');
  });
  it('structured output: valid respond call sets result.object', async (t) => {
    const schema = v.object({ value: v.number() });
    const respondTurn: StreamEvent[] = [
      {
        type: 'tool_call_start',
        index: 0,
        id: 'r1',
        name: 'respond'
      },
      {
        type: 'tool_call_delta',
        index: 0,
        json: '{"value":42}'
      },
      {
        type: 'tool_call_end',
        index: 0
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 6,
          outputTokens: 3
        }
      },
      {
        type: 'stop',
        reason: 'tool_use'
      }
    ];
    const a = agent({
      model: scriptModel([respondTurn]),
      output: schema.schema
    });
    const result = await a.generate('give me a number');
    t.deepEqual(result.object, { value: 42 }, 'structured output captured');
  });
  it('structured output: invalid-then-valid uses one repair step', async (t) => {
    const schema = v.object({ value: v.number() });
    const badRespondTurn: StreamEvent[] = [
      {
        type: 'tool_call_start',
        index: 0,
        id: 'r1',
        name: 'respond'
      },
      {
        type: 'tool_call_delta',
        index: 0,
        json: '{"value":"not-a-number"}'
      },
      {
        type: 'tool_call_end',
        index: 0
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 6,
          outputTokens: 3
        }
      },
      {
        type: 'stop',
        reason: 'tool_use'
      }
    ];
    const goodRespondTurn: StreamEvent[] = [
      {
        type: 'tool_call_start',
        index: 0,
        id: 'r2',
        name: 'respond'
      },
      {
        type: 'tool_call_delta',
        index: 0,
        json: '{"value":7}'
      },
      {
        type: 'tool_call_end',
        index: 0
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 8,
          outputTokens: 3
        }
      },
      {
        type: 'stop',
        reason: 'tool_use'
      }
    ];
    const a = agent({
      model: scriptModel([badRespondTurn, goodRespondTurn]),
      output: schema.schema
    });
    const result = await a.generate('give me a number');
    t.deepEqual(result.object, { value: 7 }, 'repair step produced valid output');
    t.equal(result.steps.length, 2, 'two steps: initial + repair');
  });
  it('structured output: permanently invalid throws', async (t) => {
    const schema = v.object({ value: v.number() });
    const badTurn: StreamEvent[] = [
      {
        type: 'tool_call_start',
        index: 0,
        id: 'r1',
        name: 'respond'
      },
      {
        type: 'tool_call_delta',
        index: 0,
        json: '{"value":"bad"}'
      },
      {
        type: 'tool_call_end',
        index: 0
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 6,
          outputTokens: 3
        }
      },
      {
        type: 'stop',
        reason: 'tool_use'
      }
    ];
    const a = agent({
      model: scriptModel([
        badTurn,
        badTurn,
        badTurn
      ]),
      output: schema.schema
    });
    await t.rejects(() => a.generate('give me a number'), /Structured output validation failed/);
  });
  it('asTool() wraps agent as a tool for composition', async (t) => {
    const inner = agent({
      name: 'inner',
      model: scriptModel([endTurn('inner result')])
    });
    const innerTool = inner.asTool({ description: 'Runs the inner agent' });
    t.equal(innerTool.name, 'inner', 'tool name defaults to agent name');
    t.equal(innerTool.description, 'Runs the inner agent');
    const outer = agent({
      model: scriptModel([toolCallTurn('t1', 'inner', '{"task":"do something"}'), endTurn('outer done')]),
      tools: [innerTool]
    });
    const result = await outer.generate('start');
    t.equal(result.text, 'outer done');
    t.equal(result.steps.length, 2, 'outer ran two steps');
  });
});
