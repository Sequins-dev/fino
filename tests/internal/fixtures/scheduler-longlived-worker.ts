/**
* A long-lived workload: it processes one message per activation and returns
* `idle` to park until the next wake, keeping its isolate (and module-level
* state) alive across wakes — the WebSocket/SSE connection model. It writes its
* running activation count out through its scheduler-owned `fino:file` provider,
* and only terminates once it has handled `until` wakes (default very large, so
* it parks indefinitely until revoked).
*/
import { DiskFileSystem } from 'fino:file';

let count = 0;

export default async function schedulerLonglivedWorker(request: {
  data: { outputPath: string; until?: number };
}): Promise<{ result: string; costMicros: number }> {
  count++;
  const fs = new DiskFileSystem();
  await fs.writeFile(request.data.outputPath, new TextEncoder().encode(String(count)));
  const until = request.data.until ?? Number.MAX_SAFE_INTEGER;
  return { result: count >= until ? 'terminated' : 'idle', costMicros: 1 };
}
