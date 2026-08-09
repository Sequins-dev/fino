import { describe, it } from 'fino:test/test';
import { agent } from 'fino:ai/agent';
import { tool } from 'fino:ai/tool';
import { InMemorySessionStore, SqliteSessionStore } from 'fino:ai/session';
import { SubagentPool, subagentTools } from 'fino:ai/subagents';
import type { SubagentState } from 'fino:ai/subagents';
import { ModelStreamImpl } from 'internal:ai/shared';
import { DiskFileSystem } from 'fino:file';
import type { Model, ModelStream, GenerateRequest, StreamEvent, ModelMessage } from 'fino:ai/model';

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

function scriptModel(
  turns: StreamEvent[][],
  onRequest?: (messages: ModelMessage[]) => void,
): Model {
  let idx = 0;
  return {
    id: 'mock',
    name: 'mock',
    provider: 'test',
    stream(req: GenerateRequest): ModelStream {
      onRequest?.(req.messages);
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

function completeTurn(summary: string): StreamEvent[] {
  return toolCallTurn('call_c', 'subagent_complete', JSON.stringify({ summary }));
}

describe('fino:ai/subagents — SubagentPool', () => {
  it('spawns concurrent children, waits for all, and finalizes', async (t) => {
    const store = new InMemorySessionStore();
    const statuses: string[] = [];
    const pool = new SubagentPool({
      id: 'parent-1',
      store,
      buildAgent: (spec, ctx) => ({
        agent: agent({
          model: scriptModel([completeTurn(`${spec.name} finished`), endTurn('bye')]),
          tools: [ctx.completeTool],
        }),
      }),
      onStatus: (id, s) => statuses.push(`${id}:${s.status}`),
    });
    const a = await pool.spawn({ task: 'research kqueue', name: 'alpha' });
    const b = await pool.spawn({ task: 'research io_uring', name: 'beta' });
    t.ok(a !== b, 'distinct ids');
    t.equal(pool.active, true, 'pool active while children work');
    const settled = await pool.waitForSettled();
    t.equal(settled.length, 2, 'both settled');
    for (const s of settled) {
      t.equal(s.status, 'awaiting_review', 'child parked for review');
      t.equal(s.doneReport, `${s.name} finished`, 'done report captured');
    }
    pool.finalize(a);
    t.equal((pool.status(a) as SubagentState).status, 'done', 'finalized');
    t.equal(pool.active, false, 'pool quiescent');
    t.ok(
      statuses.some((s) => s.endsWith(':awaiting_review')),
      'status observer saw transitions',
    );
  });

  it('steers a working child mid-run and continues an awaiting_review child', async (t) => {
    const store = new InMemorySessionStore();
    const requests: ModelMessage[][] = [];
    let pool: SubagentPool;
    let childId = '';
    const slowTool = tool({
      name: 'slow',
      description: 'Slow work.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        pool.send(childId, 'steer: check the docs first');
        return 'worked';
      },
    });
    pool = new SubagentPool({
      id: 'parent-2',
      store,
      buildAgent: (_spec, ctx) => ({
        agent: agent({
          model: scriptModel(
            [
              toolCallTurn('call_1', 'slow', '{}'),
              endTurn('first run over'),
              endTurn('second run over'),
            ],
            (messages) => requests.push(messages),
          ),
          tools: [slowTool, ctx.completeTool],
        }),
      }),
    });
    childId = await pool.spawn({ task: 'do the thing', name: 'steered' });
    await pool.waitForSettled();
    const second = requests[1]!;
    const texts = second
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .map((m) => m.content as string);
    t.ok(texts.includes('steer: check the docs first'), 'mid-run steering reached the child');

    pool.send(childId, 'one more pass please');
    t.equal((pool.status(childId) as SubagentState).status, 'working', 'send restarts the child');
    await pool.waitForSettled();
    const lastReq = requests[requests.length - 1]!;
    const lastMsg = lastReq[lastReq.length - 1]!;
    t.equal(lastMsg.content, 'one more pass please', 'follow-up became the next user message');
  });

  it('routes child approvals through the pool', async (t) => {
    const store = new InMemorySessionStore();
    const gated = tool({
      name: 'gated',
      description: 'Needs approval.',
      parameters: { type: 'object', properties: {} },
      requiresApproval: true,
      execute: async () => 'gated ran',
    });
    const pool = new SubagentPool({
      id: 'parent-3',
      store,
      buildAgent: (_spec, ctx) => ({
        agent: agent({
          model: scriptModel([
            toolCallTurn('call_g', 'gated', '{}'),
            endTurn('done after approval'),
          ]),
          tools: [gated, ctx.completeTool],
        }),
      }),
    });
    const id = await pool.spawn({ task: 'run gated', name: 'gatling' });
    let state = (await waitForStatus(pool, id, 'awaiting_approval')).state;
    t.equal(state.approval?.request.toolName, 'gated', 'approval request surfaced');
    pool.approve(id);
    await pool.waitForSettled();
    state = pool.status(id) as SubagentState;
    t.equal(state.status, 'awaiting_review', 'child settled after approval');
    t.equal(state.lastText, 'done after approval', 'run continued to completion');
  });

  it('marks failed children and cancels working ones', async (t) => {
    const store = new InMemorySessionStore();
    const failing: Model = {
      id: 'boom',
      name: 'boom',
      provider: 'test',
      stream(): ModelStream {
        async function* gen(): AsyncGenerator<StreamEvent> {
          throw new Error('provider exploded');
        }
        return new ModelStreamImpl(gen());
      },
      async generate(): Promise<never> {
        throw new Error('use stream');
      },
    };
    const pool = new SubagentPool({
      id: 'parent-4',
      store,
      buildAgent: () => ({ agent: agent({ model: failing, retry: { maxRetries: 0 } }) }),
    });
    const id = await pool.spawn({ task: 'explode' });
    const settled = await pool.waitForSettled();
    t.equal(settled[0]!.status, 'failed', 'child failed');
    t.ok(settled[0]!.error?.includes('provider exploded'), 'error recorded');
    t.throws(() => pool.send(id, 'hello?'), /failed/, 'sending to a failed child throws');
  });

  it('exposes parent tools that drive the pool', async (t) => {
    const store = new InMemorySessionStore();
    const pool = new SubagentPool({
      id: 'parent-5',
      store,
      buildAgent: (spec, ctx) => ({
        agent: agent({
          model: scriptModel([completeTurn(`${spec.name ?? 'x'} ok`), endTurn('bye')]),
          tools: [ctx.completeTool],
        }),
      }),
    });
    const tools = subagentTools(pool);
    t.deepEqual(
      tools.map((x) => x.name),
      [
        'subagent_spawn',
        'subagent_status',
        'subagent_send',
        'subagent_wait',
        'subagent_finalize',
        'subagent_cancel',
      ],
      'tool names',
    );
    const byName = new Map(tools.map((x) => [x.name, x]));
    const spawned = JSON.parse(
      String(await byName.get('subagent_spawn')!.run({ task: 'quick job', name: 'q' })),
    ) as { id: string };
    t.ok(spawned.id.startsWith('sa_'), 'spawn returns an id');
    const waited = String(await byName.get('subagent_wait')!.run({}));
    t.ok(waited.includes('awaiting_review'), 'wait reports settled children');
    t.ok(waited.includes('q ok'), 'wait includes done report');
    const finalized = String(await byName.get('subagent_finalize')!.run({ id: spawned.id }));
    t.ok(finalized.includes(spawned.id), 'finalize confirms');
    const status = String(await byName.get('subagent_status')!.run({}));
    t.ok(status.includes('[done]'), 'status reflects finalization');
  });

  it('restores a pool from the store and re-presents suspended approvals', async (t) => {
    const path = `/tmp/fino-subagents-${Date.now().toString(36)}.db`;
    const fs = new DiskFileSystem();
    const gated = tool({
      name: 'gated',
      description: 'Needs approval.',
      parameters: { type: 'object', properties: {} },
      requiresApproval: true,
      execute: async () => 'gated ran',
    });
    const turns: StreamEvent[][] = [toolCallTurn('call_g', 'gated', '{}')];
    const buildAgent = (_spec: unknown, ctx: { completeTool: unknown }) => ({
      agent: agent({
        model: scriptModel(turns),
        tools: [gated, ctx.completeTool as never],
      }),
    });
    try {
      const store = await SqliteSessionStore.open(path);
      const pool = new SubagentPool({ id: 'parent-6', store, buildAgent });
      const id = await pool.spawn({ task: 'durable gated work', name: 'phoenix' });
      await waitForStatus(pool, id, 'awaiting_approval');
      await store.close();

      turns.length = 0;
      turns.push(endTurn('resumed fine'));
      const reopened = await SqliteSessionStore.open(path);
      const restored = await SubagentPool.restore({ id: 'parent-6', store: reopened, buildAgent });
      const state = restored.status(id) as SubagentState;
      t.equal(state.status, 'awaiting_approval', 'suspension survived restart');
      t.equal(state.approval?.request.toolName, 'gated', 'approval request restored');
      t.equal(state.name, 'phoenix', 'spec restored');
      restored.approve(id);
      const settled = await restored.waitForSettled();
      t.equal(settled[0]!.status, 'awaiting_review', 'approved child completed after restore');
      t.equal(settled[0]!.lastText, 'resumed fine', 'continuation ran on the restored session');
      const history = await restored.history(id);
      t.ok(history.length > 0, 'child history readable after restore');
      await reopened.close();
    } finally {
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
});

async function waitForStatus(
  pool: SubagentPool,
  id: string,
  status: string,
): Promise<{ state: SubagentState }> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const state = pool.status(id) as SubagentState;
    if (state.status === status) return { state };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`subagent ${id} never reached ${status}`);
}
