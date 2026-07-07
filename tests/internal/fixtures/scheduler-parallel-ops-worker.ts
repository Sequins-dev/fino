/**
* Issues two concurrent async waits via Promise.all and records how long they
* took. If the reactor drives a workload's async ops in parallel, two 200ms
* timers finish in ~200ms; if it serialized them, ~400ms. The waits are ordinary
* `setTimeout`s, driven by the reactor engine's native timer.
*/
import { DiskFileSystem } from 'fino:file';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export default async function schedulerParallelOpsWorker(request: {
  data: { outputPath: string };
}): Promise<{ result: string; costMicros: number }> {
  const start = Date.now();
  await Promise.all([sleep(200), sleep(200)]);
  const elapsedMs = Date.now() - start;
  const fs = new DiskFileSystem();
  await fs.writeFile(request.data.outputPath, new TextEncoder().encode(String(elapsedMs)));
  return { result: 'terminated', costMicros: 1 };
}
