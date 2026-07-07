/**
* Minimal compute-only tenant for the native reactor engine loop test: does a
* little synchronous work and terminates. No I/O, so it validates the engine's
* place → pump → settle(terminated) → release path without needing direct I/O.
*/
export default async function computeWorker(request: {
  data: { iterations?: number };
}): Promise<{ result: string; costMicros: number }> {
  const iterations = request.data?.iterations ?? 1000;
  let sum = 0;
  for (let i = 0; i < iterations; i++) sum += i;
  if (sum < 0) throw new Error('unreachable');
  return { result: 'terminated', costMicros: 1 };
}
