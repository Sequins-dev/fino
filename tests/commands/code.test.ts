import { describe, it } from 'fino:test/test';
import { createCodeTools } from 'internal:commands/code/tools';
import { codeSystemPrompt } from 'internal:commands/code/prompt';
import { CodeEngine } from 'internal:commands/code/engine';
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

  it('runs gated tools without suspending in auto mode', async (t) => {
    const dir = tempDir();
    const model = scriptModel([
      toolCallTurn('call_1', 'write_file', JSON.stringify({ path: 'auto.txt', content: 'ok\n' })),
      endTurn('written'),
    ]);
    const engine = await CodeEngine.create({
      cwd: dir,
      chatModel: model,
      sessionDb: false,
      mode: 'auto',
    });
    const result = await engine.runTurn('write it');
    t.equal(result.status, 'done', 'auto mode skips the approval suspension');
    const written = new TextDecoder().decode(await new DiskFileSystem().readFile(`${dir}/auto.txt`));
    t.equal(written, 'ok\n', 'gated tool ran');
    await engine.close();
  });

  it('switches modes between turns while keeping the thread', async (t) => {
    const dir = tempDir();
    const model = scriptModel([endTurn('first'), endTurn('second')]);
    const engine = await CodeEngine.create({
      cwd: dir,
      chatModel: model,
      sessionDb: false,
      mode: 'plan',
    });
    t.equal(engine.planMode, true, 'starts in plan mode');
    const first = await engine.runTurn('plan something');
    t.equal(first.status, 'done', 'plan turn completes');
    engine.setMode('build');
    t.equal(engine.planMode, false, 'build mode restores write tools');
    t.equal(engine.auto, false, 'build mode still asks before gated tools');
    const thread = engine.threadId;
    const second = await engine.runTurn('now do it');
    t.equal(second.status, 'done', 'code turn completes');
    t.equal(engine.threadId, thread, 'thread survives the mode switch');
    await engine.close();
  });

  it('ends a thrown turn in error activity and clears it on the next turn', async (t) => {
    const dir = tempDir();
    const scripted = scriptModel([endTurn('first'), endTurn('recovered')]);
    let turns = 0;
    const model: Model = {
      ...scripted,
      stream(req: GenerateRequest): ModelStream {
        turns++;
        if (turns === 2) throw new Error('provider exploded');
        return scripted.stream(req);
      },
    };
    const activity: string[] = [];
    const engine = await CodeEngine.create({
      cwd: dir,
      chatModel: model,
      sessionDb: false,
      transcriptsDir: false,
      onActivity: (status) => activity.push(status),
    });
    const first = await engine.runTurn('start well');
    t.equal(first.status, 'done', 'the first turn completes');
    t.deepEqual(activity, ['working', 'idle'], 'a good turn still ends idle');

    await t.rejects(() => engine.runTurn('break it'), /provider exploded/, 'the turn throws');
    t.deepEqual(
      activity,
      ['working', 'idle', 'working', 'error'],
      'a thrown turn settles in error',
    );
    t.equal(engine.activity, 'error', 'error state is sticky between turns');

    const third = await engine.runTurn('try again');
    t.equal(third.status, 'done', 'the next turn completes');
    t.deepEqual(
      activity,
      ['working', 'idle', 'working', 'error', 'working', 'idle'],
      'the next turn clears the error and ends idle',
    );
    t.equal(engine.activity, 'idle', 'engine agrees');
    await engine.close();
  });
});
function roleModel(parentTurns: StreamEvent[][], childTurns: StreamEvent[][]): Model {
  let parentIdx = 0;
  let childIdx = 0;
  const requests: { role: 'parent' | 'child'; messages: unknown[] }[] = [];
  const model = {
    id: 'role-mock',
    name: 'role-mock',
    provider: 'test',
    requests,
    stream(req: GenerateRequest): ModelStream {
      const system = typeof req.system === 'string' ? req.system : '';
      const child = system.includes('You are a sub-agent');
      requests.push({ role: child ? 'child' : 'parent', messages: req.messages });
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
  return model as Model & { requests: typeof requests };
}

describe('fino:commands/code — sub-agents', () => {
  it('spawns, waits, reviews, and finalizes within one turn', async (t) => {
    const dir = tempDir();
    const model = roleModel(
      [
        toolCallTurn(
          'p1',
          'subagent_spawn',
          JSON.stringify({ task: 'research the loader', name: 'loader' }),
        ),
        toolCallTurn('p2', 'subagent_wait', '{}'),
        toolCallTurn('p3', 'subagent_finalize', JSON.stringify({ id: 'sa_1' })),
        endTurn('delegated work reviewed and accepted'),
      ],
      [
        toolCallTurn(
          'c1',
          'subagent_complete',
          JSON.stringify({ summary: 'loader research complete' }),
        ),
        endTurn('stopping'),
      ],
    );
    const engine = await CodeEngine.create({ cwd: dir, chatModel: model, sessionDb: false });
    const result = await engine.runTurn('parallelize the research');
    t.equal(result.status, 'done', 'turn completed');
    t.equal(result.text, 'delegated work reviewed and accepted', 'parent saw the review through');
    const states = engine.subagentStates();
    t.equal(states.length, 1, 'one child spawned');
    t.equal(states[0]!.status, 'done', 'child finalized');
    t.equal(states[0]!.doneReport, 'loader research complete', 'done report captured');
    await engine.close();
  });

  it('keeps the turn active and auto-continues when the parent stops early', async (t) => {
    const dir = tempDir();
    const model = roleModel(
      [
        toolCallTurn(
          'p1',
          'subagent_spawn',
          JSON.stringify({ task: 'research kqueue', name: 'kq' }),
        ),
        endTurn('spawned, ending my run early'),
        toolCallTurn('p2', 'subagent_finalize', JSON.stringify({ id: 'sa_1' })),
        endTurn('reviewed after settlement'),
      ],
      [
        toolCallTurn('c1', 'subagent_complete', JSON.stringify({ summary: 'kqueue notes ready' })),
        endTurn('stopping'),
      ],
    );
    const engine = await CodeEngine.create({ cwd: dir, chatModel: model, sessionDb: false });
    const result = await engine.runTurn('go research');
    t.equal(result.status, 'done', 'turn only ends after settlement');
    t.equal(result.text, 'reviewed after settlement', 'settlement continuation ran');
    const parentRequests = (
      model as unknown as { requests: { role: string; messages: ModelMessage[] }[] }
    ).requests.filter((r) => r.role === 'parent');
    const settlement = parentRequests.some((r) =>
      r.messages.some(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('[subagent settlement]'),
      ),
    );
    t.ok(settlement, 'parent received the settlement summary');
    t.equal(engine.subagentStates()[0]!.status, 'done', 'child finalized in continuation');
    await engine.close();
  });

  it('propagates planning mode to children as read-only', async (t) => {
    const dir = tempDir();
    const model = roleModel(
      [
        toolCallTurn(
          'p1',
          'subagent_spawn',
          JSON.stringify({ task: 'survey the docs', name: 'survey' }),
        ),
        toolCallTurn('p2', 'subagent_wait', '{}'),
        toolCallTurn('p3', 'subagent_finalize', JSON.stringify({ id: 'sa_1' })),
        endTurn('plan ready'),
      ],
      [
        toolCallTurn('c1', 'subagent_complete', JSON.stringify({ summary: 'surveyed' })),
        endTurn('bye'),
      ],
    );
    const engine = await CodeEngine.create({
      cwd: dir,
      chatModel: model,
      sessionDb: false,
      mode: 'plan',
    });
    const result = await engine.runTurn('plan the work');
    t.equal(result.status, 'done', 'plan turn completed');
    t.equal(
      engine.subagentStates()[0]!.spec.readOnly,
      true,
      'child inherited read-only from plan mode',
    );
    await engine.close();
  });

  it('queues steering between runs and injects it into the next run', async (t) => {
    const dir = tempDir();
    const model = roleModel([endTurn('first'), endTurn('second')], []);
    const engine = await CodeEngine.create({ cwd: dir, chatModel: model, sessionDb: false });
    await engine.runTurn('first prompt');
    engine.steer('remember: prefer edits over rewrites');
    await engine.runTurn('second prompt');
    const requests = (
      model as unknown as { requests: { role: string; messages: ModelMessage[] }[] }
    ).requests;
    const second = requests[1]!.messages;
    const texts = second
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .map((m) => m.content as string);
    t.ok(texts.includes('remember: prefer edits over rewrites'), 'queued steering prepended');
    const steerIndex = texts.indexOf('remember: prefer edits over rewrites');
    const promptIndex = texts.indexOf('second prompt');
    t.ok(steerIndex < promptIndex, 'steering precedes the new prompt');
    await engine.close();
  });

  it('recovers a suspended approval turn across engine restarts', async (t) => {
    const dir = tempDir();
    await new DiskFileSystem().mkdir(dir);
    const db = `${dir}/sessions.db`;
    const model = roleModel(
      [
        toolCallTurn('p1', 'write_file', JSON.stringify({ path: 'out.txt', content: 'durable\n' })),
        endTurn('written after restart approval'),
      ],
      [],
    );
    const first = await CodeEngine.create({ cwd: dir, chatModel: model, sessionDb: db });
    const initial = await first.runTurn('write the file');
    t.equal(initial.status, 'suspended', 'suspended for approval');
    const threadId = first.threadId;
    await first.close();

    const second = await CodeEngine.create({
      cwd: dir,
      chatModel: model,
      sessionDb: db,
      threadId,
    });
    const recovered = await second.recoverTurn();
    t.equal(recovered?.status, 'suspended', 'approval re-surfaced after restart');
    t.equal(recovered?.approval?.request.toolName, 'write_file', 'same pending tool');
    const finished = await second.approve(recovered!.approval!.token);
    t.equal(finished.status, 'done', 'turn completed after restart approval');
    t.equal(finished.text, 'written after restart approval', 'continuation text');
    const fs = new DiskFileSystem();
    const written = new TextDecoder().decode(await fs.readFile(`${dir}/out.txt`));
    t.equal(written, 'durable\n', 'approved tool executed after restart');
    await second.close();
  });
});
