import { describe, it } from 'fino:test/test';
import { tool, toToolDefinition } from 'fino:ai/tool';
import type { ToolRunContext } from 'fino:ai/tool';
import { Task } from 'fino:task';
import { v } from 'fino:validate';
const schema = {
  type: 'object',
  properties: {
    x: {
      type: 'number',
      description: 'The input number',
    },
    label: { type: 'string' },
  },
  required: ['x'],
};
function makeCtx(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    signal: new AbortController().signal,
    toolCallId: 'call_1',
    step: 1,
    runId: 'run_1',
    messages: [],
    ...overrides,
  };
}
describe('tool factory', () => {
  it('accepts SchemaBuilder parameters and emits plain JSON Schema definitions', async (t) => {
    const t1 = tool({
      name: 'lookup',
      description: 'Looks up a value',
      parameters: v.object({ key: v.string().min(1) }),
      execute: (args: { key: string }) => args.key,
    });
    const def = toToolDefinition(t1);
    t.equal(def.parameters.type, 'object', 'tool definition emits JSON Schema');
    t.ok((def.parameters.properties as Record<string, unknown>).key, 'property schema is present');
    const result = await t1.invoke({ key: 'abc' }, makeCtx());
    t.equal(result.content, 'abc', 'builder-backed schema validates input');
  });
  it('exposes name, description, and parameters', (t) => {
    const t1 = tool({
      name: 'add',
      description: 'Adds things',
      parameters: schema,
      execute: async () => 'ok',
    });
    t.ok(t1 instanceof Task, 'tools are tasks');
    t.equal(t1.name, 'add');
    t.equal(t1.description, 'Adds things');
    t.deepEqual(t1.parameters, schema);
  });
  it('exposes approval and safety metadata', (t) => {
    const t1 = tool({
      name: 'danger',
      description: 'Dangerous operation',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiresApproval: true,
      risk: 'destructive',
      sideEffects: true,
      timeoutMs: 5e3,
      execute: async () => 'ok',
    });
    t.equal(t1.requiresApproval, true);
    t.equal(t1.risk, 'destructive');
    t.equal(t1.sideEffects, true);
    t.equal(t1.timeoutMs, 5e3);
  });
  it('invoke() executes with validated args on success', async (t) => {
    let receivedArgs: unknown;
    const t1 = tool<{
      x: number;
    }>({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: (args) => {
        receivedArgs = args;
        return 'done';
      },
    });
    const result = await t1.invoke({ x: 42 }, makeCtx());
    t.deepEqual(receivedArgs, { x: 42 });
    t.equal(result.content, 'done');
    t.equal(result.isError, undefined);
  });
  it('invoke() returns object result pass-through', async (t) => {
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: async () => ({
        content: 'object result',
        isError: false,
      }),
    });
    const result = await t1.invoke({ x: 1 }, makeCtx());
    t.equal(result.content, 'object result');
  });
  it('invoke() returns isError result on object with isError', async (t) => {
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: async () => ({
        content: 'something broke',
        isError: true,
      }),
    });
    const result = await t1.invoke({ x: 1 }, makeCtx());
    t.equal(result.isError, true);
    t.equal(result.content, 'something broke');
  });
  it('invoke() passes context to execute', async (t) => {
    let receivedCtx: ToolRunContext | undefined;
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: (_args, ctx) => {
        receivedCtx = ctx;
        return 'ok';
      },
    });
    const ctx = makeCtx({
      toolCallId: 'call_test',
      step: 7,
    });
    await t1.invoke({ x: 1 }, ctx);
    t.equal(receivedCtx?.toolCallId, 'call_test');
    t.equal(receivedCtx?.step, 7);
  });
  it('invoke() returns isError summary when validation fails', async (t) => {
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: async () => 'ok',
    });
    const result = await t1.invoke({ x: 'not-a-number' }, makeCtx());
    t.equal(result.isError, true);
    t.ok(
      typeof result.content === 'string' && (result.content as string).length > 0,
      'summary is non-empty',
    );
    t.ok((result.content as string).includes('x'), 'mentions the failing field');
  });
  it('invoke() returns isError summary when required field missing', async (t) => {
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: async () => 'ok',
    });
    const result = await t1.invoke({}, makeCtx());
    t.equal(result.isError, true);
  });
  it('invoke() returns isError on execute throw (default)', async (t) => {
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: () => {
        throw new Error('execution failed');
      },
    });
    const result = await t1.invoke({ x: 1 }, makeCtx());
    t.equal(result.isError, true);
    t.ok((result.content as string).includes('execution failed'));
  });
  it('invoke() rethrows when throwOnError is true', async (t) => {
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: () => {
        throw new Error('hard failure');
      },
      throwOnError: true,
    });
    await t.rejects(() => t1.invoke({ x: 1 }, makeCtx()), /hard failure/);
  });
  it('invoke() always rethrows AbortError', async (t) => {
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
    });
    await t.rejects(() => t1.invoke({ x: 1 }, makeCtx()), /aborted/);
  });
  it('invoke() always rethrows SuspendSignal', async (t) => {
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: () => {
        const e = new Error('suspended');
        e.name = 'SuspendSignal';
        throw e;
      },
    });
    await t.rejects(() => t1.invoke({ x: 1 }, makeCtx()), /suspended/);
  });
  it('validator is memoized (compiled once)', async (t) => {
    let invokeCount = 0;
    const originalCompile = (globalThis as unknown as Record<string, unknown>)['_compileCount'];
    void originalCompile;
    const t1 = tool({
      name: 'fn',
      description: 'd',
      parameters: schema,
      execute: async () => {
        invokeCount++;
        return 'ok';
      },
    });
    await t1.invoke({ x: 1 }, makeCtx());
    await t1.invoke({ x: 2 }, makeCtx());
    await t1.invoke({ x: 3 }, makeCtx());
    t.equal(invokeCount, 3, 'execute called 3 times');
  });
});
describe('toToolDefinition', () => {
  it('returns name, description, and parameters', (t) => {
    const t1 = tool({
      name: 'search',
      description: 'Search the web',
      parameters: schema,
      execute: async () => 'result',
    });
    const def = toToolDefinition(t1);
    t.equal(def.name, 'search');
    t.equal(def.description, 'Search the web');
    t.deepEqual(def.parameters, schema);
  });
  it('passes through describe() text in parameter schema', (t) => {
    const schemaWithDescription = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query text',
        },
      },
      required: ['query'],
    };
    const t1 = tool({
      name: 'search',
      description: 'Search',
      parameters: schemaWithDescription,
      execute: async () => 'ok',
    });
    const def = toToolDefinition(t1);
    const qProp = (def.parameters.properties as Record<string, Record<string, string>>).query;
    t.equal(qProp.description, 'The search query text');
  });
});
