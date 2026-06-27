import { describe, it } from 'fino:test/test';
import { maxSteps, SuspendSignal, runContext } from 'fino:ai/runtime';
import type { AgentState } from 'fino:ai/runtime';
import { agent } from 'fino:ai/agent';
import { tool } from 'fino:ai/tool';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Model, ModelStream, GenerateRequest, StreamEvent } from 'fino:ai/model';

function scriptModel(turns: StreamEvent[][]): Model {
  let idx = 0;
  return {
    name: 'mock',
    dimensions: 0,
    stream(_req: GenerateRequest): ModelStream {
      const turn = turns[idx % turns.length] ?? [];
      idx++;
      async function* gen() { yield* turn; }
      return new ModelStreamImpl(gen());
    },
    async generate(_req: GenerateRequest) {
      throw new Error('mock: use stream()');
    },
    async embed() { return []; },
  };
}

function endTurnEvents(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', index: 0, text },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'stop', reason: 'end_turn' },
  ];
}

function toolCallEvents(id: string, name: string, argsJson: string, index = 0): StreamEvent[] {
  return [
    { type: 'tool_call_start', index, id, name },
    { type: 'tool_call_delta', index, json: argsJson },
    { type: 'tool_call_end', index },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'stop', reason: 'tool_use' },
  ];
}

function initialState(extra?: Partial<AgentState>): AgentState {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    stepIndex: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...extra,
  };
}

describe('Agent runtime', () => {
  it('single-turn end_turn returns text result', async (t) => {
    const h = agent({ model: scriptModel([endTurnEvents('Hi there')]) });
    const result = await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(result.text, 'Hi there');
    t.equal(result.stopReason, 'end_turn');
    t.equal(result.steps.length, 1);
    t.equal(result.usage.inputTokens, 10);
    t.equal(result.usage.outputTokens, 5);
  });

  it('two-turn tool loop executes tool and returns final text', async (t) => {
    let receivedArgs: unknown;
    const greet = tool<{ name: string }>({
      name: 'greet',
      description: 'Greet someone',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      execute: (args) => { receivedArgs = args; return `greetResult:${args.name}`; },
    });

    const turns: StreamEvent[][] = [
      toolCallEvents('call_1', 'greet', '{"name":"world"}'),
      endTurnEvents('Hello, world!'),
    ];

    const h = agent({ model: scriptModel(turns), tools: [greet] });
    const result = await h.generate({ messages: [{ role: 'user', content: 'greet' }] });

    t.deepEqual(receivedArgs, { name: 'world' }, 'tool received correct args');
    t.equal(result.text, 'Hello, world!');
    t.equal(result.stopReason, 'end_turn');
    t.equal(result.steps.length, 2, 'two steps ran');
    t.equal(result.steps[1]!.stepIndex, 2, 'final step index is 2');
    t.equal(result.usage.inputTokens, 20, 'usage accumulated across steps');

    const msgs = result.messages;
    const toolResultMsg = msgs.find((m) => m.role === 'user' && Array.isArray(m.content) &&
      m.content.some((p) => p.type === 'tool_result'));
    t.ok(toolResultMsg, 'tool_result appended as user message');
  });

  it('concurrent tools both execute', async (t) => {
    const calls: string[] = [];
    const toolA = tool({
      name: 'a',
      description: 'A',
      parameters: { type: 'object', properties: {} },
      execute: async () => { calls.push('a'); await Promise.resolve(); return 'a-result'; },
    });
    const toolB = tool({
      name: 'b',
      description: 'B',
      parameters: { type: 'object', properties: {} },
      execute: async () => { calls.push('b'); await Promise.resolve(); return 'b-result'; },
    });

    const twoToolTurn: StreamEvent[] = [
      { type: 'tool_call_start', index: 0, id: 'c1', name: 'a' },
      { type: 'tool_call_delta', index: 0, json: '{}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'tool_call_start', index: 1, id: 'c2', name: 'b' },
      { type: 'tool_call_delta', index: 1, json: '{}' },
      { type: 'tool_call_end', index: 1 },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
      { type: 'stop', reason: 'tool_use' },
    ];

    const h = agent({ model: scriptModel([twoToolTurn, endTurnEvents('done')]), tools: [toolA, toolB] });
    await h.generate({ messages: [{ role: 'user', content: 'go' }] });

    t.ok(calls.includes('a'), 'tool a ran');
    t.ok(calls.includes('b'), 'tool b ran');
    t.equal(calls.length, 2, 'exactly two tools ran');
  });

  it('maxSteps(1) stops after one step even if model requests tools', async (t) => {
    const h = agent({
      model: scriptModel([toolCallEvents('c1', 'greet', '{}'), toolCallEvents('c1', 'greet', '{}')]),
      tools: [tool({ name: 'greet', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' })],
      stopWhen: maxSteps(1),
    });
    const result = await h.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(result.steps.length, 1, 'only one step ran');
    t.equal(result.stopReason, 'tool_use');
  });

  it('unknown tool name returns isError tool result and loop continues', async (t) => {
    const turns: StreamEvent[][] = [
      toolCallEvents('c1', 'nonexistent', '{}'),
      endTurnEvents('fallback'),
    ];
    const h = agent({ model: scriptModel(turns) });
    const result = await h.generate({ messages: [{ role: 'user', content: 'go' }] });
    t.equal(result.text, 'fallback');

    const toolResultMsg = result.messages.find((m) =>
      m.role === 'user' && Array.isArray(m.content) &&
      (m.content as Array<{type: string; isError?: boolean}>).some((p) => p.type === 'tool_result' && p.isError)
    );
    t.ok(toolResultMsg, 'isError tool result appended for unknown tool');
  });

  it('stream() forwards events and result() matches generate()', async (t) => {
    const turns: StreamEvent[][] = [
      [
        { type: 'text_delta', index: 0, text: 'He' },
        { type: 'text_delta', index: 0, text: 'llo' },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
        { type: 'stop', reason: 'end_turn' },
      ],
    ];

    const h = agent({ model: scriptModel(turns) });
    const stream = h.stream({ messages: [{ role: 'user', content: 'hi' }] });

    const collected: StreamEvent[] = [];
    for await (const ev of stream.reader) {
      collected.push(ev);
    }

    const result = await stream.result;
    t.equal(result.text, 'Hello');

    const textDeltas = collected.filter((e) => e.type === 'text_delta');
    t.equal(textDeltas.length, 2, 'both text_delta events forwarded');
  });

  it('pre-aborted signal throws immediately', async (t) => {
    const h = agent({ model: scriptModel([endTurnEvents('hi')]) });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await t.rejects(
      () => h.generate({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
      /cancelled/,
    );
  });

  it('SuspendSignal from a tool stops the step with suspend set', async (t) => {
    const suspendingTool = tool({
      name: 'pause',
      description: 'Suspends the run',
      parameters: { type: 'object', properties: {} },
      execute: () => { throw new SuspendSignal('waiting for input', { key: 'val' }); },
    });

    const h = agent({ model: scriptModel([toolCallEvents('c1', 'pause', '{}')]), tools: [suspendingTool] });
    const result = await h.generate({ messages: [{ role: 'user', content: 'go' }] });
    t.equal(result.stopReason, 'tool_use');
    t.equal(result.steps.length, 1, 'one step ran before suspend');
  });

  it('runContext.get() inside a tool returns run metadata', async (t) => {
    let capturedCtx: { runId: string; stepIndex: number } | undefined;
    const ctxTool = tool({
      name: 'check',
      description: 'Checks run context',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        capturedCtx = runContext.get();
        return 'ok';
      },
    });

    const h = agent({ model: scriptModel([toolCallEvents('c1', 'check', '{}'), endTurnEvents('done')]), tools: [ctxTool] });
    await h.generate({ messages: [{ role: 'user', content: 'hi' }] });

    t.ok(capturedCtx, 'run context available inside tool');
    t.ok(typeof capturedCtx?.runId === 'string' && capturedCtx.runId.startsWith('run_'), 'runId is set');
    t.equal(typeof capturedCtx?.stepIndex, 'number', 'stepIndex is a number');
  });
});
