import { CodeWorkspace } from 'fino:commands/code/workspace';
import { runCodeTui } from 'fino:commands/code/tui';
import { assembleResult } from 'fino:ai/model';
import { createSignal } from 'fino:signals';
import { DiskFileSystem } from 'fino:file';
import type { Model, ModelStream, StreamEvent } from 'fino:ai/model';

function makeStream(events: StreamEvent[]): ModelStream {
  const state = createSignal({
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'end_turn' as const,
  });
  return {
    state,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result() {
      return assembleResult(this[Symbol.asyncIterator]());
    },
  };
}

const model: Model = {
  id: 'harness-model',
  name: 'harness-model',
  provider: 'test',
  stream() {
    return makeStream([
      { type: 'text_delta', index: 0, text: 'harness reply' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'stop', reason: 'end_turn' },
    ]);
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
