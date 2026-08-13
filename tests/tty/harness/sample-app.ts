/**
 * The real `fino code` TUI wired to a scripted model, for PTY-driven tests.
 *
 * Env knobs:
 *   HARNESS_REPLY       markdown the model streams back (default: a sample doc)
 *   HARNESS_CHUNK       characters per streamed delta (default: 24)
 *   HARNESS_DELAY_MS    pause between deltas, to exercise streaming UI
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

function makeStream(): ModelStream {
  const state = createSignal({
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'end_turn' as const,
  });
  const events: StreamEvent[] = [
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

const model: Model = {
  id: 'harness-model',
  name: 'harness-model',
  provider: 'test',
  stream() {
    return makeStream();
  },
  async generate(): Promise<never> {
    throw new Error('use stream');
  },
};

const dir = `/tmp/tui-harness-run-${Date.now().toString(36)}`;
await new DiskFileSystem().mkdir(dir);
const workspace = await CodeWorkspace.open({
  cwd: dir,
  chatModel: model,
  transcriptsDir: false,
});
const engine = await workspace.createSession();
await runCodeTui(workspace, { sessionId: engine.threadId });
