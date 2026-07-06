/**
* Tests for the scheduled-isolate native primitive (`internal:scheduler-native`).
*
* These prove the non-blocking pump contract directly, without the scheduler
* loop: a workload that awaits an as-yet-uncompleted operation parks (returns
* the `pumpPending` sentinel) instead of blocking the thread, and re-pumping
* after the completion is injected settles it.
*/
import { describe, it } from 'fino:test/test';
import { createWorkload, dispatchWorkload, completeHostOperation, terminateWorkload, workloadWakeFd } from 'internal:scheduler-native';
import { serialize, deserialize } from 'internal:serializer';

/** Completion payloads cross as internal:serializer bytes. */
function bytes(value: unknown): Uint8Array {
  return serialize(value)[0] as Uint8Array;
}

/** The pump outcome crosses back as internal:serializer bytes. */
function pump(handle: number, requestJson: string): { pumpPending?: boolean; result?: string; costMicros?: number } {
  return deserialize(dispatchWorkload(handle, requestJson)) as { pumpPending?: boolean; result?: string; costMicros?: number };
}

const parkWorker = new URL('./fixtures/scheduler-park-worker.ts', import.meta.url).pathname;

describe('scheduled isolate pump', () => {
  it('parks on a pending completion instead of blocking, then settles when injected', (t) => {
    const handle = createWorkload(parkWorker);
    try {
      const first = pump(handle, JSON.stringify({ data: { awaitId: 7 } }));
      t.equal(first.pumpPending, true, 'first pump parks rather than blocking');

      completeHostOperation(handle, 7, true, bytes(41));

      const second = pump(handle, '{}');
      t.deepEqual(second, { result: 'idle', costMicros: 41 }, 're-pump settles the injected completion');
    } finally {
      terminateWorkload(handle);
    }
  });

  it('exposes a valid wake fd for the isolate', (t) => {
    const handle = createWorkload(parkWorker);
    try {
      t.equal(workloadWakeFd(handle) >= 0, true, 'wake fd is a real descriptor');
      t.equal(workloadWakeFd(9999), -1, 'invalid handle returns -1');
    } finally {
      terminateWorkload(handle);
    }
  });

  it('keeps two parked isolates independent', (t) => {
    const a = createWorkload(parkWorker);
    const b = createWorkload(parkWorker);
    try {
      t.equal(pump(a, JSON.stringify({ data: { awaitId: 1 } })).pumpPending, true);
      t.equal(pump(b, JSON.stringify({ data: { awaitId: 1 } })).pumpPending, true);

      // Completing A's operation must not settle B.
      completeHostOperation(a, 1, true, bytes(10));
      t.deepEqual(pump(a, '{}'), { result: 'idle', costMicros: 10 });
      t.equal(pump(b, '{}').pumpPending, true, 'B stays parked');

      completeHostOperation(b, 1, true, bytes(20));
      t.deepEqual(pump(b, '{}'), { result: 'idle', costMicros: 20 });
    } finally {
      terminateWorkload(a);
      terminateWorkload(b);
    }
  });
});
