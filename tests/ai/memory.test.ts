import { describe, it } from 'fino:test/test';
import { agentMemory, memoryTool, retriever, SqliteMemory } from 'fino:ai/memory';
import type { Embedder, MemoryLabeler } from 'fino:ai/memory';
import { Database } from 'fino:database/sqlite';
import { DiskFileSystem } from 'fino:file';
import { env } from 'fino:process';

function keywordEmbedder(): Embedder {
  const words = ['refund', 'deploy', 'concise', 'verbose'];
  return {
    dimensions: words.length,
    async embed(texts) {
      return texts.map((text) => {
        const lower = text.toLowerCase();
        return new Float32Array(words.map((word) => (lower.includes(word) ? 1 : 0)));
      });
    },
  };
}

function tmpPath(): string {
  return `/tmp/fino-memory-test-${Math.floor(Math.random() * 1e9)}.db`;
}

async function fixture(
  opts: {
    now?: () => number;
    labeler?: MemoryLabeler;
    reinforcement?: boolean;
    forgetting?: false | { halfLifeMs: number; suppressBelow?: number };
    maxContexts?: number;
    maxSelections?: number;
  } = {},
) {
  const path = tmpPath();
  const fs = new DiskFileSystem();
  try {
    await fs.unlink(path);
  } catch {}
  const store = await SqliteMemory.open({ path, embedder: keywordEmbedder(), fs });
  const controller = agentMemory({ store, namespace: 'workspace', ...opts });
  return {
    path,
    fs,
    store,
    controller,
    async close() {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    },
  };
}

describe('agent memory', () => {
  it('uses a scoped sqlite-vec cosine index when the extension is available', async (t) => {
    const probe = await Database.open(':memory:');
    const available = probe.vectorsAvailable;
    await probe.close();
    if (!available) {
      t.equal(
        env.FINO_SQLITE_VEC_PATH,
        undefined,
        'an explicitly configured sqlite-vec extension must load',
      );
      t.ok(true, 'sqlite-vec is unavailable');
      return;
    }

    const f = await fixture();
    try {
      const other = agentMemory({ store: f.store, namespace: 'other-workspace' });
      await other.remember({ text: 'refund noise from another namespace' });
      await f.controller.remember({ text: 'refund shared target' });
      await f.controller.remember({
        text: 'refund session target',
        scope: { type: 'session', sessionId: 'session-a' },
      });
      await f.controller.remember({
        text: 'refund hidden session',
        scope: { type: 'session', sessionId: 'session-b' },
      });

      const selected = await f.controller.recall({ text: 'refund', sessionId: 'session-a' });
      t.deepEqual(
        selected.hits.map((hit) => hit.text).sort(),
        ['refund session target', 'refund shared target'],
        'KNN prefilter includes shared and matching-session partitions only',
      );

      const inspect = await Database.open(f.path, { fs: f.fs });
      try {
        t.equal(inspect.vectorsAvailable, true, 'inspection connection loads sqlite-vec');
        const table = await inspect
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'`,
          )
          .get();
        t.equal(table?.name, 'memory_vectors', 'memory vectors use the existing vec0 support');
        const count = await inspect.prepare(`SELECT count(*) AS count FROM memory_vectors`).get();
        t.equal(Number(count?.count), 4, 'every committed memory is indexed');
        await inspect
          .prepare(
            `DELETE FROM memory_vectors WHERE rowid = (SELECT min(rowid) FROM memory_vectors)`,
          )
          .run();
      } finally {
        await inspect.close();
      }
      await f.store.close();
      const reopened = await SqliteMemory.open({
        path: f.path,
        embedder: keywordEmbedder(),
        fs: f.fs,
      });
      const verify = await Database.open(f.path, { fs: f.fs });
      try {
        t.equal(verify.vectorsAvailable, true, 'verification connection loads sqlite-vec');
        const count = await verify.prepare(`SELECT count(*) AS count FROM memory_vectors`).get();
        t.equal(Number(count?.count), 4, 'opening the store repairs missing vector rows');
      } finally {
        await verify.close();
        await reopened.close();
      }
    } finally {
      await f.close();
    }
  });

  it('shares durable memories across sessions while isolating session scope', async (t) => {
    const f = await fixture();
    try {
      await f.controller.remember({ text: 'refunds are available for thirty days' });
      await f.controller.remember({
        text: 'deployment scratch note',
        scope: { type: 'session', sessionId: 'session-a' },
      });
      const shared = await f.controller.recall({ text: 'refund', sessionId: 'session-b' });
      t.equal(shared.hits[0]?.text, 'refunds are available for thirty days');
      const isolated = await f.controller.recall({ text: 'deploy', sessionId: 'session-b' });
      t.equal(isolated.hits.length, 0, 'another session cannot recall session memory');
      const local = await f.controller.recall({ text: 'deploy', sessionId: 'session-a' });
      t.equal(local.hits[0]?.text, 'deployment scratch note');
    } finally {
      await f.close();
    }
  });

  it('records exposure without reinforcement and applies an eval exactly once', async (t) => {
    const f = await fixture({ reinforcement: true });
    try {
      const memory = await f.controller.remember({ text: 'refund preference' });
      const selection = await f.controller.recall({
        text: 'refund',
        labels: { task: ['billing'] },
      });
      let stored = await f.controller.get(memory.id);
      t.equal(stored!.utility.exposures, 1);
      t.equal(stored!.utility.evalCount, 0, 'exposure is not reinforcement');
      t.equal(await f.controller.complete(selection.selectionId, { score: 1 }), true);
      t.equal(await f.controller.complete(selection.selectionId, { score: 0 }), false);
      stored = await f.controller.get(memory.id);
      t.equal(stored!.utility.evalCount, 1, 'selection completion is idempotent');
      t.ok(stored!.utility.evalSum > 0, 'positive bundle eval reinforces');
      t.equal(stored!.utility.contexts.length, 1, 'context is aggregated by labels');
    } finally {
      await f.close();
    }
  });

  it('does not lose exposure updates from concurrent session recalls', async (t) => {
    const f = await fixture();
    try {
      const memory = await f.controller.remember({ text: 'refund preference' });
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          f.controller.recall({ text: 'refund', sessionId: `session-${index}` }),
        ),
      );
      t.equal((await f.controller.get(memory.id))!.utility.exposures, 12);
    } finally {
      await f.close();
    }
  });

  it('stores mutable manual feedback instead of an evidence ledger', async (t) => {
    const f = await fixture({ reinforcement: true });
    try {
      const memory = await f.controller.remember({ text: 'be concise' });
      await f.controller.feedback(memory.id, { value: 1 });
      t.equal((await f.controller.get(memory.id))!.utility.manual, 1);
      await f.controller.feedback(memory.id, { value: -1 });
      t.equal((await f.controller.get(memory.id))!.utility.manual, -1, 'feedback replaces');
      await f.controller.feedback(memory.id, { value: null });
      t.equal((await f.controller.get(memory.id))!.utility.manual, null, 'feedback clears');
    } finally {
      await f.close();
    }
  });

  it('bounds contextual utility and outstanding selection receipts', async (t) => {
    const f = await fixture({ reinforcement: true, maxContexts: 2, maxSelections: 2 });
    try {
      const memory = await f.controller.remember({ text: 'refund rule' });
      for (const task of ['one', 'two', 'three']) {
        const selected = await f.controller.recall({ text: 'refund', labels: { task: [task] } });
        await f.controller.complete(selected.selectionId, { score: 1 });
      }
      const stored = await f.controller.get(memory.id);
      t.equal(stored!.utility.contexts.length, 2, 'oldest context aggregate is replaced');
      const first = await f.controller.recall({ text: 'refund' });
      await f.controller.recall({ text: 'refund' });
      await f.controller.recall({ text: 'refund' });
      t.equal(
        await f.controller.complete(first.selectionId, { score: 1 }),
        false,
        'oldest receipt is pruned',
      );
    } finally {
      await f.close();
    }
  });

  it('makes forgetting optional and uses an injected clock', async (t) => {
    let now = 1_000;
    const decaying = await fixture({
      now: () => now,
      forgetting: { halfLifeMs: 100, suppressBelow: .2 },
    });
    try {
      await decaying.controller.remember({ text: 'refund rule' });
      now += 1_000;
      t.equal((await decaying.controller.recall({ text: 'refund' })).hits.length, 0);
    } finally {
      await decaying.close();
    }
    const retained = await fixture({ now: () => now, forgetting: false });
    try {
      await retained.controller.remember({ text: 'refund rule' });
      now += 1_000_000;
      t.equal((await retained.controller.recall({ text: 'refund' })).hits.length, 1);
    } finally {
      await retained.close();
    }
  });

  it('suppresses expired session memories without deleting their inspectable state', async (t) => {
    let now = 100;
    const f = await fixture({ now: () => now });
    try {
      const memory = await f.controller.remember({
        text: 'deployment scratch note',
        scope: { type: 'session', sessionId: 'session-a' },
        expiresAt: 200,
      });
      t.equal(
        (await f.controller.recall({ text: 'deploy', sessionId: 'session-a' })).hits.length,
        1,
      );
      now = 201;
      t.equal(
        (await f.controller.recall({ text: 'deploy', sessionId: 'session-a' })).hits.length,
        0,
      );
      t.equal((await f.controller.get(memory.id))!.text, 'deployment scratch note');
    } finally {
      await f.close();
    }
  });

  it('normalizes bounded labels and survives automatic labeler failure', async (t) => {
    let fail = false;
    const labeler: MemoryLabeler = {
      async label() {
        if (fail) throw new Error('classifier unavailable');
        return { topic: [' Billing ', 'billing', 'ops'], ignored: ['x'] };
      },
    };
    const f = await fixture({ labeler });
    try {
      const labeled = await f.controller.remember({ text: 'refund details' });
      t.deepEqual(labeled.labels, { topic: ['billing', 'ops'] });
      t.deepEqual(await f.controller.labels({ text: 'session summary', source: 'session' }), {
        topic: ['billing', 'ops'],
      });
      fail = true;
      const unlabeled = await f.controller.remember({ text: 'refund fallback' });
      t.deepEqual(unlabeled.labels, {}, 'memory remains valid when labeling fails');
    } finally {
      await f.close();
    }
  });

  it('filters explicit labels and uses query labels only as a boost', async (t) => {
    const f = await fixture();
    try {
      await f.controller.remember({
        text: 'refund billing version',
        labels: { topic: ['billing'] },
      });
      await f.controller.remember({
        text: 'refund support version',
        labels: { topic: ['support'] },
      });
      const filtered = await f.controller.recall({
        text: 'refund',
        filter: { labels: { topic: ['support'] } },
      });
      t.equal(filtered.hits.length, 1);
      t.equal(filtered.hits[0].labels.topic[0], 'support');
      const boosted = await f.controller.recall({ text: 'refund', labels: { topic: ['support'] } });
      t.equal(boosted.hits[0].labels.topic[0], 'support');
    } finally {
      await f.close();
    }
  });

  it('provides retriever and opt-in creation tool adapters', async (t) => {
    const f = await fixture();
    try {
      const remember = memoryTool(f.controller, { sessionId: 'session-a' });
      const result = await remember.run({
        text: 'deploy using blue green',
        durability: 'session',
        labels: { topic: ['ops'] },
      });
      t.ok(result.content.includes('Remembered'));
      const hits = await retriever(f.controller, { sessionId: 'session-a' }).retrieve('deploy');
      t.equal(hits.length, 1);
      t.equal(hits[0].scope.type, 'session', 'tool binds the supplied session authority');
    } finally {
      await f.close();
    }
  });
});
