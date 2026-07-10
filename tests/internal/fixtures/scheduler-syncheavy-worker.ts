/**
* A compute-heavy workload: its first activation burns a chunk of *synchronous*
* on-CPU time (a busy loop, well under the hard runaway budget), which trips the
* scheduler's soft on-CPU threshold and gets its live isolate moved to a batch
* thread. Module state and the realm channel remain unchanged.
*/
export default async function schedulerSyncHeavyWorker(request: {
  data: { busyMs: number };
}): Promise<{ result: string; costMicros: number }> {
  const start = Date.now();
  let spin = 0;
  while (Date.now() - start < request.data.busyMs) spin = (spin + 1) % 1_000_000;
  // `spin` is consumed here only so the busy loop above can't be optimized away.
  return { result: 'idle', costMicros: 1 + (spin & 0) };
}
