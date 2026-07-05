/**
* Runtime integration: the multi-tenant deploy entrypoint routes every tenant
* workload's placement through the orchestrator, boots scheduler threads, and
* runs the workloads to completion — while the single-tenant `runApp` fast path
* stays untouched.
*/
import { describe, it } from 'fino:test/test';
import { deployNode, runApp, workloads } from 'internal:orchestrator';
import { DiskFileSystem } from 'fino:file';

const worker = new URL('./fixtures/deploy-worker.ts', import.meta.url).pathname;

describe('multi-tenant deploy', () => {
  it('deploys tenant workloads through the orchestrator and runs them to completion', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-deploy-${Math.floor(Math.random() * 1e9)}`;
    await fs.mkdir(root);
    const outA = `${root}/acme.txt`;
    const outB = `${root}/globex.txt`;

    try {
      const result = await deployNode([
        { tenantId: 'acme', entry: worker, data: { outputPath: outA, message: 'from-acme' } },
        { tenantId: 'globex', entry: worker, data: { outputPath: outB, message: 'from-globex' } }
      ], { shardCount: 2, capacity: 4 });

      t.equal(result.placements.length, 2, 'both tenants were placed');
      t.equal(result.placements.every((p) => p.thread !== null), true, 'the orchestrator chose a thread for each');
      const dispatches = result.summaries.reduce((sum, s) => sum + s.dispatches, 0);
      t.equal(dispatches, 2, 'both tenant workloads ran to completion');
      t.equal(new TextDecoder().decode(await fs.readFile(outA)), 'from-acme', 'acme workload did its facade-owned I/O');
      t.equal(new TextDecoder().decode(await fs.readFile(outB)), 'from-globex', 'globex workload did its facade-owned I/O');
    } finally {
      await fs.unlink(outA).catch(() => undefined);
      await fs.unlink(outB).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('spreads unpinned tenants across scheduler threads', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-deploy-spread-${Math.floor(Math.random() * 1e9)}`;
    await fs.mkdir(root);
    try {
      const result = await deployNode(
        Array.from({ length: 4 }, (_, i) => ({
          tenantId: `t${i}`,
          entry: worker,
          data: { outputPath: `${root}/t${i}.txt`, message: `m${i}` }
        })),
        { shardCount: 2, capacity: 4 }
      );
      const threads = new Set(result.placements.map((p) => p.thread));
      t.equal(threads.size, 2, 'placement used both scheduler threads');
    } finally {
      for (let i = 0; i < 4; i++) await fs.unlink(`${root}/t${i}.txt`).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('releases every deployed workload from the supervisory registry after the run', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-deploy-registry-${Math.floor(Math.random() * 1e9)}`;
    await fs.mkdir(root);
    const before = workloads().length;
    try {
      await deployNode([
        { tenantId: 'acme', entry: worker, data: { outputPath: `${root}/a.txt`, message: 'a' } }
      ], { shardCount: 1, capacity: 2 });
      t.equal(workloads().length, before, 'no tenant workloads leak into the registry after completion');
    } finally {
      await fs.unlink(`${root}/a.txt`).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('keeps runApp working as the single-tenant fast path', async (t) => {
    const entry = new URL('./fixtures/deploy-app-entry.ts', import.meta.url).pathname;
    // runApp evaluates the entry as an embedded child realm and resolves on
    // completion — the fast path is untouched by the multi-tenant entrypoint.
    const result = await runApp({ entry });
    t.equal(result, undefined, 'runApp resolves when the single-tenant entry completes');
  });
});
