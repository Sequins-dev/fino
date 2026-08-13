import { evaluate, llmJudge } from 'fino:ai/eval';
import type { ScoreResult } from 'fino:ai/eval';
import { CodeEngine } from 'fino:commands/code/engine';
import { ModelStreamImpl } from 'internal:ai/shared';
import { env } from 'fino:process';
import { anthropic } from 'fino:ai/model';
import type { Model, ModelStream, GenerateRequest, StreamEvent, ModelMessage } from 'fino:ai/model';

interface DelegationRun {
  parentRequests: ModelMessage[][];
  childChunks: string[];
  summary: string;
  finalText: string;
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
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
    { type: 'stop', reason: 'end_turn' },
  ];
}

let counter = 0;
function tempDir(): string {
  return `/tmp/fino-delegation-eval-${Date.now().toString(36)}-${counter++}`;
}

// A deliberately verbose child: it "reads" large files (distinctive noise
// chunks the parent must never see) and then reports a short summary. The
// parent spawns it, waits, finalizes, and answers. Every parent-bound request
// is captured so scorers can measure exactly what leaked across the boundary.
async function runDelegationScenario(chunkCount: number): Promise<DelegationRun> {
  const childChunks = Array.from(
    { length: chunkCount },
    (_, index) =>
      `NOISE-${index}-${'x'.repeat(512)}-loader internals dump line ${index} with registers and offsets`,
  );
  const summary = 'Loader research done: resolution is registry-based; 3 call sites matter.';
  const finalText = 'Delegated research complete: resolution is registry-based.';
  const parentTurns: StreamEvent[][] = [
    toolCallTurn(
      'p1',
      'subagent_spawn',
      JSON.stringify({ task: 'research the module loader internals', name: 'loader' }),
    ),
    toolCallTurn('p2', 'subagent_wait', '{}'),
    toolCallTurn('p3', 'subagent_finalize', JSON.stringify({ id: 'sa_1' })),
    endTurn(finalText),
  ];
  const childTurns: StreamEvent[][] = [
    ...childChunks.map((chunk, index) =>
      toolCallTurn(`c${index}`, 'read_file', JSON.stringify({ path: `dump-${index}.txt` })),
    ),
    toolCallTurn('cc', 'subagent_complete', JSON.stringify({ summary })),
    endTurn('stopping'),
  ];
  const parentRequests: ModelMessage[][] = [];
  let parentIdx = 0;
  let childIdx = 0;
  const model: Model = {
    id: 'delegation-mock',
    name: 'delegation-mock',
    provider: 'test',
    stream(req: GenerateRequest): ModelStream {
      const system = typeof req.system === 'string' ? req.system : '';
      const child = system.includes('You are a sub-agent');
      if (!child) parentRequests.push(req.messages);
      const turns = child ? childTurns : parentTurns;
      const idx = child ? childIdx++ : parentIdx++;
      const turn = turns[Math.min(idx, turns.length - 1)] ?? [];
      async function* gen() {
        yield* turn;
      }
      return new ModelStreamImpl(gen());
    },
    async generate(): Promise<never> {
      throw new Error('use stream');
    },
  };
  // The child's read_file "tool results" are simulated by intercepting at the
  // tool layer: the real read_file would hit the filesystem, so the child
  // reads real files we create with the noise content.
  const dir = tempDir();
  const { DiskFileSystem } = await import('fino:file');
  const fs = new DiskFileSystem();
  await fs.mkdir(dir);
  const encoder = new TextEncoder();
  for (let index = 0; index < childChunks.length; index++) {
    await fs.writeFile(`${dir}/dump-${index}.txt`, encoder.encode(childChunks[index]! + '\n'));
  }
  const engine = await CodeEngine.create({
    cwd: dir,
    chatModel: model,
    sessionDb: false,
    mode: 'auto',
  });
  const result = await engine.runTurn('research the loader with a sub-agent');
  await engine.close();
  return { parentRequests, childChunks, summary, finalText: result.text ?? '' };
}

function messageText(messages: ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      parts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') parts.push(part.text);
      else if (part.type === 'tool_result') {
        parts.push(typeof part.content === 'string' ? part.content : JSON.stringify(part.content));
      } else if (part.type === 'tool_use') {
        parts.push(JSON.stringify(part.args ?? {}));
      }
    }
  }
  return parts.join('\n');
}

function contextPollution(): (run: DelegationRun) => ScoreResult {
  return (run) => {
    const parentText = run.parentRequests.map(messageText).join('\n');
    const leaked = run.childChunks.filter((chunk) => parentText.includes(chunk.slice(0, 64)));
    const value = run.childChunks.length === 0 ? 1 : 1 - leaked.length / run.childChunks.length;
    return {
      value,
      pass: leaked.length === 0,
      explanation:
        leaked.length === 0
          ? 'no child transcript content reached the parent context'
          : `${leaked.length}/${run.childChunks.length} child transcript chunks leaked into parent requests`,
    };
  };
}

function summaryOnly(): (run: DelegationRun) => ScoreResult {
  return (run) => {
    const parentText = run.parentRequests.map(messageText).join('\n');
    const sawSummary = parentText.includes(run.summary);
    const childBytes = run.childChunks.join('').length;
    const parentBytes = parentText.length;
    const compact = parentBytes < childBytes / 2;
    return {
      value: sawSummary && compact ? 1 : 0,
      pass: sawSummary && compact,
      explanation: `summary visible: ${sawSummary}; parent context ${parentBytes}B vs child work ${childBytes}B`,
    };
  };
}

function turnCompleted(): (run: DelegationRun) => ScoreResult {
  return (run) => ({
    value: run.finalText.length > 0 ? 1 : 0,
    pass: run.finalText.length > 0,
    explanation: run.finalText.length > 0 ? 'parent produced a final answer' : 'no final answer',
  });
}

evaluate({
  name: 'fino code delegation — context isolation',
  target: (input: { chunks: number }) => runDelegationScenario(input.chunks),
  cases: [
    { name: 'modest child transcript (8 reads)', input: { chunks: 8 } },
    { name: 'verbose child transcript (24 reads)', input: { chunks: 24 } },
  ],
  scorers: {
    pollution: contextPollution(),
    summaryOnly: summaryOnly(),
    completed: turnCompleted(),
  },
  threshold: 1,
});

// Live judge evals: real parent model deciding how to delegate. Opt-in — they
// spend tokens and need a key; CI runs stay mechanical-only.
if (env.ANTHROPIC_API_KEY && env.FINO_CODE_LIVE_EVALS) {
  const judge = anthropic({ model: 'claude-haiku-4-5-20251001' });
  evaluate({
    name: 'fino code delegation — live parent behavior',
    target: async (input: { prompt: string }) => {
      const dir = tempDir();
      const { DiskFileSystem } = await import('fino:file');
      await new DiskFileSystem().mkdir(dir);
      const engine = await CodeEngine.create({
        cwd: dir,
        model: 'claude-haiku-4-5-20251001',
        sessionDb: false,
        mode: 'plan',
      });
      const result = await engine.runTurn(input.prompt);
      const spawns = engine
        .subagentStates()
        .map((s) => `task given to ${s.name}: ${s.spec.task}`)
        .join('\n');
      await engine.close();
      return `SPAWNED SUBAGENT TASKS:\n${spawns}\n\nFINAL ANSWER:\n${result.text ?? ''}`;
    },
    cases: [
      {
        name: 'parallel research request',
        input: {
          prompt:
            'Use two sub-agents in parallel: one to research how fino:realm isolation levels work, one for fino:net HTTP serving. Then summarize both.',
        },
      },
    ],
    scorers: {
      selfContainedTasks: llmJudge(
        judge,
        'Score 1 if every spawned subagent task prompt is complete and self-contained (a new agent could act on it without reading any other conversation), else 0.',
      ),
      summarizedAnswer: llmJudge(
        judge,
        'Score 1 if the final answer is a concise synthesis rather than a dump of raw research notes, else 0.',
      ),
    },
    threshold: 1,
  });
}
