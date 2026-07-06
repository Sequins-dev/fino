/**
* Loops forever doing facade file reads, so at almost any instant a host op is
* in flight. Used to exercise revoke-during-an-in-flight-host-op: the workload
* only ends when the orchestrator revokes it (terminating the isolate mid-op),
* which must not wedge the thread or leak an unhandled rejection.
*/
import { DiskFileSystem } from 'fino:file';

export default async function schedulerIoLoopWorker(request: {
  data: { readPath: string };
}): Promise<{ result: string; costMicros: number }> {
  const fs = new DiskFileSystem();
  for (;;) {
    await fs.readFile(request.data.readPath);
  }
}
