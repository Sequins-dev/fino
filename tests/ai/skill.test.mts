import { describe, it } from 'fino:test/test';
import { skill, skillRegistry } from 'fino:ai/skill';
import { agent } from 'fino:ai/agent';
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
    async generate() { throw new Error('use stream'); },
    async embed() { return []; },
  };
}

function captureSystemModel(): { model: Model; getSystems(): (string | undefined)[] } {
  const systems: (string | undefined)[] = [];
  const model: Model = {
    name: 'capture',
    dimensions: 0,
    stream(req: GenerateRequest): ModelStream {
      systems.push(req.system);
      async function* gen() {
        yield { type: 'text_delta' as const, index: 0, text: 'done' };
        yield { type: 'usage' as const, usage: { inputTokens: 2, outputTokens: 1 } };
        yield { type: 'stop' as const, reason: 'end_turn' as const };
      }
      return new ModelStreamImpl(gen());
    },
    async generate() { throw new Error('use stream'); },
    async embed() { return []; },
  };
  return { model, getSystems: () => systems };
}

function toolCallTurn(id: string, name: string, argsJson: string): StreamEvent[] {
  return [
    { type: 'tool_call_start', index: 0, id, name },
    { type: 'tool_call_delta', index: 0, json: argsJson },
    { type: 'tool_call_end', index: 0 },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
    { type: 'stop', reason: 'tool_use' },
  ];
}

function endTurn(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', index: 0, text },
    { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
    { type: 'stop', reason: 'end_turn' },
  ];
}

describe('SkillRegistry', () => {
  it('manifest() returns name+description only, not full instructions', async (t) => {
    const registry = skillRegistry([
      skill({
        name: 'coding',
        description: 'Helps write code',
        instructions: 'You are a senior software engineer. Follow best practices.',
        tools: {},
      }),
      skill({
        name: 'writing',
        description: 'Helps write content',
        instructions: 'You are a skilled writer.',
        tools: {},
      }),
    ]);

    const manifest = registry.manifest();
    t.equal(manifest.length, 2, 'two skills in manifest');
    t.equal(manifest[0]!.name, 'coding');
    t.equal(manifest[0]!.description, 'Helps write code');
    t.equal(manifest[1]!.name, 'writing');
    t.ok(!('instructions' in manifest[0]!), 'instructions not in manifest entry');
  });

  it('system prompt contains manifest but not full instructions before any load', async (t) => {
    const { model, getSystems } = captureSystemModel();
    const registry = skillRegistry([
      skill({
        name: 'analysis',
        description: 'Deep data analysis',
        instructions: 'SECRET INSTRUCTIONS: Use advanced statistical methods.',
        tools: {},
      }),
    ]);

    const a = agent({
      model,
      instructions: 'You are a helpful assistant.',
      skills: registry,
      stopWhen: (s) => s.stepIndex >= 1,
    });

    await a.generate({ messages: [{ role: 'user', content: 'hello' }] });

    const systems = getSystems();
    t.ok(systems.length > 0, 'system was set');
    const sys = systems[0]!;
    t.ok(sys.includes('Available skills'), 'system contains skill section');
    t.ok(sys.includes('analysis'), 'system contains skill name');
    t.ok(sys.includes('Deep data analysis'), 'system contains skill description');
    t.ok(!sys.includes('SECRET INSTRUCTIONS'), 'full instructions NOT in system before load');
  });

  it('load_skill tool call injects instructions into messages', async (t) => {
    const callLog: string[] = [];
    const codeSkill = skill({
      name: 'coding',
      description: 'Write code',
      instructions: 'Use TypeScript. Prefer functional patterns.',
      tools: {
        run_test: {
          name: 'run_test',
          description: 'Run a test',
          parameters: { type: 'object', properties: { test: { type: 'string' } } },
          invoke: async (args: unknown) => {
            callLog.push((args as { test: string }).test);
            return { content: 'PASS', isError: false };
          },
        } as any,
      },
    });

    const registry = skillRegistry([codeSkill]);

    const turns: StreamEvent[][] = [
      toolCallTurn('ls1', 'load_skill', '{"name":"coding"}'),
      toolCallTurn('rt1', 'run_test', '{"test":"my test"}'),
      endTurn('all done'),
    ];

    const a = agent({
      model: scriptModel(turns),
      skills: registry,
    });

    const result = await a.generate({ messages: [{ role: 'user', content: 'help me code' }] });

    t.equal(result.stopReason, 'end_turn', 'run completed');
    t.ok(callLog.includes('my test'), 'skill-bundled tool was called');

    const messages = result.messages;
    const toolResults = messages.flatMap((m) =>
      m.role === 'user' && Array.isArray(m.content)
        ? (m.content as Array<{ type: string; toolCallId?: string; content?: unknown }>).filter(
            (p) => p.type === 'tool_result' && p.toolCallId === 'ls1',
          )
        : [],
    );
    t.ok(toolResults.length > 0, 'load_skill tool result exists in messages');
    const content = (toolResults[0] as { content: unknown }).content;
    t.ok(typeof content === 'string' && content.includes('TypeScript'), 'instructions appear in tool_result content');
  });

  it('load() resolves resources and appends them to loaded instructions', async (t) => {
    const registry = skillRegistry([
      skill({
        name: 'research',
        description: 'Loads research material',
        instructions: async () => 'Use the research skill.',
        resources: [
          { name: 'brief.md', content: async () => '# Brief\nImportant facts.' },
          { name: 'static.txt', content: 'Static resource.' },
        ],
      }),
    ]);

    const loaded = await registry.load('research');
    t.ok(loaded.instructions.includes('Use the research skill.'), 'base instructions included');
    t.ok(loaded.instructions.includes('## Resources'), 'resource section included');
    t.ok(loaded.instructions.includes('brief.md'), 'async resource name included');
    t.ok(loaded.instructions.includes('Important facts.'), 'async resource content included');
    t.ok(loaded.instructions.includes('static.txt'), 'static resource name included');
    t.ok(loaded.instructions.includes('Static resource.'), 'static resource content included');
  });

  it('resume safety: fresh agent over same messages re-registers skill tools', async (t) => {
    const callLog: string[] = [];
    const mathSkill = skill({
      name: 'math',
      description: 'Math computations',
      instructions: 'Use precise arithmetic.',
      tools: {
        add: {
          name: 'add',
          description: 'Add two numbers',
          parameters: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b'],
          },
          invoke: async (args: unknown) => {
            const { a, b } = args as { a: number; b: number };
            callLog.push(`add(${a},${b})`);
            return { content: String(a + b), isError: false };
          },
        } as any,
      },
    });

    const registry1 = skillRegistry([mathSkill]);

    const turns1: StreamEvent[][] = [
      toolCallTurn('ls1', 'load_skill', '{"name":"math"}'),
      endTurn('loaded math skill'),
    ];

    const agent1 = agent({
      model: scriptModel(turns1),
      skills: registry1,
    });

    const result1 = await agent1.generate({ messages: [{ role: 'user', content: 'load math' }] });
    t.equal(result1.stopReason, 'end_turn', 'first run loaded skill');

    const priorMessages = result1.messages;

    const registry2 = skillRegistry([mathSkill]);
    const turns2: StreamEvent[][] = [
      toolCallTurn('add1', 'add', '{"a":3,"b":4}'),
      endTurn('result is 7'),
    ];

    const agent2 = agent({
      model: scriptModel(turns2),
      skills: registry2,
    });

    const result2 = await agent2.generate({
      messages: [...priorMessages, { role: 'user', content: 'what is 3+4?' }],
    });

    t.equal(result2.stopReason, 'end_turn', 'resumed run completed');
    t.ok(callLog.includes('add(3,4)'), 'skill tool was re-registered from message history and called');
  });

  it('add() and lazy instructions work correctly', async (t) => {
    let instructionsLoaded = false;
    const lazySkill = skill({
      name: 'lazy',
      description: 'Lazy skill',
      instructions: async () => {
        instructionsLoaded = true;
        return 'Lazily loaded instructions here.';
      },
      tools: {},
    });

    const registry = skillRegistry();
    registry.add(lazySkill);

    t.equal(registry.manifest().length, 1, 'skill added');
    t.ok(!instructionsLoaded, 'instructions not loaded yet');

    const loaded = await registry.load('lazy');
    t.ok(instructionsLoaded, 'instructions loaded on demand');
    t.ok(loaded.instructions.includes('Lazily loaded'), 'correct instructions returned');

    const loaded2 = await registry.load('lazy');
    t.ok(loaded2 === loaded, 'second load returns cached result');
  });
});
