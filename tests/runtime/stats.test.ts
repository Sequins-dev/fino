/**
 * internal:runtime/stats — self-reported load sampling.
 */
import { describe, it } from 'fino:test/test';
import { capacityCores, heapSample, resourceSample, sampleNodeLoad } from 'internal:runtime/stats';

describe('runtime stats', () => {
  it('samples process resources and node load', async (t) => {
    const resources = resourceSample();
    t.ok(resources.cpuMicros > 0, 'process has consumed CPU time');
    t.ok(resources.maxRssBytes > 10 * 1024 * 1024, 'peak RSS is a plausible byte count');

    const initial = sampleNodeLoad();
    t.ok(initial.cpu >= 0 && initial.cpu <= 1, 'first sample cpu is in range');
    t.ok(initial.memory > 10 * 1024 * 1024, 'memory reports peak RSS bytes');
    t.equal('loopIdle' in initial, false, 'reactor realms omit loopIdle');

    const burnUntil = Date.now() + 50;
    while (Date.now() < burnUntil) Math.sqrt(Math.random());
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const second = sampleNodeLoad();
    t.ok(second.cpu > 0, 'a busy window reports non-zero cpu');
    t.ok(second.cpu <= 1, 'cpu ratio stays clamped');

    t.ok(capacityCores() >= 1, 'capacity reports at least one core');
    const heap = heapSample();
    t.ok(heap.usedHeapSize > 0, 'heap usage is positive');
    t.ok(heap.heapSizeLimit > heap.usedHeapSize, 'heap limit exceeds usage');
  });
});
