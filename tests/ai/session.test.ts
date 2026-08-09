import { describe, it } from 'fino:test/test';
import { InMemorySessionStore, Session, SqliteSessionStore, session } from 'fino:ai/session';
import type { RunState } from 'fino:ai/session';
import { agent } from 'fino:ai/agent';
import { tool } from 'fino:ai/tool';
import { SuspendSignal } from 'fino:ai/runtime';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Model, ModelStream, GenerateRequest, StreamEvent, ModelMessage } from 'fino:ai/model';
import type { Memory, MemoryMessage, MemoryQuery, RecalledContext } from 'fino:ai/memory';
import { DiskFileSystem } from 'fino:file';
import { MessageHistory } from 'fino:ai/context';
import type { HistoryStrategy } from 'fino:ai/context';
function scriptModel(turns: StreamEvent[][]): Model {
  let idx = 0;
  return {
    id: 'mock',
    name: 'mock',
    provider: 'test',
    dimensions: 0,
    stream(_req: GenerateRequest): ModelStream {
      const turn = turns[idx % turns.length] ?? [];
      idx++;
      async function* gen() {
        yield* turn;
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
function captureModel(): {
  model: Model;
  getLastMessages(): ModelMessage[];
} {
  let last: ModelMessage[] = [];
  const model: Model = {
    id: 'capture',
    name: 'capture',
    provider: 'test',
    dimensions: 0,
    stream(req: GenerateRequest): ModelStream {
      last = req.messages;
      async function* gen() {
        yield {
          type: 'text_delta' as const,
          index: 0,
          text: 'captured response',
        };
        yield {
          type: 'usage' as const,
          usage: {
            inputTokens: 3,
            outputTokens: 2,
          },
        };
        yield {
          type: 'stop' as const,
          reason: 'end_turn' as const,
        };
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
  return {
    model,
    getLastMessages: () => last,
  };
}
function endTurn(text: string): StreamEvent[] {
  return [
    {
      type: 'text_delta',
      index: 0,
      text,
    },
    {
      type: 'usage',
      usage: {
        inputTokens: 5,
        outputTokens: 3,
      },
    },
    {
      type: 'stop',
      reason: 'end_turn',
    },
  ];
}
function toolCallTurn(id: string, name: string, argsJson: string): StreamEvent[] {
  return [
    {
      type: 'tool_call_start',
      index: 0,
      id,
      name,
    },
    {
      type: 'tool_call_delta',
      index: 0,
      json: argsJson,
    },
    {
      type: 'tool_call_end',
      index: 0,
    },
    {
      type: 'usage',
      usage: {
        inputTokens: 8,
        outputTokens: 4,
      },
    },
    {
      type: 'stop',
      reason: 'tool_use',
    },
  ];
}
function tmpPath(): string {
  return `/tmp/fino-session-test-${Math.floor(Math.random() * 1e9)}.db`;
}
async function assertRevisionOnlyCheckpoint(
  t: {
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
  },
  store: SqliteSessionStore,
  state: RunState,
): Promise<void> {
  t.ok(state.historyRevisionId, 'checkpoint stores a history revision id');
  t.equal('messages' in state, false, 'checkpoint does not duplicate messages');
  t.equal('historyJSON' in state, false, 'checkpoint does not store legacy history JSON');
  const loadedHistory = await store.loadHistory(state.historyRevisionId!);
  t.ok(loadedHistory, 'history revision reloads from store');
  t.ok(loadedHistory!.render().length > 0, 'history revision contains messages');
}
describe('Session', () => {
  it('memory recall receives input text and hydrates working/recalled context into the model request', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      let recalledQuery: MemoryQuery | undefined;
      const appended: Array<{
        role: ModelMessage['role'];
        content: ModelMessage['content'];
      }> = [];
      const mem: Memory = {
        threadId: 'memory-thread',
        semanticAvailable: true,
        async append(msg) {
          appended.push({
            role: msg.role,
            content: msg.content,
          });
          return {
            id: `m${appended.length}`,
            threadId: 'memory-thread',
            role: msg.role,
            content: msg.content,
            createdAt: Date.now(),
          };
        },
        async history(): Promise<MemoryMessage[]> {
          return [];
        },
        async recall(query: MemoryQuery = {}): Promise<RecalledContext> {
          recalledQuery = query;
          return {
            messages: [
              {
                id: 'old',
                threadId: 'memory-thread',
                role: 'user',
                content: 'prior fact',
                createdAt: 1,
              },
            ],
            recalled: [
              {
                text: 'semantic hit',
                score: .9,
                metadata: { source: 'fixture' },
              },
            ],
            workingMemory: { account: 'active' },
          };
        },
        async ingest() {},
        async getWorkingMemory() {
          return { account: 'active' };
        },
        async setWorkingMemory() {},
        thread() {
          return this;
        },
        async close() {},
        async [Symbol.asyncDispose]() {},
      };
      const cap = captureModel();
      const sess = session({
        store,
        agent: agent({ model: cap.model }),
        memory: mem,
      });
      const result = await sess.start('new question about account');
      t.equal(result.status, 'done', 'session completed');
      t.equal(recalledQuery?.text, 'new question about account', 'recall query uses input text');
      const joined = cap
        .getLastMessages()
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
      t.ok(joined.includes('prior fact'), 'durable history is included');
      t.ok(joined.includes('semantic hit'), 'semantic recall is included');
      t.ok(joined.includes('account'), 'working memory is included');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('happy path: start() drives a tool loop to done and checkpoints', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      const callLog: string[] = [];
      const greet = tool({
        name: 'greet',
        description: 'Greet',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        execute: (args: { name: string }) => {
          callLog.push(args.name);
          return `Hello ${args.name}!`;
        },
      });
      const a = agent({
        model: scriptModel([toolCallTurn('c1', 'greet', '{"name":"Alice"}'), endTurn('done')]),
        tools: [greet],
      });
      const checkpoints: RunState[] = [];
      const sess = session({
        store,
        agent: a,
        onCheckpoint: (s) => checkpoints.push(s),
      });
      const result = await sess.start('go');
      t.equal(result.status, 'done', 'run completed');
      t.equal(result.text, 'done', 'text extracted from final assistant message');
      t.ok(callLog.includes('Alice'), 'tool was called');
      t.ok(checkpoints.length >= 2, 'checkpointed after each step');
      const loaded = await store.loadRun(result.runId);
      t.equal(loaded?.status, 'done', 'final checkpoint in store');
      t.equal(loaded?.stepIndex, 2, 'two steps completed');
      await assertRevisionOnlyCheckpoint(t, store, loaded!);
      const runs = await store.listRuns({ threadId: sess.state!.threadId });
      t.equal(runs.length, 1, 'one run for this thread');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('watch() exposes the current run state and terminal updates', async (t) => {
    const store = new InMemorySessionStore();
    const a = agent({
      model: scriptModel([endTurn('watched')]),
    });
    const sess = session({ store, agent: a });
    const states: string[] = [];
    const watched = sess.watch();
    watched.subscribe((state) => {
      if (state) states.push(`${state.status}:${state.stepIndex}`);
    });
    const result = await sess.start('go');
    t.equal(result.status, 'done', 'run completed');
    t.equal(watched.get()?.status, 'done', 'watch retains terminal state');
    t.equal(watched.get()?.result, 'watched', 'watch retains result');
    t.ok(states.includes('running:0'), 'subscriber saw initial running state');
    t.ok(states.includes('done:1'), 'subscriber saw terminal state');
  });
  it('crash/restart resume: re-drives from persisted mid-run state', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      const toolCallsDuringResume: string[] = [];
      const echoTool = tool({
        name: 'echo',
        description: 'Echo',
        parameters: {
          type: 'object',
          properties: { msg: { type: 'string' } },
        },
        execute: (args: { msg: string }) => {
          toolCallsDuringResume.push(args.msg);
          return args.msg;
        },
      });
      const crashedState: RunState = {
        runId: 'crash-test',
        threadId: 'crash-thread',
        status: 'running',
        stepIndex: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
        scratch: {},
      };
      let crashedHistory = new MessageHistory();
      crashedHistory = await crashedHistory.append({
        role: 'user',
        content: 'start',
      });
      crashedHistory = await crashedHistory.append({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'c1',
            name: 'echo',
            args: { msg: 'hi' },
          },
        ],
      });
      crashedHistory = await crashedHistory.append({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c1',
            content: 'hi',
          },
        ],
      });
      crashedState.historyRevisionId = crashedHistory.revisionId;
      await store.commitSession({
        run: crashedState,
        thread: {
          threadId: crashedState.threadId,
          historyRevisionId: crashedHistory.revisionId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        history: crashedHistory,
      });
      const resumeAgent = agent({
        model: scriptModel([endTurn('resumed!')]),
        tools: [echoTool],
      });
      const result = await Session.resume({
        store,
        agent: resumeAgent,
        runId: 'crash-test',
      });
      t.equal(result.status, 'done', 'resumed to done');
      t.equal(result.text, 'resumed!', 'correct final text');
      t.equal(toolCallsDuringResume.length, 0, 'tool was NOT re-executed during resume');
      const final = await store.loadRun('crash-test');
      t.equal(final?.status, 'done');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('cross-run conversation continuation: new session on same threadId restores messages', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      const threadId = 'convo-thread';
      const sess1 = session({
        store,
        agent: agent({ model: scriptModel([endTurn('first reply')]) }),
        threadId,
      });
      const r1 = await sess1.start('first message');
      t.equal(r1.status, 'done');
      t.equal(r1.text, 'first reply');
      const { model: spy, getLastMessages } = captureModel();
      const sess2 = session({
        store,
        agent: agent({ model: spy }),
        threadId,
      });
      const r1Final = await store.loadRun(r1.runId);
      t.ok(r1Final, 'first run is persisted');
      const r2 = await sess2.start('follow up');
      t.equal(r2.status, 'done');
      const seen = getLastMessages();
      const roles = seen.map((m: ModelMessage) => m.role);
      t.ok(roles.length >= 3, 'model sees prior conversation + new message');
      t.equal(roles[roles.length - 1], 'user', 'last message is the new user turn');
      const firstContent = seen[0].content;
      const contents = seen.map((m: ModelMessage) => {
        return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      });
      t.ok(
        contents.some((c: string) => c.includes('first message') || c.includes('first reply')),
        'prior conversation appears in context',
      );
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('human-in-the-loop: suspend returns token; resume continues; token is single-use', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      const waitForHuman = tool({
        name: 'await_approval',
        description: 'Awaits human approval',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: () => {
          throw new SuspendSignal('awaiting human approval');
        },
      });
      const a = agent({
        model: scriptModel([
          toolCallTurn('s1', 'await_approval', '{}'),
          endTurn('approved and done'),
        ]),
        tools: [waitForHuman],
      });
      const sess = session({
        store,
        agent: a,
      });
      const r1 = await sess.start('please approve');
      t.equal(r1.status, 'suspended', 'session suspended');
      t.ok(r1.state.suspendedOn?.token, 'resume token minted');
      await assertRevisionOnlyCheckpoint(t, store, r1.state);
      const token = r1.state.suspendedOn!.token;
      const r2 = await sess.resume(token, 'human approved');
      t.equal(r2.status, 'done', 'resumed and completed');
      t.equal(r2.text, 'approved and done');
      await assertRevisionOnlyCheckpoint(t, store, r2.state);
      await t.rejects(
        () => sess.resume(token, 'try again'),
        /suspended|token/i,
        'second resume with same token rejects',
      );
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('ctx.history: tool receives the conversation history object', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      let capturedHistoryRender: import('fino:ai/model').ModelMessage[] | undefined;
      const checkHistory = tool({
        name: 'check_history',
        description: 'Inspects ctx.history',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: (_args, ctx) => {
          if (ctx.history) {
            capturedHistoryRender = ctx.history.render();
          }
          return 'checked';
        },
      });
      const a = agent({
        model: scriptModel([toolCallTurn('h1', 'check_history', '{}'), endTurn('done')]),
        tools: [checkHistory],
      });
      const sess = session({
        store,
        agent: a,
      });
      await sess.start('hello');
      t.ok(capturedHistoryRender !== undefined, 'ctx.history was provided');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('ctx.suspend(): tool can suspend via ctx convenience method', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      const pauseTool = tool({
        name: 'pause',
        description: 'Pauses via ctx.suspend()',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: (_args, ctx) => {
          ctx.suspend({
            reason: 'waiting',
            payload: { key: 'val' },
          });
        },
      });
      const a = agent({
        model: scriptModel([toolCallTurn('p1', 'pause', '{}'), endTurn('done')]),
        tools: [pauseTool],
      });
      const sess = session({
        store,
        agent: a,
      });
      const r1 = await sess.start('please pause');
      t.equal(r1.status, 'suspended', 'session suspended via ctx.suspend()');
      t.equal(r1.state.suspendedOn?.reason, 'waiting', 'suspend reason forwarded');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('store.listRuns({threadId}) enumerates all runs for a thread', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      const threadId = 'list-test-thread';
      const make = () =>
        session({
          store,
          agent: agent({ model: scriptModel([endTurn('ok')]) }),
          threadId,
        });
      const r1 = await make().start('run 1');
      const r2 = await make().start('run 2');
      t.equal(r1.status, 'done');
      t.equal(r2.status, 'done');
      const all = await store.listRuns({ threadId });
      t.equal(all.length, 2, 'two runs found');
      t.ok(
        all.every((s) => s.threadId === threadId),
        'all runs belong to the thread',
      );
      const other = await store.listRuns({ threadId: 'other-thread' });
      t.equal(other.length, 0, 'other thread has no runs');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('approval-required tools suspend before execution', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      let executed = false;
      const risky = tool({
        name: 'delete_account',
        description: 'Deletes an account',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        requiresApproval: true,
        risk: 'destructive',
        sideEffects: true,
        execute: () => {
          executed = true;
          return 'deleted';
        },
      });
      const a = agent({
        model: scriptModel([toolCallTurn('d1', 'delete_account', '{"id":"acct_1"}')]),
        tools: [risky],
      });
      const sess = session({
        store,
        agent: a,
      });
      const result = await sess.start('delete acct_1');
      t.equal(result.status, 'suspended', 'session suspended for approval');
      t.equal(executed, false, 'tool did not execute before approval');
      t.equal(
        (result.state.suspendedOn?.payload as Record<string, unknown>)?.toolName,
        'delete_account',
      );
      t.equal((result.state.suspendedOn?.payload as Record<string, unknown>)?.risk, 'destructive');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('approved tools execute once and continue from the pending tool call', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      let executed = 0;
      const risky = tool({
        name: 'delete_account',
        description: 'Deletes an account',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        requiresApproval: true,
        risk: 'destructive',
        sideEffects: true,
        execute: ({ id }: { id: string }) => {
          executed++;
          return `deleted:${id}`;
        },
      });
      const { model: spy, getLastMessages } = captureModel();
      let first = true;
      const model: Model = {
        id: 'approval-model',
        name: 'approval-model',
        provider: 'test',
        dimensions: 0,
        stream(req: GenerateRequest): ModelStream {
          if (first) {
            first = false;
            return new ModelStreamImpl(
              (async function* () {
                yield* toolCallTurn('d1', 'delete_account', '{"id":"acct_1"}');
              })(),
            );
          }
          return spy.stream(req);
        },
        async generate() {
          throw new Error('use stream');
        },
        async embed() {
          return [];
        },
      };
      const sess = session({
        store,
        agent: agent({
          model,
          tools: [risky],
        }),
      });
      const pending = await sess.start('delete acct_1');
      t.equal(pending.status, 'suspended');
      await t.rejects(
        () => sess.resume(pending.state.suspendedOn!.token, { approved: true }),
        /approveTool|rejectTool|tool approval/i,
        'resume rejects tool approval suspensions',
      );
      const done = await sess.approveTool(pending.state.suspendedOn!.token);
      t.equal(done.status, 'done');
      t.equal(executed, 1, 'approved tool executed once');
      const toolResultMsg = getLastMessages().find(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          m.content.some(
            (p) =>
              p.type === 'tool_result' && p.toolCallId === 'd1' && p.content === 'deleted:acct_1',
          ),
      );
      t.ok(toolResultMsg, 'resumed model call sees the approved tool result');
      await t.rejects(
        () => sess.approveTool(pending.state.suspendedOn!.token),
        /suspended|token/i,
        'approval token remains single-use',
      );
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('rejected approval-required tools do not execute and return a tool error', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      let executed = false;
      const risky = tool({
        name: 'delete_account',
        description: 'Deletes an account',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        requiresApproval: true,
        sideEffects: true,
        execute: () => {
          executed = true;
          return 'deleted';
        },
      });
      const { model: spy, getLastMessages } = captureModel();
      let first = true;
      const model: Model = {
        id: 'approval-reject-model',
        name: 'approval-reject-model',
        provider: 'test',
        dimensions: 0,
        stream(req: GenerateRequest): ModelStream {
          if (first) {
            first = false;
            return new ModelStreamImpl(
              (async function* () {
                yield* toolCallTurn('d1', 'delete_account', '{"id":"acct_1"}');
              })(),
            );
          }
          return spy.stream(req);
        },
        async generate() {
          throw new Error('use stream');
        },
        async embed() {
          return [];
        },
      };
      const sess = session({
        store,
        agent: agent({
          model,
          tools: [risky],
        }),
      });
      const pending = await sess.start('delete acct_1');
      const done = await sess.rejectTool(pending.state.suspendedOn!.token, 'not allowed');
      t.equal(done.status, 'done');
      t.equal(executed, false, 'rejected tool did not execute');
      const toolResult = getLastMessages()
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((p) => p.type === 'tool_result' && p.toolCallId === 'd1');
      t.equal(toolResult?.isError, true, 'rejection is returned as a tool error');
      t.ok(
        String(toolResult?.content).includes('not allowed'),
        'rejection reason is model-visible',
      );
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('static approve/reject helpers resume persisted approval suspensions', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      let executed = 0;
      const risky = tool({
        name: 'charge_card',
        description: 'Charge card',
        parameters: {
          type: 'object',
          properties: { amount: { type: 'number' } },
          required: ['amount'],
        },
        requiresApproval: true,
        execute: ({ amount }: { amount: number }) => {
          executed++;
          return `charged:${amount}`;
        },
      });
      const doneModel = captureModel();
      let first = true;
      const model: Model = {
        id: 'static-approval',
        name: 'static-approval',
        provider: 'test',
        stream(req: GenerateRequest): ModelStream {
          if (first) {
            first = false;
            return new ModelStreamImpl(
              (async function* () {
                yield* toolCallTurn('c1', 'charge_card', '{"amount":42}');
              })(),
            );
          }
          return doneModel.model.stream(req);
        },
        async generate() {
          throw new Error('use stream');
        },
      };
      const pending = await session({
        store,
        agent: agent({
          model,
          tools: [risky],
        }),
      }).start('charge');
      t.equal(pending.status, 'suspended');
      const resumed = await Session.approveSuspended({
        store,
        agent: agent({
          model,
          tools: [risky],
        }),
        runId: pending.runId,
        resumeToken: pending.state.suspendedOn!.token,
      });
      t.equal(resumed.status, 'done');
      t.equal(executed, 1, 'static approval executes once');
      await t.rejects(
        () =>
          Session.rejectSuspended({
            store,
            agent: agent({
              model,
              tools: [risky],
            }),
            runId: pending.runId,
            resumeToken: pending.state.suspendedOn!.token,
            reason: 'late',
          }),
        /suspended|token/i,
        'consumed token cannot be rejected later',
      );
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
});
describe('Session.fork', () => {
  it('creates an independent run that inherits the parent conversation', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      const seenMessages: ModelMessage[][] = [];
      const trackingModel: Model = {
        id: 'tracking',
        name: 'tracking',
        provider: 'test',
        dimensions: 0,
        stream(req: GenerateRequest): ModelStream {
          seenMessages.push([...req.messages]);
          async function* gen() {
            yield {
              type: 'text_delta' as const,
              index: 0,
              text: 'response',
            };
            yield {
              type: 'usage' as const,
              usage: {
                inputTokens: 5,
                outputTokens: 3,
              },
            };
            yield {
              type: 'stop' as const,
              reason: 'end_turn' as const,
            };
          }
          return new ModelStreamImpl(gen());
        },
        async generate() {
          throw new Error('unused');
        },
        async embed() {
          return [];
        },
      };
      const parentSess = session({
        store,
        agent: agent({ model: trackingModel }),
      });
      const r1 = await parentSess.start('parent context');
      t.equal(r1.status, 'done');
      const forkResult = await parentSess.fork('fork question');
      t.equal(forkResult.status, 'done', 'fork ran to completion');
      t.ok(forkResult.runId !== r1.runId, 'fork has its own runId');
      const forkState = await store.loadRun(forkResult.runId);
      t.ok(forkState, 'fork persisted to store');
      t.ok(forkState!.threadId !== r1.state.threadId, 'fork has its own threadId');
      await assertRevisionOnlyCheckpoint(t, store, forkState!);
      const forkCallMsgs = seenMessages[seenMessages.length - 1]!;
      const forkContent = forkCallMsgs
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join(' ');
      t.ok(forkContent.includes('parent context'), 'fork sees parent history');
      t.ok(forkContent.includes('fork question'), 'fork sees the fork input');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('fork preserves history revision from a strategy-driven run', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      let compacted = false;
      const compactStrategy: HistoryStrategy = {
        history: new MessageHistory(),
        async onAppend(message) {
          this.history = await this.history.append(message);
          const refs = this.history.refs();
          if (!compacted && refs.length >= 2) {
            compacted = true;
            this.history = await this.history.edit({
              op: 'summary',
              sourceIds: refs.map((m) => m.id),
              entry: {
                message: {
                  role: 'user' as const,
                  content: '[SUMMARY]',
                },
              },
              replace: true,
            });
          }
        },
        async onRead() {
          return {
            history: this.history,
            messages: this.history.render(),
          };
        },
      };
      const forkMsgs: ModelMessage[][] = [];
      const forkModel: Model = {
        name: 'fork-model',
        dimensions: 0,
        stream(req: GenerateRequest): ModelStream {
          forkMsgs.push([...req.messages]);
          async function* gen() {
            yield {
              type: 'text_delta' as const,
              index: 0,
              text: 'compact-fork response',
            };
            yield {
              type: 'usage' as const,
              usage: {
                inputTokens: 5,
                outputTokens: 3,
              },
            };
            yield {
              type: 'stop' as const,
              reason: 'end_turn' as const,
            };
          }
          return new ModelStreamImpl(gen());
        },
        async generate() {
          throw new Error('unused');
        },
        async embed() {
          return [];
        },
      };
      const parentSess = session({
        store,
        agent: agent({
          model: forkModel,
          history: compactStrategy,
        }),
      });
      const r1 = await parentSess.start('compactable context');
      t.equal(r1.status, 'done');
      t.ok(compacted, 'strategy compacted the history');
      t.ok(parentSess.state?.historyRevisionId, 'history revision stored after strategy run');
      await assertRevisionOnlyCheckpoint(t, store, parentSess.state!);
      const forkResult = await parentSess.fork('fork after compaction');
      t.equal(forkResult.status, 'done', 'fork completed');
      const lastCall = forkMsgs[forkMsgs.length - 1]!;
      const allContent = lastCall
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join(' ');
      t.ok(allContent.includes('[SUMMARY]'), 'fork sees the compacted summary, not raw originals');
      t.ok(allContent.includes('fork after compaction'), 'fork sees its new input');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
});
describe('SessionStore', () => {
  it('InMemorySessionStore and SqliteSessionStore load equivalent committed sessions', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const sqlite = await SqliteSessionStore.open(`sqlite://${path}`);
    const memory = new InMemorySessionStore();
    try {
      let history = new MessageHistory();
      history = await history.append({
        role: 'user',
        content: 'stored input',
      });
      history = await history.append({
        role: 'assistant',
        content: 'stored reply',
      });
      const run: RunState = {
        runId: 'store-run',
        threadId: 'store-thread',
        status: 'done',
        stepIndex: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
        scratch: {},
        historyRevisionId: history.revisionId,
      };
      const thread = {
        threadId: run.threadId,
        historyRevisionId: history.revisionId,
        createdAt: 1,
        updatedAt: 2,
      };
      await memory.commitSession({
        run,
        thread,
        history,
      });
      await sqlite.commitSession({
        run,
        thread,
        history,
      });
      for (const store of [memory, sqlite]) {
        const loadedRun = await store.loadRun(run.runId);
        const loadedThread = await store.loadThread(run.threadId);
        const loadedHistory = await store.loadHistory(history.revisionId);
        t.equal(
          loadedRun?.historyRevisionId,
          history.revisionId,
          'run points at committed history',
        );
        t.equal(
          loadedThread?.historyRevisionId,
          history.revisionId,
          'thread points at committed history',
        );
        t.deepEqual(
          loadedHistory?.render().map((m) => m.content),
          ['stored input', 'stored reply'],
        );
      }
    } finally {
      await sqlite.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('commitSession rejects mismatched revision pointers without persisting state', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteSessionStore.open(path);
    try {
      let history = new MessageHistory();
      history = await history.append({
        role: 'user',
        content: 'valid history',
      });
      const run: RunState = {
        runId: 'bad-run',
        threadId: 'bad-thread',
        status: 'done',
        stepIndex: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
        scratch: {},
        historyRevisionId: history.revisionId,
      };
      await t.rejects(
        () =>
          store.commitSession({
            run,
            thread: {
              threadId: run.threadId,
              historyRevisionId: 'missing-revision',
              createdAt: 1,
              updatedAt: 1,
            },
            history,
          }),
        /points at history revision/,
        'mismatched thread revision rejects before commit',
      );
      t.equal(await store.loadRun(run.runId), null, 'run was not persisted');
      t.equal(await store.loadThread(run.threadId), null, 'thread was not persisted');
      t.equal(await store.loadHistory(history.revisionId), null, 'history graph was not persisted');
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
});
describe('Session streaming', () => {
  it('forwards model deltas and tool events through onEvent while checkpointing', async (t) => {
    const echo = tool({
      name: 'echo',
      description: 'Echo a value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
      },
      execute: async (args: unknown) => `echo:${(args as { value: string }).value}`,
    });
    const bot = agent({
      model: scriptModel([
        toolCallTurn('call_1', 'echo', JSON.stringify({ value: 'hi' })),
        endTurn('all done'),
      ]),
      tools: [echo],
    });
    const events: string[] = [];
    let streamed = '';
    const sess = session({
      store: new InMemorySessionStore(),
      agent: bot,
      onEvent: (ev) => {
        events.push(ev.type);
        if (ev.type === 'model_event' && ev.event.type === 'text_delta') streamed += ev.event.text;
      },
    });
    const result = await sess.start('run the echo tool');
    t.equal(result.status, 'done', 'run completed');
    t.equal(streamed, 'all done', 'text deltas streamed through onEvent');
    t.ok(events.includes('tool_start'), 'tool_start delivered');
    t.ok(events.includes('tool_result'), 'tool_result delivered');
    t.ok(events.includes('step_start'), 'step boundaries delivered');
  });

  it('streams approved-tool execution events after approveTool', async (t) => {
    const gated = tool({
      name: 'gated',
      description: 'Requires approval.',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiresApproval: true,
      execute: async () => 'gated ran',
    });
    const bot = agent({
      model: scriptModel([toolCallTurn('call_g', 'gated', '{}'), endTurn('after approval')]),
      tools: [gated],
    });
    const events: string[] = [];
    const sess = session({
      store: new InMemorySessionStore(),
      agent: bot,
      onEvent: (ev) => events.push(ev.type),
    });
    const first = await sess.start('run the gated tool');
    t.equal(first.status, 'suspended', 'run suspended for approval');
    const eventsBefore = events.length;
    const resumed = await sess.approveTool(first.state.suspendedOn!.token);
    t.equal(resumed.status, 'done', 'run completed after approval');
    const after = events.slice(eventsBefore);
    t.ok(after.includes('tool_start'), 'approval execution emits tool_start');
    t.ok(after.includes('tool_result'), 'approval execution emits tool_result');
  });

  it('does not fail the run when the onEvent observer throws', async (t) => {
    const bot = agent({ model: scriptModel([endTurn('fine')]) });
    const sess = session({
      store: new InMemorySessionStore(),
      agent: bot,
      onEvent: () => {
        throw new Error('observer boom');
      },
    });
    const result = await sess.start('hello');
    t.equal(result.status, 'done', 'run unaffected by observer error');
    t.equal(result.text, 'fine', 'result text intact');
  });
});
describe('Session steering', () => {
  it('injects steering messages at the next step boundary', async (t) => {
    const requests: ModelMessage[][] = [];
    let sess: Session;
    const steerTool = tool({
      name: 'work',
      description: 'Do some work.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        sess.steer('actually, focus on the tests');
        return 'working';
      },
    });
    const turns = [toolCallTurn('call_1', 'work', '{}'), endTurn('done')];
    let idx = 0;
    const model: Model = {
      id: 'capture',
      name: 'capture',
      provider: 'test',
      stream(req: GenerateRequest): ModelStream {
        requests.push(req.messages);
        const turn = turns[Math.min(idx, turns.length - 1)] ?? [];
        idx++;
        async function* gen() {
          yield* turn;
        }
        return new ModelStreamImpl(gen());
      },
      async generate() {
        throw new Error('use stream');
      },
    };
    sess = session({
      store: new InMemorySessionStore(),
      agent: agent({ model, tools: [steerTool] }),
    });
    const result = await sess.start('start working');
    t.equal(result.status, 'done', 'run completed');
    const second = requests[1]!;
    const last = second[second.length - 1]!;
    t.equal(last.role, 'user', 'steered message appended as user');
    t.equal(last.content, 'actually, focus on the tests', 'steering text visible to the model');
  });

  it('returns steering the run ended before consuming', async (t) => {
    let sess: Session;
    const model: Model = {
      id: 'late',
      name: 'late',
      provider: 'test',
      stream(): ModelStream {
        sess.steer('too late for this run');
        async function* gen() {
          yield* endTurn('finished');
        }
        return new ModelStreamImpl(gen());
      },
      async generate() {
        throw new Error('use stream');
      },
    };
    sess = session({ store: new InMemorySessionStore(), agent: agent({ model }) });
    const result = await sess.start('go');
    t.equal(result.status, 'done', 'run completed');
    t.deepEqual(
      result.unconsumedSteering,
      ['too late for this run'],
      'unconsumed steering returned',
    );
  });

  it('holds steering across a suspension and injects after approval', async (t) => {
    const gated = tool({
      name: 'gated',
      description: 'Needs approval.',
      parameters: { type: 'object', properties: {} },
      requiresApproval: true,
      execute: async () => 'ran',
    });
    const requests: ModelMessage[][] = [];
    const turns = [toolCallTurn('call_g', 'gated', '{}'), endTurn('after')];
    let idx = 0;
    const model: Model = {
      id: 'capture',
      name: 'capture',
      provider: 'test',
      stream(req: GenerateRequest): ModelStream {
        requests.push(req.messages);
        const turn = turns[Math.min(idx, turns.length - 1)] ?? [];
        idx++;
        async function* gen() {
          yield* turn;
        }
        return new ModelStreamImpl(gen());
      },
      async generate() {
        throw new Error('use stream');
      },
    };
    const sess = session({
      store: new InMemorySessionStore(),
      agent: agent({ model, tools: [gated] }),
    });
    const first = await sess.start('run it');
    t.equal(first.status, 'suspended', 'suspended for approval');
    sess.steer('note while you were paused');
    const resumed = await sess.approveTool(first.state.suspendedOn!.token);
    t.equal(resumed.status, 'done', 'completed after approval');
    const second = requests[1]!;
    const texts = second
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .map((m) => m.content);
    t.ok(
      texts.includes('note while you were paused'),
      'steering queued during suspension reached the model after approval',
    );
  });
});

describe('SessionStore metadata', () => {
  it('round-trips JSON values in the in-memory store', async (t) => {
    const store = new InMemorySessionStore();
    t.equal(await store.getMeta('missing'), null, 'unknown key is null');
    await store.putMeta('k', { list: [1, 2], name: 'x' });
    t.deepEqual(await store.getMeta('k'), { list: [1, 2], name: 'x' }, 'value round-trips');
    await store.putMeta('k', undefined);
    t.equal(await store.getMeta('k'), null, 'undefined deletes');
  });

  it('persists metadata across sqlite reopen', async (t) => {
    const path = `/tmp/fino-session-meta-${Date.now().toString(36)}.db`;
    const fs = new DiskFileSystem();
    try {
      const store = await SqliteSessionStore.open(path);
      await store.putMeta('pool', { children: ['a', 'b'] });
      await store.close();
      const reopened = await SqliteSessionStore.open(path);
      t.deepEqual(
        await reopened.getMeta('pool'),
        { children: ['a', 'b'] },
        'value survives reopen',
      );
      await reopened.putMeta('pool', undefined);
      t.equal(await reopened.getMeta('pool'), null, 'delete works');
      await reopened.close();
    } finally {
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
});
