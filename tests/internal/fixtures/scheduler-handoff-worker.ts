/**
* A workload that reconstructs itself from a handoff snapshot: it reads the
* pending mailbox the destination thread handed it and writes the recovered
* messages out through its (scheduler-owned) `fino:file` provider, proving the
* pending work survived the transfer end to end.
*/
import { DiskFileSystem } from 'fino:file';

export default async function schedulerHandoffWorker(request: {
  handoff?: { mailbox: Array<{ sequence: number; data: unknown }> };
  data: { outputPath: string };
}): Promise<{ result: string; costMicros: number }> {
  const fs = new DiskFileSystem();
  const mailbox = request.handoff?.mailbox ?? [];
  const recovered = mailbox.map((message) => message.data);
  await fs.writeFile(request.data.outputPath, new TextEncoder().encode(JSON.stringify(recovered)));
  return { result: 'idle', costMicros: 1 };
}
