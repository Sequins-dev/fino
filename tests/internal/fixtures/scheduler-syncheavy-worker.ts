/**
* A compute-heavy workload: its first activation burns a chunk of *synchronous*
* on-CPU time (a busy loop, well under the hard runaway budget), which trips the
* scheduler's soft on-CPU threshold and gets it migrated to a batch thread. It
* supports drain (nothing to preserve) and, once reconstructed on the batch
* thread, simply parks — so a test can observe where it landed.
*/
export default async function schedulerSyncHeavyWorker(request: {
  drain?: boolean;
  handoff?: unknown;
  data: { busyMs: number };
}): Promise<{ result: string; costMicros: number; mailbox?: unknown[] }> {
  if (request.drain === true) return { result: 'drained', costMicros: 1, mailbox: [] };
  if (request.handoff !== undefined) return { result: 'idle', costMicros: 1 };
  const start = Date.now();
  let spin = 0;
  while (Date.now() - start < request.data.busyMs) spin = (spin + 1) % 1_000_000;
  return { result: 'idle', costMicros: spin === -1 ? 1 : 1 };
}
