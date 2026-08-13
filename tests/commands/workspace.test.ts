import { describe, it } from 'fino:test/test';
import { CodeWorkspace } from 'fino:commands/code/workspace';
import { SessionTranscript, TranscriptWriter } from 'fino:commands/code/transcript';
import { ModelStreamImpl } from 'internal:ai/shared';
import { DiskFileSystem } from 'fino:file';
import type { Model, ModelStream, GenerateRequest, StreamEvent } from 'fino:ai/model';

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

function endTurn(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', index: 0, text },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
    { type: 'stop', reason: 'end_turn' },
  ];
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

let counter = 0;
function tempDir(): string {
  return `/tmp/fino-workspace-test-${Date.now().toString(36)}-${counter++}`;
}

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const fs = new DiskFileSystem();
  const text = new TextDecoder().decode(await fs.readFile(path));
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('fino:commands/code — workspace registry', () => {
  it('registers sessions, derives titles, and lists by recency', async (t) => {
    const dir = tempDir();
    await new DiskFileSystem().mkdir(dir);
    const workspace = await CodeWorkspace.open({
      cwd: dir,
      chatModel: scriptModel([endTurn('hi there')]),
      transcriptsDir: false,
    });
    const first = await workspace.createSession();
    await first.runTurn('investigate the flaky loader test');
    const second = await workspace.createSession();
    await second.runTurn('write release notes');
    const listed = workspace.list();
    t.equal(listed.length, 2, 'two active sessions');
    t.equal(listed[0]!.id, second.threadId, 'most recent first');
    t.equal(listed[1]!.title, 'investigate the flaky loader test', 'title from first prompt');
    await workspace.close();
  });

  it('persists the registry across reopen and supports archive', async (t) => {
    const dir = tempDir();
    await new DiskFileSystem().mkdir(dir);
    const open1 = await CodeWorkspace.open({
      cwd: dir,
      chatModel: scriptModel([endTurn('done')]),
      transcriptsDir: false,
    });
    const engine = await open1.createSession();
    await engine.runTurn('first prompt for the title');
    const id = engine.threadId;
    await open1.archiveSession(id);
    t.equal(open1.list().length, 0, 'no active sessions after archive');
    t.equal(open1.list({ archived: true }).length, 1, 'archived list holds it');
    await open1.close();

    const open2 = await CodeWorkspace.open({
      cwd: dir,
      chatModel: scriptModel([endTurn('done')]),
      transcriptsDir: false,
    });
    const archived = open2.list({ archived: true });
    t.equal(archived[0]?.id, id, 'registry survived reopen');
    t.equal(archived[0]?.title, 'first prompt for the title', 'title survived');
    await open2.archiveSession(id, false);
    t.equal(open2.list()[0]?.id, id, 'unarchived back to active');
    const reopened = await open2.openLatest();
    t.equal(reopened?.threadId, id, 'openLatest returns the session');
    await open2.close();
  });

  it('tracks engine activity transitions', async (t) => {
    const dir = tempDir();
    await new DiskFileSystem().mkdir(dir);
    const workspace = await CodeWorkspace.open({
      cwd: dir,
      chatModel: scriptModel([endTurn('quick')]),
      transcriptsDir: false,
    });
    const engine = await workspace.createSession();
    t.equal(workspace.activity(engine.threadId), 'idle', 'idle before first turn');
    await engine.runTurn('go');
    t.equal(workspace.activity(engine.threadId), 'idle', 'idle after turn completes');
    t.equal(engine.activity, 'idle', 'engine agrees');
    await workspace.close();
  });
});

describe('fino:commands/code — JSONL transcripts', () => {
  it('appends ordered JSONL lines through the writer', async (t) => {
    const dir = tempDir();
    const writer = new TranscriptWriter(`${dir}/deep/nested/log.jsonl`);
    writer.append({ type: 'user', text: 'one' });
    writer.append({ type: 'assistant', text: 'two' });
    await writer.close();
    const lines = await readLines(`${dir}/deep/nested/log.jsonl`);
    t.equal(lines.length, 2, 'two lines');
    t.equal(lines[0]!.type, 'user', 'first line type');
    t.equal(lines[1]!.text, 'two', 'second line text');
    t.ok(typeof lines[0]!.ts === 'number', 'timestamps added');
  });

  it('mirrors a full turn including tool activity and turn end', async (t) => {
    const dir = tempDir();
    await new DiskFileSystem().mkdir(dir);
    const workspace = await CodeWorkspace.open({
      cwd: dir,
      mode: 'auto',
      chatModel: scriptModel([
        toolCallTurn('c1', 'write_file', JSON.stringify({ path: 'x.txt', content: 'hello\n' })),
        endTurn('wrote the file'),
      ]),
    });
    const engine = await workspace.createSession();
    await engine.runTurn('please write x.txt');
    await workspace.close();
    const lines = await readLines(`${dir}/.fino/code/transcripts/${engine.threadId}.jsonl`);
    const types = lines.map((line) => line.type);
    t.deepEqual(
      types,
      ['user', 'tool_start', 'tool_result', 'assistant', 'turn_end'],
      'timeline mirrored in order',
    );
    t.equal(lines[0]!.text, 'please write x.txt', 'user text recorded');
    t.equal(lines[3]!.text, 'wrote the file', 'assistant text folded from deltas');
    t.equal(lines[4]!.status, 'done', 'turn end records the outcome');
    t.ok(
      typeof lines[4]!.durationMs === 'number' && lines[4]!.durationMs >= 0,
      'turn end records how long the turn took',
    );
  });

  it('writes per-child transcripts for sub-agent conversations', async (t) => {
    const dir = tempDir();
    const transcript = new SessionTranscript(`${dir}/transcripts`, 'thread-1');
    transcript.parent().append({ type: 'user', text: 'root' });
    transcript.child('sa_1').append({ type: 'user', text: 'child task' });
    await transcript.close();
    const parent = await readLines(`${dir}/transcripts/thread-1.jsonl`);
    const child = await readLines(`${dir}/transcripts/thread-1/sa_1.jsonl`);
    t.equal(parent[0]!.text, 'root', 'parent file written');
    t.equal(child[0]!.text, 'child task', 'child file written');
  });
});
describe('fino:commands/code — session deletion', () => {
  it('removes the registry entry, thread runs, child runs, and pool state', async (t) => {
    const dir = tempDir();
    await new DiskFileSystem().mkdir(dir);
    const workspace = await CodeWorkspace.open({
      cwd: dir,
      chatModel: scriptModel([endTurn('hello')]),
      transcriptsDir: false,
    });
    const engine = await workspace.createSession();
    await engine.runTurn('a prompt to persist');
    const id = engine.threadId;
    await workspace.store.putMeta(`subagents:${id}`, [{ id: 'sa_1' }]);
    t.ok((await workspace.store.listRuns({ threadId: id })).length > 0, 'runs exist before delete');

    await workspace.deleteSession(id);
    t.equal(workspace.meta(id), undefined, 'registry entry removed');
    t.equal((await workspace.store.listRuns({ threadId: id })).length, 0, 'thread runs deleted');
    t.equal(await workspace.store.getMeta(`subagents:${id}`), null, 'pool state deleted');
    await workspace.close();
  });
});
describe('fino:commands/code — per-session model memory', () => {
  it('persists model choices and restores them when the session reopens', async (t) => {
    const dir = tempDir();
    await new DiskFileSystem().mkdir(dir);
    const { env } = await import('fino:process');
    const hadKey = env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = hadKey ?? 'test-key';
    try {
      const open1 = await CodeWorkspace.open({
        cwd: dir,
        chatModel: scriptModel([endTurn('ok')]),
        transcriptsDir: false,
      });
      const engine = await open1.createSession();
      const id = engine.threadId;
      t.equal(open1.meta(id), undefined, 'an unused session stays out of the registry');
      await engine.runTurn('remember my model');
      t.equal(open1.meta(id)?.title, 'remember my model', 'the first turn registers it');
      await engine.setModel('claude-test-model');
      t.equal(open1.meta(id)?.model, 'claude-test-model', 'model recorded in the registry');
      await open1.close();

      const open2 = await CodeWorkspace.open({
        cwd: dir,
        chatModel: scriptModel([endTurn('ok')]),
        transcriptsDir: false,
      });
      t.equal(open2.meta(id)?.model, 'claude-test-model', 'model survives reopen');
      await open2.close();
    } finally {
      if (hadKey === undefined) delete env.ANTHROPIC_API_KEY;
    }
  });
});
describe('fino:commands/code — resumed session history', () => {
  it('replays the full conversation when a thread is reopened', async (t) => {
    const dir = tempDir();
    await new DiskFileSystem().mkdir(dir);
    const first = await CodeWorkspace.open({
      cwd: dir,
      chatModel: scriptModel([endTurn('the assistant reply')]),
      transcriptsDir: false,
    });
    const engine = await first.createSession();
    const id = engine.threadId;
    await engine.runTurn('the original user prompt');
    await first.close();

    const second = await CodeWorkspace.open({
      cwd: dir,
      chatModel: scriptModel([endTurn('unused')]),
      transcriptsDir: false,
    });
    const reopened = await second.openSession(id);
    const messages = await reopened.history();
    t.equal(messages.length, 2, 'both turns replay from the store');
    t.equal(messages[0]!.role, 'user', 'user message first');
    t.equal(messages[0]!.content, 'the original user prompt', 'prompt preserved');
    t.equal(messages[1]!.role, 'assistant', 'assistant reply second');
    t.equal(messages[1]!.content, 'the assistant reply', 'reply preserved');
    await second.close();
  });

  it('restores per-turn records alongside the conversation', async (t) => {
    const dir = tempDir();
    await new DiskFileSystem().mkdir(dir);
    const first = await CodeWorkspace.open({
      cwd: dir,
      chatModel: scriptModel([endTurn('one'), endTurn('two')]),
      transcriptsDir: false,
    });
    const engine = await first.createSession();
    const id = engine.threadId;
    await engine.runTurn('first prompt');
    await engine.runTurn('second prompt');
    await first.close();

    const second = await CodeWorkspace.open({
      cwd: dir,
      chatModel: scriptModel([endTurn('unused')]),
      transcriptsDir: false,
    });
    const reopened = await second.openSession(id);
    const turns = await reopened.turns();
    t.equal(turns.length, 2, 'both turns recorded in the store');
    t.deepEqual(
      turns.map((turn) => turn.status),
      ['done', 'done'],
      'outcomes preserved',
    );
    t.deepEqual(
      turns.map((turn) => turn.messages),
      [2, 4],
      'each record marks the history length it ended at',
    );
    t.ok(
      turns.every((turn) => typeof turn.durationMs === 'number' && turn.durationMs >= 0),
      'durations preserved',
    );
    await second.close();
  });
});
