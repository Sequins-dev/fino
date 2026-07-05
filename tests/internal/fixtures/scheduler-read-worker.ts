/**
* Reads a file through its scheduler-owned `fino:file` provider (the result
* crosses back as internal:serializer bytes) and writes exactly those bytes to a
* second path — so a test can prove binary survived the facade read round-trip.
*/
import { DiskFileSystem } from 'fino:file';

export default async function schedulerReadWorker(request: {
  data: { inputPath: string; outputPath: string };
}): Promise<{ result: string; costMicros: number }> {
  const fs = new DiskFileSystem();
  const bytes = await fs.readFile(request.data.inputPath);
  await fs.writeFile(request.data.outputPath, bytes);
  return { result: 'terminated', costMicros: 1 };
}
