import { describe, it } from 'fino:test/test';
import { createCodeTools } from 'fino:commands/code/tools';
import { codeSystemPrompt } from 'fino:commands/code/prompt';
import { CodeEngine } from 'fino:commands/code/engine';
import { ModelStreamImpl } from 'internal:ai/shared';
import { DiskFileSystem } from 'fino:file';
import type { Model, ModelStream, GenerateRequest, StreamEvent } from 'fino:ai/model';
import type { ToolRunContext } from 'fino:ai/tool';

function scriptModel(turns: StreamEvent[][]): Model {
  let idx = 0;
  return {
    id: 'mock',
    name: 'mock',
    provider: 'test',
    stream(_req: GenerateRequest): ModelStream {
      const turn = turns[Math.min(idx, turns.length - 1)] ?? [];
      idx++;
      async function* gen() {
        yield* turn;
      }
      return new ModelStreamImpl(gen());
    },
    async generate(): Promise<never> {
      throw new Error('use stream');
    },
  };
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

function toolCtx(): ToolRunContext {
  return {
    signal: new AbortController().signal,
    toolCallId: 'call_test',
    step: 0,
    runId: 'run_test',
    messages: [],
    suspend(): never {
      throw new Error('suspend unsupported in this test');
    },
  };
}

let tempCounter = 0;
function tempDir(): string {
  return `/tmp/fino-code-test-${Date.now().toString(36)}-${tempCounter++}`;
}

describe('fino:commands/code — tool set', () => {
  it('includes mutating tools by default and excludes them in read-only mode', (t) => {
    const full = createCodeTools({ cwd: '/tmp' }).map((tool) => tool.name);
    t.deepEqual(full, [
      'docs_search',
      'docs_show',
      'read_doc',
      'list_files',
      'read_file',
      'search_files',
      'write_file',
      'edit_file',
      'shell',
    ]);
    const readOnly = createCodeTools({ cwd: '/tmp', writes: false }).map((tool) => tool.name);
    t.ok(!readOnly.includes('write_file'), 'no write_file in read-only set');
    t.ok(!readOnly.includes('edit_file'), 'no edit_file in read-only set');
    t.ok(!readOnly.includes('shell'), 'no shell in read-only set');
  });

  it('gates mutating tools behind approval unless auto is set', (t) => {
    const gated = createCodeTools({ cwd: '/tmp' });
    const auto = createCodeTools({ cwd: '/tmp', auto: true });
    for (const name of ['write_file', 'edit_file', 'shell']) {
      t.equal(
        gated.find((tool) => tool.name === name)!.requiresApproval,
        true,
        `${name} requires approval by default`,
      );
      t.ok(
        !auto.find((tool) => tool.name === name)!.requiresApproval,
        `${name} skips approval with auto`,
      );
    }
  });

  it('writes, edits, reads, lists, and searches files', async (t) => {
    const dir = tempDir();
    const byName = new Map(createCodeTools({ cwd: dir, auto: true }).map((x) => [x.name, x]));
    const write = await byName
      .get('write_file')!
      .invoke({ path: 'src/a.ts', content: 'export const n = 1;\n' }, toolCtx());
    t.ok(String(write.content).includes('src/a.ts'), 'write reports path');

    const edit = await byName
      .get('edit_file')!
      .invoke({ path: 'src/a.ts', oldText: 'n = 1', newText: 'n = 2' }, toolCtx());
    t.ok(!edit.isError, 'edit succeeds');

    const read = await byName.get('read_file')!.invoke({ path: 'src/a.ts' }, toolCtx());
    t.ok(String(read.content).includes('n = 2'), 'read sees the edit');
    t.ok(String(read.content).includes('    1\t'), 'read numbers lines');

    const list = await byName.get('list_files')!.invoke({ pattern: 'src/**' }, toolCtx());
    t.equal(String(list.content), 'src/a.ts', 'list finds the file');

    const search = await byName
      .get('search_files')!
      .invoke({ pattern: 'const n = \\d' }, toolCtx());
    t.ok(String(search.content).includes('src/a.ts:1:'), 'search reports path:line');
  });

  it('rejects ambiguous edits and missing oldText', async (t) => {
    const dir = tempDir();
    const byName = new Map(createCodeTools({ cwd: dir, auto: true }).map((x) => [x.name, x]));
    await byName.get('write_file')!.invoke({ path: 'b.txt', content: 'x x\n' }, toolCtx());
    const ambiguous = await byName
      .get('edit_file')!
      .invoke({ path: 'b.txt', oldText: 'x', newText: 'y' }, toolCtx());
    t.equal(ambiguous.isError, true, 'ambiguous match is an error');
    const missing = await byName
      .get('edit_file')!
      .invoke({ path: 'b.txt', oldText: 'zzz', newText: 'y' }, toolCtx());
    t.equal(missing.isError, true, 'missing match is an error');
    const all = await byName
      .get('edit_file')!
      .invoke({ path: 'b.txt', oldText: 'x', newText: 'y', replaceAll: true }, toolCtx());
    t.ok(!all.isError, 'replaceAll resolves ambiguity');
  });

  it('runs shell commands and reports failures as tool errors', async (t) => {
    const dir = tempDir();
    const byName = new Map(createCodeTools({ cwd: dir, auto: true }).map((x) => [x.name, x]));
    await byName.get('write_file')!.invoke({ path: 'marker.txt', content: 'here\n' }, toolCtx());
    const ok = await byName.get('shell')!.invoke({ command: 'ls' }, toolCtx());
    t.ok(String(ok.content).includes('marker.txt'), 'shell runs in the project cwd');
    const fail = await byName.get('shell')!.invoke({ command: 'exit 7' }, toolCtx());
    t.equal(fail.isError, true, 'non-zero exit is a tool error');
    t.ok(String(fail.content).includes('exit code: 7'), 'exit code reported');
  });

  it('reports how to build the docs index when none exists', async (t) => {
    const dir = tempDir();
    const byName = new Map(createCodeTools({ cwd: dir }).map((x) => [x.name, x]));
    const fs = new DiskFileSystem();
    await fs.mkdir(dir);
    const { chdir, cwd } = await import('fino:process');
    const previous = cwd();
    chdir(dir);
    try {
      const result = await byName.get('docs_search')!.invoke({ query: 'http server' }, toolCtx());
      t.equal(result.isError, true, 'missing index is an error result');
      t.ok(String(result.content).includes('fino doc build'), 'build hint included');
    } finally {
      chdir(previous);
    }
  });
});

describe('fino:commands/code — system prompt', () => {
  it('describes the platform and the docs-first workflow', (t) => {
    const prompt = codeSystemPrompt({ cwd: '/repo' });
    t.ok(prompt.includes('docs_search'), 'mentions docs_search');
    t.ok(prompt.includes('fino:*'), 'mentions module specifiers');
    t.ok(prompt.includes('#privateField'), 'mentions private-field convention');
    t.ok(prompt.includes('/repo'), 'mentions the project root');
    t.ok(!prompt.includes('Planning mode'), 'no plan addendum by default');
  });

  it('appends the planning addendum in plan mode', (t) => {
    const prompt = codeSystemPrompt({ cwd: '/repo', planMode: true });
    t.ok(prompt.includes('Planning mode'), 'plan addendum present');
    t.ok(prompt.includes('read-only'), 'explains the restricted tool set');
  });
});

describe('fino:commands/code — engine', () => {
  it('streams a turn, suspends on a gated tool, and completes after approval', async (t) => {
    const dir = tempDir();
    const model = scriptModel([
      toolCallTurn(
        'call_1',
        'write_file',
        JSON.stringify({ path: 'out.txt', content: 'agent wrote this\n' }),
      ),
      endTurn('finished writing'),
    ]);
    const engine = await CodeEngine.create({ cwd: dir, chatModel: model, sessionDb: false });
    let streamed = '';
    const events: string[] = [];
    let result = await engine.runTurn('write the file', {
      onEvent: (ev) => {
        events.push(ev.type);
        if (ev.type === 'model_event' && ev.event.type === 'text_delta') streamed += ev.event.text;
      },
    });
    t.equal(result.status, 'suspended', 'gated tool suspends the turn');
    t.equal(result.approval?.request.toolName, 'write_file', 'approval names the tool');
    result = await engine.approve(result.approval!.token);
    t.equal(result.status, 'done', 'run completes after approval');
    t.equal(result.text, 'finished writing', 'final text returned');
    t.equal(streamed, 'finished writing', 'text streamed through onEvent');
    t.ok(events.includes('tool_start'), 'tool events streamed');
    const fs = new DiskFileSystem();
    const written = new TextDecoder().decode(await fs.readFile(`${dir}/out.txt`));
    t.equal(written, 'agent wrote this\n', 'approved tool wrote the file');
    await engine.close();
  });

  it('records a rejection the model can see and continue from', async (t) => {
    const dir = tempDir();
    const model = scriptModel([
      toolCallTurn('call_1', 'shell', JSON.stringify({ command: 'rm -rf /' })),
      endTurn('understood, not running it'),
    ]);
    const engine = await CodeEngine.create({ cwd: dir, chatModel: model, sessionDb: false });
    let result = await engine.runTurn('destroy everything');
    t.equal(result.status, 'suspended', 'shell suspends for approval');
    result = await engine.reject(result.approval!.token, 'too dangerous');
    t.equal(result.status, 'done', 'run continues after rejection');
    t.equal(result.text, 'understood, not running it', 'model saw the rejection');
    await engine.close();
  });

  it('switches modes between turns while keeping the thread', async (t) => {
    const dir = tempDir();
    const model = scriptModel([endTurn('first'), endTurn('second')]);
    const engine = await CodeEngine.create({
      cwd: dir,
      chatModel: model,
      sessionDb: false,
      planMode: true,
    });
    t.equal(engine.planMode, true, 'starts in plan mode');
    const first = await engine.runTurn('plan something');
    t.equal(first.status, 'done', 'plan turn completes');
    engine.setPlanMode(false);
    const thread = engine.threadId;
    const second = await engine.runTurn('now do it');
    t.equal(second.status, 'done', 'code turn completes');
    t.equal(engine.threadId, thread, 'thread survives the mode switch');
    await engine.close();
  });
});
