/**
* A stateful workload that survives a live handoff. It accumulates the sourceId
* of every wake into a module-level mailbox (writing it to `seedPath` so a test
* can observe progress deterministically). On `drain` it serializes the mailbox
* for the snapshot; on the destination thread it restores the mailbox from the
* handoff snapshot, writes proof (restored mailbox plus a marker) to
* `outputPath`, and terminates — proving the pending state crossed the boundary.
*/
import { DiskFileSystem } from 'fino:file';

let mailbox: string[] = [];

export default async function schedulerHandoffWorker(request: {
  drain?: boolean;
  handoff?: { mailbox: Array<{ sequence: number; data: unknown }> };
  wake?: { sourceId: string };
  data: { outputPath: string; seedPath: string };
}): Promise<{ result: string; costMicros: number; mailbox?: Array<{ sequence: number; data: unknown }> }> {
  if (request.drain === true) {
    return { result: 'drained', costMicros: 1, mailbox: mailbox.map((data, sequence) => ({ sequence, data })) };
  }
  const fs = new DiskFileSystem();
  if (request.handoff !== undefined && Array.isArray(request.handoff.mailbox)) {
    mailbox = request.handoff.mailbox.map((message) => String(message.data));
    await fs.writeFile(request.data.outputPath, new TextEncoder().encode(JSON.stringify([...mailbox, 'reconstructed'])));
    return { result: 'terminated', costMicros: 1 };
  }
  if (request.wake !== undefined) mailbox.push(request.wake.sourceId);
  await fs.writeFile(request.data.seedPath, new TextEncoder().encode(JSON.stringify(mailbox)));
  return { result: 'idle', costMicros: 1 };
}
