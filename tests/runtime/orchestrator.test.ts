import { describe, it } from 'fino:test/test';
import { registerWorkload, releaseWorkload, workloadsSignal } from 'internal:orchestrator';
describe('internal orchestrator workload signal', () => {
  it('tracks workload registration and release', (t) => {
    const seen: number[] = [];
    const dispose = workloadsSignal().subscribe((workloads) => seen.push(workloads.length));
    const workload = registerWorkload('app', { test: true });
    t.ok(workloadsSignal().get().some((entry) => entry.id === workload.id), 'signal includes registered workload');
    releaseWorkload(workload.id, 'done');
    t.equal(workloadsSignal().get().some((entry) => entry.id === workload.id), false, 'signal removes released workload');
    t.ok(seen.some((count) => count > 0), 'subscriber saw a non-empty workload list');
    dispose();
  });
});
