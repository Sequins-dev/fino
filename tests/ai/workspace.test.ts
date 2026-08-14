import { describe, it } from 'fino:test/test';
import { AgentWorkspace, type AgentSessionContext } from 'fino:ai/workspace';
import { InMemorySessionStore, type SessionStore } from 'fino:ai/session';

/**
 * A stand-in for whatever object an application drives per session: it only
 * has to report turns, activity, and model changes back to the workspace.
 */
class FakeSession {
  id: string;
  ctx: AgentSessionContext;
  closed = false;

  constructor(id: string, ctx: AgentSessionContext) {
    this.id = id;
    this.ctx = ctx;
  }

  run(input: string): void {
    this.ctx.onTurn(input);
    this.ctx.onActivity('working');
    this.ctx.onActivity('idle');
  }
}

function openFake(
  opts: { store?: SessionStore; key?: string; idPrefix?: string } = {},
): Promise<AgentWorkspace<FakeSession>> {
  return AgentWorkspace.open<FakeSession>({
    ...opts,
    create: async (id, ctx) => new FakeSession(id, ctx),
    close: async (session) => {
      session.closed = true;
    },
  });
}

describe('fino:ai/workspace — registry', () => {
  it('registers a session on its first turn and derives the title', async (t) => {
    const workspace = await openFake();
    const session = await workspace.createSession();
    t.equal(workspace.list().length, 0, 'a created session is not registered yet');
    t.equal(workspace.meta(session.id), undefined, 'and has no registry entry');
    session.run('  investigate   the flaky   loader test  ');
    const meta = workspace.meta(session.id);
    t.equal(
      meta?.title,
      'investigate the flaky loader test',
      'title derived and whitespace folded',
    );
    t.equal(meta?.archived, false, 'new sessions are active');
    t.ok((meta?.createdAt ?? 0) > 0, 'creation timestamp recorded');
    await workspace.close();
  });

  it('truncates long derived titles and falls back to untitled', async (t) => {
    const workspace = await openFake();
    const long = await workspace.createSession();
    long.run('x'.repeat(80));
    t.equal(workspace.meta(long.id)?.title, 'x'.repeat(47) + '…', 'long titles are cut at 48');
    const blank = await workspace.createSession();
    blank.run('   ');
    t.equal(workspace.meta(blank.id)?.title, 'untitled', 'an empty first turn stays untitled');
    blank.run('a real prompt');
    t.equal(workspace.meta(blank.id)?.title, 'a real prompt', 'the next turn names it');
    await workspace.close();
  });

  it('lists by recency and separates archived sessions', async (t) => {
    const workspace = await openFake();
    const first = await workspace.createSession();
    first.run('first');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await workspace.createSession();
    second.run('second');
    t.deepEqual(
      workspace.list().map((meta) => meta.id),
      [second.id, first.id],
      'most recently touched first',
    );
    await workspace.archiveSession(first.id);
    t.deepEqual(
      workspace.list().map((meta) => meta.id),
      [second.id],
      'archived sessions leave the active list',
    );
    t.deepEqual(
      workspace.list({ archived: true }).map((meta) => meta.id),
      [first.id],
      'and appear in the archived list',
    );
    t.equal(first.closed, true, 'archiving releases the live object');
    t.equal(workspace.sessionFor(first.id), undefined, 'nothing live backs an archived session');
    await workspace.close();
  });

  it('shares one store across a reopened registry', async (t) => {
    const store = new InMemorySessionStore();
    const open1 = await openFake({ store, key: 'app:sessions' });
    const session = await open1.createSession();
    session.run('durable prompt');
    await open1.close();

    const open2 = await openFake({ store, key: 'app:sessions' });
    t.equal(open2.meta(session.id)?.title, 'durable prompt', 'registry reloaded from the store');
    const wrongKey = await openFake({ store, key: 'other:sessions' });
    t.equal(wrongKey.list().length, 0, 'each registry key is its own namespace');
    await open2.close();
  });

  it('caches one object per id and generates prefixed ids', async (t) => {
    const workspace = await openFake({ idPrefix: 'myapp' });
    const session = await workspace.createSession();
    t.ok(session.id.startsWith('myapp-'), 'ids carry the configured prefix');
    t.equal(workspace.sessionFor(session.id), session, 'the live object is cached');
    session.run('go');
    t.equal(await workspace.openSession(session.id), session, 'openSession reuses the cache');
    await workspace.close();
    t.equal(session.closed, true, 'close releases every open object');
  });
});

describe('fino:ai/workspace — lifecycle', () => {
  it('registers an unknown id on open and thaws archived ones', async (t) => {
    const workspace = await openFake();
    const adopted = await workspace.openSession('legacy-thread');
    t.equal(
      workspace.meta('legacy-thread')?.title,
      'untitled',
      'pre-registry threads join the list',
    );
    adopted.run('name me');
    t.equal(workspace.meta('legacy-thread')?.title, 'name me', 'the first turn names it');

    await workspace.archiveSession('legacy-thread');
    t.equal(workspace.meta('legacy-thread')?.archived, true, 'archived flag recorded');
    const revived = await workspace.openSession('legacy-thread');
    t.equal(workspace.meta('legacy-thread')?.archived, false, 'opening it thaws the session');
    t.ok(revived !== adopted, 'a fresh object is built after the archived one was released');
    await workspace.close();
  });

  it('opens the latest session or nothing at all', async (t) => {
    const workspace = await openFake();
    t.equal(await workspace.openLatest(), null, 'an empty registry has no latest');
    const session = await workspace.createSession();
    session.run('only one');
    const latest = await workspace.openLatest();
    t.equal(latest?.id, session.id, 'the registered session is the latest');
    await workspace.close();
  });

  it('renames sessions and rejects unknown ids', async (t) => {
    const workspace = await openFake();
    const session = await workspace.createSession();
    session.run('original');
    await workspace.setTitle(session.id, '  renamed   by hand  ');
    t.equal(workspace.meta(session.id)?.title, 'renamed by hand', 'titles are normalized');
    await t.rejects(() => workspace.setTitle('nope', 'x'), /Unknown session/);
    await t.rejects(() => workspace.archiveSession('nope'), /Unknown session/);
    await workspace.close();
  });

  it('records the model a session reports, including before it registers', async (t) => {
    const workspace = await openFake();
    const early = await workspace.createSession();
    early.ctx.onModel('model-a');
    t.equal(workspace.meta(early.id), undefined, 'the draft model does not register the session');
    early.run('first prompt');
    t.equal(workspace.meta(early.id)?.model, 'model-a', 'the draft choice lands on registration');
    early.ctx.onModel('model-b');
    t.equal(workspace.meta(early.id)?.model, 'model-b', 'later choices overwrite it');
    await workspace.close();
  });

  it('hands the stored entry to the factory when a session reopens', async (t) => {
    const store = new InMemorySessionStore();
    const seen: Array<string | undefined> = [];
    const factory = () =>
      AgentWorkspace.open<FakeSession>({
        store,
        create: async (id, ctx) => {
          seen.push(ctx.meta?.model);
          return new FakeSession(id, ctx);
        },
      });
    const open1 = await factory();
    const session = await open1.createSession();
    session.run('remember my model');
    session.ctx.onModel('model-a');
    await open1.close();

    const open2 = await factory();
    await open2.openSession(session.id);
    t.deepEqual(seen, [undefined, 'model-a'], 'a fresh session has no meta, a reopened one does');
    await open2.close();
  });
});

describe('fino:ai/workspace — activity', () => {
  it('turns a settled run into an unseen done that markSeen retires', async (t) => {
    const workspace = await openFake();
    const session = await workspace.createSession();
    t.equal(workspace.activity(session.id), 'idle', 'unopened sessions are idle');
    session.ctx.onActivity('working');
    t.equal(workspace.activity(session.id), 'working', 'working while the turn runs');
    session.ctx.onActivity('idle');
    t.equal(workspace.activity(session.id), 'done', 'idle after working is an unseen result');

    let notifications = 0;
    workspace.onChange(() => notifications++);
    workspace.markSeen(session.id);
    t.equal(workspace.activity(session.id), 'idle', 'seen result drops to idle');
    t.equal(notifications, 1, 'markSeen notifies observers');
    workspace.markSeen(session.id);
    t.equal(notifications, 1, 'markSeen on an idle session is a no-op');
    await workspace.close();
  });

  it('reports states other than idle straight through', async (t) => {
    const workspace = await openFake();
    const session = await workspace.createSession();
    session.ctx.onActivity('waiting');
    t.equal(workspace.activity(session.id), 'waiting', 'waiting passes through');
    session.ctx.onActivity('error');
    t.equal(workspace.activity(session.id), 'error', 'error passes through');
    workspace.markSeen(session.id);
    t.equal(workspace.activity(session.id), 'idle', 'markSeen also retires an error');
    session.ctx.onActivity('idle');
    t.equal(workspace.activity(session.id), 'idle', 'idle without working stays idle');
    await workspace.close();
  });

  it('folds the other sessions into one attention summary', async (t) => {
    const workspace = await openFake();
    const waiting = await workspace.createSession();
    const busy = await workspace.createSession();
    const looking = await workspace.createSession();
    for (const session of [waiting, busy, looking]) session.run('prompt');
    waiting.ctx.onActivity('waiting');
    busy.ctx.onActivity('working');
    looking.ctx.onActivity('error');

    t.deepEqual(
      workspace.attentionSummary(),
      { input: true, error: true, done: false, busy: true },
      'every registered session counts',
    );
    t.deepEqual(
      workspace.attentionSummary(looking.id),
      { input: true, error: false, done: false, busy: true },
      'the excluded session does not count against itself',
    );

    await workspace.archiveSession(waiting.id);
    t.deepEqual(
      workspace.attentionSummary(looking.id),
      { input: false, error: false, done: false, busy: true },
      'archived sessions never ask for attention',
    );
    await workspace.close();
  });

  it('ignores observer errors and stops notifying after unsubscribe', async (t) => {
    const workspace = await openFake();
    const session = await workspace.createSession();
    let calls = 0;
    workspace.onChange(() => {
      throw new Error('observer blew up');
    });
    const stop = workspace.onChange(() => calls++);
    session.ctx.onActivity('waiting');
    t.equal(calls, 1, 'a failing observer does not block the others');
    stop();
    session.ctx.onActivity('working');
    t.equal(calls, 1, 'unsubscribed observers stop firing');
    await workspace.close();
  });
});

describe('fino:ai/workspace — deletion', () => {
  it('sweeps the registry entry, thread runs, child runs, and metadata keys', async (t) => {
    const store = new InMemorySessionStore();
    const workspace = await AgentWorkspace.open<FakeSession>({
      store,
      create: async (id, ctx) => new FakeSession(id, ctx),
      close: async (session) => {
        session.closed = true;
      },
      metaKeys: (id) => [`app:turns:${id}`],
    });
    const session = await workspace.createSession();
    session.run('a prompt to persist');
    const id = session.id;
    const other = await workspace.createSession();
    other.run('a neighbour');

    for (const threadId of [id, `${id}:sa_1`, other.id]) {
      await store.save({
        runId: `run-${threadId}`,
        threadId,
        status: 'done',
        stepIndex: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    }
    await store.putMeta(`subagents:${id}`, [{ id: 'sa_1' }]);
    await store.putMeta(`app:turns:${id}`, [{ status: 'done' }]);
    t.equal((await store.listRuns()).length, 3, 'three runs before the delete');

    await workspace.deleteSession(id);
    t.equal(workspace.meta(id), undefined, 'registry entry removed');
    t.equal(session.closed, true, 'the live object was released');
    t.equal(workspace.activity(id), 'idle', 'activity forgotten');
    t.deepEqual(
      (await store.listRuns()).map((run) => run.threadId),
      [other.id],
      'the thread and its sub-agent threads are swept, neighbours are not',
    );
    t.equal(await store.getMeta(`subagents:${id}`), null, 'sub-agent pool state deleted');
    t.equal(await store.getMeta(`app:turns:${id}`), null, 'application metadata key deleted');
    await workspace.close();
  });
});
