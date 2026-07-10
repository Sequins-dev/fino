/**
* A stateful workload that survives a live isolate move. It accumulates the
* sourceId of every wake in module memory. The post-move wake writes the same
* mailbox and terminates, proving no application checkpoint protocol ran.
*/
import { DiskFileSystem } from 'fino:file';

let mailbox: string[] = [];

export default async function schedulerHandoffWorker(request: {
  wake?: { sourceId: string };
  data: { outputPath: string; seedPath: string };
}): Promise<{ result: string; costMicros: number }> {
  const fs = new DiskFileSystem();
  if (request.wake !== undefined) mailbox.push(request.wake.sourceId);
  if (request.wake?.sourceId === 'after-move') {
    await fs.writeFile(request.data.outputPath, new TextEncoder().encode(JSON.stringify([...mailbox, 'live-isolate'])));
    return { result: 'terminated', costMicros: 1 };
  }
  await fs.writeFile(request.data.seedPath, new TextEncoder().encode(JSON.stringify(mailbox)));
  return { result: 'idle', costMicros: 1 };
}
