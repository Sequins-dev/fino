import { describe, it } from 'fino:test/test';
import { Agent, agent } from 'fino:ai/agent';
import * as ai from 'fino:ai';
import * as runtime from 'fino:ai/runtime';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Model, ModelStream, GenerateRequest, StreamEvent } from 'fino:ai/model';
import type { MemoryDocument, MemoryIngestOptions } from 'fino:ai';
const memoryDocument: MemoryDocument = { text: 'shared dataset document' };
const memoryIngestOptions: MemoryIngestOptions = { batchSize: 8 };
function modelWithText(text: string): Model {
  const events: StreamEvent[] = [
    {
      type: 'text_delta',
      index: 0,
      text,
    },
    {
      type: 'usage',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
      },
    },
    {
      type: 'stop',
      reason: 'end_turn',
    },
  ];
  return {
    id: 'surface-test',
    name: 'surface-test',
    provider: 'test',
    dimensions: 0,
    stream(_req: GenerateRequest): ModelStream {
      async function* gen() {
        yield* events;
      }
      return new ModelStreamImpl(gen());
    },
    async generate() {
      throw new Error('use stream');
    },
    async embed() {
      return [];
    },
  };
}
describe('AI public surface', () => {
  it('root module exports the happy-path AI surface', async (t) => {
    t.equal(memoryDocument.text, 'shared dataset document');
    t.equal(memoryIngestOptions.batchSize, 8);
    t.equal(typeof ai.agent, 'function');
    t.equal(typeof ai.task, 'function');
    t.equal(typeof ai.tool, 'function');
    t.equal(typeof ai.openai, 'function');
    t.equal(typeof ai.anthropic, 'function');
    t.equal(typeof ai.local, 'function');
    t.equal(typeof ai.session, 'function');
    t.equal(typeof ai.memory, 'function');
    t.equal(typeof ai.evaluate, 'function');
    t.equal(typeof ai.streamText, 'function');
    t.equal(typeof ai.mcpClient, 'function');
    t.equal(typeof ai.mcpServer, 'function');
    t.equal(typeof ai.mountMcp, 'function');
  });
  it('runtime exports helpers but not the internal AgentRuntime class', async (t) => {
    t.equal('runContext' in runtime, true, 'runContext remains public');
    t.equal('maxSteps' in runtime, true, 'stop helpers remain public');
    t.equal('GuardrailError' in runtime, true, 'guardrail errors remain public');
    t.equal('AgentRuntime' in runtime, false, 'AgentRuntime is not public API');
  });
  it('legacy harness specifier is not available', async (t) => {
    await t.rejects(
      () => import('fino:ai/harness'),
      /dynamic import failed|Cannot find module|Unable to resolve|not found|unknown/i,
    );
  });
  it('Agent constructor and factory both default to append-only history', async (t) => {
    const direct = new Agent({ model: modelWithText('direct') });
    const viaFactory = agent({ model: modelWithText('factory') });
    t.equal((await direct.generate('hi')).text, 'direct');
    t.equal((await viaFactory.generate('hi')).text, 'factory');
  });
});
