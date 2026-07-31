/**
 * Shed-mark lifecycle for pre-init workload specs on a standalone reactor
 * queue — the tail-take surface the cluster balancer builds on. A queue with
 * no reactor threads keeps every spec pending, so the transitions are
 * deterministic.
 */
import { describe, it } from 'fino:test/test';
import {
  clearSheddingWorkload,
  closeReactorQueue,
  createReactorQueue,
  createWorkload,
  dropShedWorkload,
  isolateHeapStatistics,
  markSheddingWorkload,
  reactorQueueDepth,
  resubmitShedWorkload,
  shedWorkloadConfig,
  submitReactorWorkload,
  takeReactorLoadSample,
  takeShedWorkload,
} from 'internal:scheduler-native';

const entry = new URL('../realm/fixtures/hello.ts', import.meta.url).pathname;

describe('pre-init workload shedding', () => {
  it('marks, takes, resubmits, and drops pending specs', (t) => {
    const queue = createReactorQueue(false);
    t.equal(markSheddingWorkload(queue.handle), 0, 'empty queue has nothing to shed');

    const first = submitReactorWorkload(queue.handle, createWorkload(entry));
    const second = submitReactorWorkload(queue.handle, createWorkload(entry));

    const marked = markSheddingWorkload(queue.handle);
    t.equal(marked, first, 'the oldest lowest-priority spec is chosen first');
    t.equal(clearSheddingWorkload(queue.handle, marked), true, 'an in-flight mark can be cleared');
    t.equal(takeShedWorkload(queue.handle, marked), null, 'take fails once the mark is cleared');

    const remarked = markSheddingWorkload(queue.handle);
    t.equal(remarked, first, 'a cleared spec becomes markable again');
    const shed = takeShedWorkload(queue.handle, remarked);
    t.ok(shed !== null, 'a marked spec can be taken off the tail');

    t.equal(markSheddingWorkload(queue.handle), second, 'the next mark picks the remaining spec');
    t.equal(clearSheddingWorkload(queue.handle, second), true, 'second mark cleared');

    t.equal(resubmitShedWorkload(queue.handle, shed!), first, 'resubmission preserves identity');
    const remarkedAgain = markSheddingWorkload(queue.handle);
    t.equal(remarkedAgain, first, 'a resubmitted spec is markable again');
    const shedAgain = takeShedWorkload(queue.handle, remarkedAgain);
    t.ok(shedAgain !== null, 'a resubmitted spec can be taken again');

    const config = shedWorkloadConfig(shedAgain!);
    t.equal(config.entry, entry, 'shed config carries the entry path');
    t.ok(config.root.length > 0, 'shed config carries the resolved root');
    t.ok(Array.isArray(JSON.parse(config.rules)), 'rules serialize as an ImportRule[] JSON array');
    t.equal(config.watch, false, 'watch flag round-trips');
    t.equal(config.repl, false, 'repl flag round-trips');

    dropShedWorkload(shedAgain!);

    closeReactorQueue(queue.handle);
    t.ok(true, 'standalone queue closed with a pending spec still parked');
  });

  it('exposes queue depth, load samples, and heap statistics', (t) => {
    const queue = createReactorQueue(false);
    t.deepEqual(
      reactorQueueDepth(queue.handle),
      { pendingSpecs: 0, parkedLive: 0, active: 0 },
      'a fresh queue reports zero depth',
    );
    submitReactorWorkload(queue.handle, createWorkload(entry));
    const depth = reactorQueueDepth(queue.handle);
    t.equal(depth.pendingSpecs, 1, 'a submitted spec counts as pending');
    t.equal(depth.active, 0, 'nothing is active without reactor threads');
    t.deepEqual(
      takeReactorLoadSample(queue.handle),
      [],
      'no slices have run, so the load sample is empty',
    );
    const heap = isolateHeapStatistics();
    t.ok(heap.usedHeapSize > 0, 'used heap size is positive');
    t.ok(heap.heapSizeLimit > heap.usedHeapSize, 'heap limit exceeds usage');
    closeReactorQueue(queue.handle);
  });
});
