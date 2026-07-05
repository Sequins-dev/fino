/**
* Budget enforcement against the real push-driven node: a synchronous runaway is
* hard-cancelled by the budget watchdog, and its sibling on the same thread
* still runs — proving the runaway cannot pin the scheduler thread. Long-running
* *async* work is deliberately NOT constrained (that is a first-class use case);
* only on-CPU synchronous time is contained.
*/
import { describe, it } from 'fino:test/test';
import { SchedulerNode } from 'internal:orchestrator/scheduler-node';
import { DiskFileSystem } from 'fino:file';
import type { WorkloadId } from 'internal:scheduler/types';

const runaway = new URL('./fixtures/scheduler-runaway-worker.ts', import.meta.url).pathname;
const runOnce = new URL('./fixtures/deploy-worker.ts', import.meta.url).pathname;

function wakeFor(node: SchedulerNode, workloadId: WorkloadId, sourceId: string): void {
  node.wake(workloadId, { workloadId, reason: 'message', sourceId });
}

describe('scheduler budget enforcement', () => {
  it('hard-cancels a synchronous runaway and keeps its sibling schedulable', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-budget-${Math.floor(Math.random() * 1e9)}`;
    await fs.mkdir(root);
    const out = `${root}/sibling.txt`;
    // One thread hosts both, so the sibling can only run if the runaway is
    // actually broken and stops pinning the thread.
    const node = new SchedulerNode({ shardCount: 1, capacity: 2, hardBudgetMicros: 150_000 });
    node.start();
    try {
      const runId = node.deploy({ tenantId: 'runaway', entryPath: runaway, data: { runaway: true } });
      const okId = node.deploy({ tenantId: 'ok', entryPath: runOnce, data: { outputPath: out, message: 'survived' } });
      const runReleased = node.whenReleased(runId);
      const okReleased = node.whenReleased(okId);
      wakeFor(node, runId, 'run');
      wakeFor(node, okId, 'ok');

      // The runaway never returns on its own, so its release proves containment.
      const runReason = await runReleased;
      await okReleased;
      t.equal(runReason, 'terminated', 'the runaway was hard-cancelled');
      t.equal(new TextDecoder().decode(await fs.readFile(out)), 'survived', 'the sibling ran once the runaway was contained');
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });
});
