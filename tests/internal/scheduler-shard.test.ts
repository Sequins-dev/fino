/**
* Pure selection/wake-management tests for the scheduler. The shard's runtime
* behavior (pumping, parking, containment) is covered end-to-end by
* scheduler-node.test.ts and scheduler-budget.test.ts against the real
* push-driven scheduler.
*/
import { describe, it } from 'fino:test/test';
import { firstWake, removeWake, selectNextWorkload } from 'internal:scheduler/selection';

describe('scheduler selection', () => {
  it('orders runnable workloads by priority before age', (t) => {
    const selected = selectNextWorkload([{
      workloadId: 'background-old',
      priority: 'background',
      wakes: [{ workloadId: 'background-old', reason: 'message', sourceId: 'm1', sequence: 1 }],
      debtMicros: 0,
      sequence: 1
    }, {
      workloadId: 'interactive-new',
      priority: 'interactive',
      wakes: [{ workloadId: 'interactive-new', reason: 'message', sourceId: 'm2', sequence: 2 }],
      debtMicros: 0,
      sequence: 2
    }]);
    t.equal(selected?.workloadId, 'interactive-new');
  });

  it('penalizes budget debt between equal priority workloads', (t) => {
    const selected = selectNextWorkload([{
      workloadId: 'debt-heavy',
      priority: 'service',
      wakes: [{ workloadId: 'debt-heavy', reason: 'message', sourceId: 'm1', sequence: 1 }],
      debtMicros: 500,
      sequence: 1
    }, {
      workloadId: 'debt-light',
      priority: 'service',
      wakes: [{ workloadId: 'debt-light', reason: 'message', sourceId: 'm2', sequence: 2 }],
      debtMicros: 0,
      sequence: 2
    }]);
    t.equal(selected?.workloadId, 'debt-light');
  });

  it('consumes the dispatched (earliest-deadline) wake, not the queue head', (t) => {
    // wakes[0] has a later deadline than wakes[1]; the scheduler dispatches the
    // earliest-deadline wake, and must consume exactly that one.
    const wakes = [
      { workloadId: 'w', reason: 'io' as const, sourceId: 'io', deadlineNanos: 100, sequence: 1 },
      { workloadId: 'w', reason: 'timer' as const, sourceId: 'timer', deadlineNanos: 10, sequence: 2 }
    ];
    const dispatched = firstWake({ workloadId: 'w', priority: 'service', wakes, debtMicros: 0, sequence: 0 });
    t.equal(dispatched?.sourceId, 'timer', 'earliest-deadline wake is dispatched');
    const remaining = removeWake(wakes, dispatched);
    t.deepEqual(remaining.map((w) => w.sourceId), ['io'], 'the out-of-order io wake survives, the serviced timer wake is gone');
  });

  it('removeWake leaves the queue unchanged when nothing was dispatched', (t) => {
    const wakes = [{ workloadId: 'w', reason: 'message' as const, sourceId: 'm', sequence: 1 }];
    t.equal(removeWake(wakes, null), wakes, 'no dispatched wake is a no-op');
  });
});
