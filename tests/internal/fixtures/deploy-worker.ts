/**
* A run-once tenant workload deployed through the orchestrator. It writes its
* message out through its (scheduler-owned) `fino:file` provider and reports
* `terminated`, so the scheduler releases it once its single dispatch completes.
*/
import { DiskFileSystem } from 'fino:file';

export default async function deployWorker(request: {
  data: { outputPath: string; message: string };
}): Promise<{ result: string; costMicros: number }> {
  const fs = new DiskFileSystem();
  await fs.writeFile(request.data.outputPath, new TextEncoder().encode(request.data.message));
  return { result: 'terminated', costMicros: 1 };
}
