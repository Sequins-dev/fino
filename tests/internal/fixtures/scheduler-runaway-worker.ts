/**
* A workload that, when told, runs an unbounded synchronous loop with no await —
* the classic runaway that would otherwise pin its scheduler thread forever.
* Only the scheduler's hard-budget watchdog (V8 terminate_execution from another
* thread) can break it. With `runaway: false` it behaves normally.
*/
export default async function schedulerRunawayWorker(request: {
  data?: { runaway?: boolean };
}): Promise<{ result: string; costMicros: number }> {
  const data = request.data ?? {};
  if (data.runaway === true) {
    let x = 0;
    for (;;) {
      x = (x + 1) % 1_000_000;
    }
  }
  return { result: 'idle', costMicros: 1 };
}
