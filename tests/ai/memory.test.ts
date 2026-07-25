import { describe, it } from 'fino:test/test';
import { retriever, SqliteMemory } from 'fino:ai/memory';
import type { Embedder } from 'fino:ai/memory';
import { DiskFileSystem } from 'fino:file';
function deterministicEmbedder(dim: number): Embedder {
  return {
    dimensions: dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const arr = new Float32Array(dim);
        for (let i = 0; i < dim; i++) {
          let h = 2166136261;
          for (let j = 0; j < t.length; j++) {
            h ^= t.charCodeAt(j) + i;
            h = Math.imul(h, 16777619) >>> 0;
          }
          arr[i] = h % 1e4 / 1e4 - .5;
        }
        return arr;
      });
    }
  };
}
function tmpPath(): string {
  return `/tmp/fino-memory-test-${Math.floor(Math.random() * 1e9)}.db`;
}
describe('SqliteMemory', () => {
  it('appends messages and retrieves them in chronological order', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const mem = await SqliteMemory.open({
      path,
      embedder: deterministicEmbedder(4)
    });
    try {
      const m1 = await mem.append({
        role: 'user',
        content: 'hello'
      });
      const m2 = await mem.append({
        role: 'assistant',
        content: 'hi there'
      });
      const m3 = await mem.append({
        role: 'user',
        content: 'bye'
      });
      t.equal(m1.role, 'user');
      t.equal(m1.threadId, mem.threadId);
      t.equal(m2.role, 'assistant');
      t.ok(m2.createdAt >= m1.createdAt, 'timestamps increase');
      const all = await mem.history();
      t.equal(all.length, 3, 'three messages returned');
      t.equal(all[0].content, 'hello', 'first message is chronologically earliest');
      t.equal(all[2].content, 'bye');
      const last2 = await mem.history({ last: 2 });
      t.equal(last2.length, 2, 'last:2 limits correctly');
      t.equal(last2[0].content, 'hi there');
      const before = await mem.history({ before: m3.createdAt });
      t.ok(before.every((m) => m.createdAt < m3.createdAt), 'before filter applied');
    } finally {
      await mem.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('round-trips structured content as JSON', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const mem = await SqliteMemory.open({
      path,
      embedder: deterministicEmbedder(4)
    });
    try {
      const parts = [{
        type: 'text',
        text: 'structured message'
      }];
      const appended = await mem.append({
        role: 'assistant',
        content: parts as never
      });
      t.deepEqual(appended.content, parts, 'content returned from append');
      const history = await mem.history();
      t.deepEqual(history[0].content, parts, 'content round-trips through sqlite');
    } finally {
      await mem.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('working memory: set, get, merge, replace', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const mem = await SqliteMemory.open({
      path,
      embedder: deterministicEmbedder(4)
    });
    try {
      t.equal(await mem.getWorkingMemory(), null, 'null before first write');
      await mem.setWorkingMemory({
        name: 'Alice',
        score: 10
      });
      t.deepEqual(await mem.getWorkingMemory(), {
        name: 'Alice',
        score: 10
      }, 'initial set');
      await mem.setWorkingMemory({
        score: 20,
        rank: 1
      }, 'merge');
      t.deepEqual(await mem.getWorkingMemory(), {
        name: 'Alice',
        score: 20,
        rank: 1
      }, 'merge preserves existing keys');
      await mem.setWorkingMemory({ x: 99 }, 'replace');
      t.deepEqual(await mem.getWorkingMemory(), { x: 99 }, 'replace discards prior state');
      t.deepEqual(mem.workingMemory.get(), { x: 99 }, 'working memory signal retains replacement');
    } finally {
      await mem.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('recall without query text returns history and workingMemory, no recalled items', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const mem = await SqliteMemory.open({
      path,
      embedder: deterministicEmbedder(4)
    });
    try {
      await mem.append({
        role: 'user',
        content: 'msg1'
      });
      await mem.append({
        role: 'assistant',
        content: 'msg2'
      });
      await mem.setWorkingMemory({ task: 'active' });
      const ctx = await mem.recall({});
      t.equal(ctx.messages.length, 2, 'history returned');
      t.deepEqual(ctx.workingMemory, { task: 'active' }, 'working memory returned');
      t.equal(ctx.recalled.length, 0, 'no recalled items without query.text');
    } finally {
      await mem.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('thread(id) re-scopes to a separate conversation on the same store', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const memA = await SqliteMemory.open({
      path,
      embedder: deterministicEmbedder(4)
    });
    try {
      await memA.append({
        role: 'user',
        content: 'in thread A'
      });
      const memB = memA.thread('thread-B');
      t.ok(memB.threadId !== memA.threadId, 'different threadId');
      await memB.append({
        role: 'user',
        content: 'in thread B'
      });
      const histA = await memA.history();
      t.equal(histA.length, 1, 'thread A has its message');
      t.equal(histA[0].content, 'in thread A');
      const histB = await memB.history();
      t.equal(histB.length, 1, 'thread B has its message');
      t.equal(histB[0].content, 'in thread B');
    } finally {
      await memA.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('semantic recall: ingest and KNN when available; degrades gracefully otherwise', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const dim = 8;
    const mem = await SqliteMemory.open({
      path,
      embedder: deterministicEmbedder(dim),
      dimensions: dim
    });
    try {
      if (mem.semanticAvailable) {
        await mem.ingest([
          {
            text: 'the quick brown fox',
            metadata: { tag: 'fox' }
          },
          {
            text: 'lazy dog sleeping',
            metadata: { tag: 'dog' }
          },
          {
            text: 'a fast orange fox running',
            metadata: { tag: 'fox2' }
          }
        ]);
        const ctx = await mem.recall({
          text: 'quick fox',
          topK: 2
        });
        t.ok(ctx.recalled.length > 0, 'KNN returned results');
        t.ok(ctx.recalled.length <= 2, 'topK honoured');
        t.ok(ctx.recalled[0].score > 0 && ctx.recalled[0].score <= 1, 'score in range');
        t.ok(ctx.recalled[0].text.length > 0, 'text is present');
      } else {
        await mem.ingest([{ text: 'no vectors' }]);
        const ctx = await mem.recall({ text: 'no vectors' });
        t.equal(ctx.recalled.length, 0, 'degrades to empty recalled without semantic');
        t.equal(mem.semanticAvailable, false, 'semanticAvailable flag is false');
      }
    } finally {
      await mem.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('ingestProgress signal reports stored chunks', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const mem = await SqliteMemory.open({
      path,
      embedder: deterministicEmbedder(4),
      fs
    });
    try {
      const seen: number[] = [];
      const dispose = mem.ingestProgress.subscribe((progress) => seen.push(progress.stored));
      await mem.ingest([{ text: 'alpha beta gamma' }], { chunk: {
        size: 5,
        overlap: 1
      } });
      dispose();
      t.equal(mem.ingestProgress.get().active, false, 'ingest progress ends inactive');
      t.ok(mem.ingestProgress.get().chunks > 1, 'ingest progress records chunk count');
      t.equal(mem.ingestProgress.get().stored, mem.ingestProgress.get().chunks, 'all chunks are stored');
      t.ok(seen.some((stored) => stored > 0), 'subscriber saw stored progress');
    } finally {
      await mem.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('semantic recall filters by metadata and returns citations', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const dim = 8;
    const mem = await SqliteMemory.open({
      path,
      embedder: deterministicEmbedder(dim),
      dimensions: dim
    });
    try {
      if (!mem.semanticAvailable) {
        t.equal(mem.semanticAvailable, false, 'semantic recall unavailable on this sqlite build');
        return;
      }
      await mem.ingest([{
        text: 'refund policy is thirty days',
        metadata: {
          topic: 'billing',
          source: 'policy'
        }
      }, {
        text: 'deployment runbook uses blue green',
        metadata: {
          topic: 'ops',
          source: 'runbook'
        }
      }]);
      const ctx = await mem.recall({
        text: 'refund',
        topK: 5,
        filter: { metadata: { topic: 'billing' } }
      });
      t.ok(ctx.recalled.length > 0, 'filtered recall returned a hit');
      t.equal(ctx.recalled.every((hit) => hit.metadata?.topic === 'billing'), true);
      t.ok(ctx.recalled[0].id, 'hit id is exposed');
      t.equal(ctx.recalled[0].citation?.id, ctx.recalled[0].id, 'citation points at the hit');
      t.deepEqual(ctx.recalled[0].citation?.metadata, ctx.recalled[0].metadata);
    } finally {
      await mem.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('retriever returns recalled hits with default query options', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const dim = 8;
    const mem = await SqliteMemory.open({
      path,
      embedder: deterministicEmbedder(dim),
      dimensions: dim
    });
    try {
      if (!mem.semanticAvailable) {
        t.equal(mem.semanticAvailable, false, 'semantic recall unavailable on this sqlite build');
        return;
      }
      await mem.ingest([{
        text: 'refund policy is thirty days',
        metadata: { topic: 'billing' }
      }, {
        text: 'incident runbook escalates pages',
        metadata: { topic: 'ops' }
      }]);
      const retrieveBilling = retriever(mem, {
        topK: 3,
        filter: { metadata: { topic: 'billing' } }
      });
      const hits = await retrieveBilling.retrieve('refund');
      t.ok(hits.length > 0, 'retriever returned hits');
      t.equal(hits.every((hit) => hit.metadata?.topic === 'billing'), true, 'default metadata filter applied');
    } finally {
      await mem.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
});
