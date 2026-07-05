/**
* Allocates without bound to blow past its heap cap. Without a near-heap-limit
* callback this would fatally OOM the whole process; with one, the scheduler
* terminates just this workload. It never returns on its own.
*/
export default async function schedulerHeapHogWorker(): Promise<{ result: string; costMicros: number }> {
  const held: unknown[] = [];
  for (;;) {
    held.push(new Array(50_000).fill(held.length));
  }
}
