import { describe, it } from 'fino:test/test';
import { agent } from 'fino:ai/agent';
import { tool } from 'fino:ai/tool';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Model, ModelStream, GenerateRequest, StreamEvent } from 'fino:ai/model';
import { OtelSDK, InMemoryExporter, BatchSpanProcessor, BatchLogRecordProcessor, TraceTopicInstrumentation, PeriodicExportingMetricReader, Resource } from 'fino:opentelemetry/sdk';
function scriptModel(turns: StreamEvent[][]): Model {
  let idx = 0;
  return {
    id: 'claude-test',
    name: 'claude-test',
    provider: 'anthropic',
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
        inputTokens: 10,
        outputTokens: 5
      }
    },
    {
      type: 'stop',
      reason: 'tool_use'
    }
  ];
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
        inputTokens: 8,
        outputTokens: 4
      }
    },
    {
      type: 'stop',
      reason: 'end_turn'
    }
  ];
}
describe('agent telemetry', () => {
  it('invoke_agent → chat → execute_tool span hierarchy is produced', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 0 })],
      metricReaders: [new PeriodicExportingMetricReader(exporter)],
      instrumentations: [new TraceTopicInstrumentation()],
      resource: new Resource({ 'service.name': 'test' })
    }).start();
    const echo = tool({
      name: 'echo',
      description: 'Echoes input',
      parameters: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: ['msg']
      },
      execute: (args: {
        msg: string;
      }) => args.msg
    });
    const h = agent({
      model: scriptModel([toolCallTurn('c1', 'echo', '{"msg":"hi"}'), endTurn('done')]),
      tools: [echo]
    });
    await h.generate({ messages: [{
      role: 'user',
      content: 'go'
    }] });
    await sdk.flush();
    const spans = exporter.getFinishedSpans();
    const runSpan = spans.find((s) => s.name === 'invoke_agent');
    const stepSpans = spans.filter((s) => s.name === 'chat claude-test');
    const toolSpan = spans.find((s) => s.name === 'execute_tool echo');
    t.ok(runSpan, 'invoke_agent span exists');
    t.ok(stepSpans.length >= 2, 'at least two chat spans');
    t.ok(toolSpan, 'execute_tool span exists');
    t.equal(runSpan!.attributes['gen_ai.operation.name'], 'invoke_agent', 'gen_ai.operation.name=invoke_agent');
    t.equal(runSpan!.attributes['gen_ai.request.model'], 'claude-test', 'gen_ai.request.model');
    t.equal(runSpan!.attributes['gen_ai.provider.name'], 'anthropic', 'gen_ai.provider.name derived from model name');
    for (const step of stepSpans) {
      t.equal(step.parentSpanId, runSpan!.spanId, 'chat parent is invoke_agent');
      t.equal(step.traceId, runSpan!.traceId, 'same trace');
      t.equal(step.attributes['gen_ai.operation.name'], 'chat', 'gen_ai.operation.name=chat');
    }
    t.equal(toolSpan!.parentSpanId, stepSpans[0]!.spanId, 'execute_tool parent is first chat span');
    t.equal(toolSpan!.attributes['gen_ai.tool.name'], 'echo', 'gen_ai.tool.name');
    t.equal(toolSpan!.attributes['gen_ai.tool.call.id'], 'c1', 'gen_ai.tool.call.id');
    t.equal(toolSpan!.attributes['gen_ai.tool.type'], 'function', 'gen_ai.tool.type=function');
    t.equal(toolSpan!.attributes['gen_ai.operation.name'], 'execute_tool', 'gen_ai.operation.name=execute_tool');
    const firstStep = stepSpans[0]!;
    t.equal(firstStep.attributes['gen_ai.usage.input_tokens'], 10, 'gen_ai.usage.input_tokens');
    t.equal(firstStep.attributes['gen_ai.usage.output_tokens'], 5, 'gen_ai.usage.output_tokens');
    await sdk.shutdown();
  });
  it('thrown exception sets error.type to exception class name on execute_tool span', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new TraceTopicInstrumentation()]
    }).start();
    const throwTool = tool({
      name: 'fail',
      description: 'Throws',
      parameters: {
        type: 'object',
        properties: {}
      },
      execute: () => {
        throw new RangeError('out of bounds');
      },
      throwOnError: true
    });
    const h = agent({
      model: scriptModel([toolCallTurn('c2', 'fail', '{}'), endTurn('recovered')]),
      tools: [throwTool]
    });
    try {
      await h.generate({ messages: [{
        role: 'user',
        content: 'go'
      }] });
    } catch {}
    await sdk.flush();
    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === 'execute_tool fail');
    t.ok(toolSpan, 'execute_tool span exists even on throw');
    t.equal(toolSpan!.status?.code, 'ERROR', 'span status is ERROR on throw');
    t.equal(toolSpan!.attributes['error.type'], 'RangeError', 'error.type is the exception class name');
    await sdk.shutdown();
  });
  it('isError tool result yields ERROR status on the execute_tool span', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new TraceTopicInstrumentation()]
    }).start();
    const badTool = tool({
      name: 'bad',
      description: 'Returns isError',
      parameters: {
        type: 'object',
        properties: {}
      },
      execute: () => ({
        content: 'something broke',
        isError: true
      })
    });
    const h = agent({
      model: scriptModel([toolCallTurn('c3', 'bad', '{}'), endTurn('recovered')]),
      tools: [badTool]
    });
    await h.generate({ messages: [{
      role: 'user',
      content: 'go'
    }] });
    await sdk.flush();
    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === 'execute_tool bad');
    t.ok(toolSpan, 'execute_tool span exists');
    t.equal(toolSpan!.status?.code, 'ERROR', 'span status is ERROR for isError result');
    await sdk.shutdown();
  });
  it('gen_ai.client.token.usage and gen_ai.client.operation.duration metrics are recorded', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      metricReaders: [new PeriodicExportingMetricReader(exporter)],
      instrumentations: [new TraceTopicInstrumentation()]
    }).start();
    const h = agent({ model: scriptModel([endTurn('hello')]) });
    await h.generate({ messages: [{
      role: 'user',
      content: 'hi'
    }] });
    await sdk.flush();
    const metrics = exporter.getFinishedMetrics();
    const tokenUsage = metrics.filter((m) => m.name === 'gen_ai.client.token.usage');
    const opDuration = metrics.filter((m) => m.name === 'gen_ai.client.operation.duration');
    t.ok(tokenUsage.length >= 2, 'at least two token usage records (input + output)');
    t.ok(opDuration.length >= 1, 'at least one operation duration record');
    const inputRecord = tokenUsage.find((m) => {
      const attrs = m.attributes as Record<string, unknown>;
      return attrs['gen_ai.token.type'] === 'input';
    });
    const outputRecord = tokenUsage.find((m) => {
      const attrs = m.attributes as Record<string, unknown>;
      return attrs['gen_ai.token.type'] === 'output';
    });
    t.ok(inputRecord, 'input token usage recorded');
    t.ok(outputRecord, 'output token usage recorded');
    if (inputRecord) {
      const attrs = inputRecord.attributes as Record<string, unknown>;
      t.equal(attrs['gen_ai.operation.name'], 'chat', 'token usage has gen_ai.operation.name=chat');
      t.equal(attrs['gen_ai.provider.name'], 'anthropic', 'token usage has gen_ai.provider.name');
    }
    await sdk.shutdown();
  });
  it('gen_ai.client.inference.operation.details log event is emitted per chat step', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new TraceTopicInstrumentation()]
    }).start();
    const h = agent({ model: scriptModel([endTurn('hi')]) });
    await h.generate({ messages: [{
      role: 'user',
      content: 'hello'
    }] });
    await sdk.flush();
    const logs = exporter.getFinishedLogs();
    const detailsLog = logs.find((l) => l.eventName === 'gen_ai.client.inference.operation.details');
    t.ok(detailsLog, 'gen_ai.client.inference.operation.details log event emitted');
    if (detailsLog) {
      const attrs = detailsLog.attributes as Record<string, unknown>;
      t.equal(attrs['gen_ai.operation.name'], 'chat', 'log has gen_ai.operation.name=chat');
      t.equal(attrs['gen_ai.provider.name'], 'anthropic', 'log has gen_ai.provider.name');
      t.equal(attrs['gen_ai.request.model'], 'claude-test', 'log has gen_ai.request.model');
    }
    await sdk.shutdown();
  });
  it('captureContent=false omits message content from log event', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new TraceTopicInstrumentation()]
    }).start();
    const h = agent({
      model: scriptModel([endTurn('hi')]),
      captureContent: false
    });
    await h.generate({ messages: [{
      role: 'user',
      content: 'secret'
    }] });
    await sdk.flush();
    const logs = exporter.getFinishedLogs();
    const detailsLog = logs.find((l) => l.eventName === 'gen_ai.client.inference.operation.details');
    t.ok(detailsLog, 'log event still emitted');
    if (detailsLog) {
      const attrs = detailsLog.attributes as Record<string, unknown>;
      t.equal(attrs['gen_ai.input.messages'], undefined, 'gen_ai.input.messages omitted when captureContent=false');
    }
    await sdk.shutdown();
  });
  it('named agent sets gen_ai.agent.name on invoke_agent span', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new TraceTopicInstrumentation()]
    }).start();
    const h = agent({
      model: scriptModel([endTurn('done')]),
      name: 'my-agent'
    });
    await h.generate({ messages: [{
      role: 'user',
      content: 'go'
    }] });
    await sdk.flush();
    const runSpan = exporter.getFinishedSpans().find((s) => s.name === 'invoke_agent');
    t.ok(runSpan, 'invoke_agent span exists');
    t.equal(runSpan!.attributes['gen_ai.agent.name'], 'my-agent', 'gen_ai.agent.name set from agent name');
    await sdk.shutdown();
  });
});
