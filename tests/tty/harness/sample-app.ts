/**
 * The real `fino code` TUI wired to a scripted model, for PTY-driven tests.
 *
 * Env knobs:
 *   HARNESS_REPLY       markdown the model streams back (default: a sample doc)
 *   HARNESS_CHUNK       characters per streamed delta (default: 24)
 *   HARNESS_DELAY_MS    pause between deltas, to exercise streaming UI
 *   HARNESS_SUBAGENTS   number of sub-agents the first turn fans out to
 *   HARNESS_APPROVAL    "1" scripts a gated write_file call (approval band)
 *   HARNESS_DIR         reuse a workspace directory, to exercise resume
 *   HARNESS_MODELS      size of a scripted model catalog for the picker
 */
import { CodeWorkspace } from 'fino:commands/code/workspace';
import { runCodeTui } from 'fino:commands/code/tui';
import { assembleResult } from 'fino:ai/model';
import { createSignal } from 'fino:signals';
import { DiskFileSystem } from 'fino:file';
import { env } from 'fino:process';
import type { Model, ModelStream, StreamEvent } from 'fino:ai/model';

const DEFAULT_REPLY = [
  '# Heading',
  '',
  'A paragraph with **bold** text and `inline code` in it.',
  '',
  '```ts',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '```',
  '',
  'Closing prose after the code block.',
].join('\n');

const reply = env.HARNESS_REPLY ?? DEFAULT_REPLY;
const chunkSize = Number(env.HARNESS_CHUNK ?? '24');
const delayMs = Number(env.HARNESS_DELAY_MS ?? '0');

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function makeStream(scripted?: StreamEvent[]): ModelStream {
  const state = createSignal({
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'end_turn' as const,
  });
  const events: StreamEvent[] = scripted ?? [
    ...chunks(reply, Math.max(1, chunkSize)).map(
      (text): StreamEvent => ({ type: 'text_delta', index: 0, text }),
    ),
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'stop', reason: 'end_turn' },
  ];
  async function* iterate(): AsyncGenerator<StreamEvent> {
    for (const event of events) {
      if (delayMs > 0 && event.type === 'text_delta') {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      yield event;
    }
  }
  return {
    state,
    [Symbol.asyncIterator]: iterate,
    result() {
      return assembleResult(iterate());
    },
  };
}

function toolCall(id: string, name: string, args: unknown): StreamEvent[] {
  return [
    { type: 'tool_call_start', index: 0, id, name },
    { type: 'tool_call_delta', index: 0, json: JSON.stringify(args) },
    { type: 'tool_call_end', index: 0 },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
    { type: 'stop', reason: 'tool_use' },
  ];
}

const fanOut = Number(env.HARNESS_SUBAGENTS ?? '0');
const gated = env.HARNESS_APPROVAL === '1';
// The parent spawns N children, waits for them, then answers; each child
// reports a summary and stops. Roles are told apart by the system prompt,
// exactly as the delegation tests do. HARNESS_APPROVAL scripts a gated
// write_file call first, so the approval band can be exercised.
const parentTurns: StreamEvent[][] = [
  ...(gated
    ? [toolCall('pa', 'write_file', { path: 'approved.txt', content: 'harness' })]
    : []),
  ...Array.from({ length: fanOut }, (_, index) =>
    toolCall(`p${index}`, 'subagent_spawn', {
      task: `research part ${index + 1}`,
      name: `worker-${index + 1}`,
    }),
  ),
  ...(fanOut > 0 ? [toolCall('pw', 'subagent_wait', {})] : []),
];
let parentIndex = 0;
let childIndex = 0;

const model: Model = {
  id: 'harness-model',
  name: 'harness-model',
  provider: 'test',
  stream(request) {
    const system = typeof request.system === 'string' ? request.system : '';
    if (system.includes('You are a sub-agent')) {
      const turn = childIndex++;
      return makeStream(
        turn < fanOut
          ? toolCall(`c${turn}`, 'subagent_complete', { summary: `part ${turn + 1} done` })
          : undefined,
      );
    }
    const turn = parentTurns[parentIndex++];
    return makeStream(turn);
  },
  async generate(): Promise<never> {
    throw new Error('use stream');
  },
};

// HARNESS_DIR reuses a workspace across runs so resume can be exercised.
const dir = env.HARNESS_DIR ?? `/tmp/tui-harness-run-${Date.now().toString(36)}`;
try {
  await new DiskFileSystem().mkdir(dir);
} catch (_) {
  // already there on a resumed run
}
const workspace = await CodeWorkspace.open({
  cwd: dir,
  chatModel: model,
  transcriptsDir: false,
});
const engine = (await workspace.openLatest()) ?? (await workspace.createSession());
// A scripted catalog: the harness has no provider credentials, and the model
// picker's layout is the thing under test.
const catalogSize = Number(env.HARNESS_MODELS ?? '0');
if (catalogSize > 0) {
  engine.listModels = async () =>
    Array.from({ length: catalogSize }, (_, index) => ({
      id: `model-${String(index).padStart(2, '0')}`,
      provider: index % 2 === 0 ? 'anthropic' : 'openai',
    }));
}
await runCodeTui(workspace, { sessionId: engine.threadId });
