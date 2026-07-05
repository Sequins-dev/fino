/**
* Issues two scheduler-owned operations concurrently via Promise.all and records
* how long they took. If the scheduler performs a workload's queued operations in
* parallel, two 200ms delays finish in ~200ms; if it serialized them, ~400ms.
*/
import { delay } from 'internal:scheduler/ops';
import { DiskFileSystem } from 'fino:file';

export default async function schedulerParallelOpsWorker(request: {
  data: { outputPath: string };
}): Promise<{ result: string; costMicros: number }> {
  const start = Date.now();
  await Promise.all([delay(200), delay(200)]);
  const elapsedMs = Date.now() - start;
  const fs = new DiskFileSystem();
  await fs.writeFile(request.data.outputPath, new TextEncoder().encode(String(elapsedMs)));
  return { result: 'terminated', costMicros: 1 };
}
