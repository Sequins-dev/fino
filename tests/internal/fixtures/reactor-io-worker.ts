/**
* Direct-I/O tenant for the native reactor engine: reads a file `iterations`
* times through the real `fino:file` (no facade) — its readiness + reads route
* through the reactor engine on this thread. Terminates once done, so the engine
* releasing it proves direct tenant I/O worked end-to-end.
*/
import { DiskFileSystem } from 'fino:file';

export default async function ioWorker(request: {
  data: { inputPath: string; iterations?: number };
}): Promise<{ result: string; costMicros: number }> {
  const fs = new DiskFileSystem();
  const { inputPath, iterations = 1 } = request.data;
  let total = 0;
  for (let i = 0; i < iterations; i++) {
    const bytes = await fs.readFile(inputPath);
    total += bytes.byteLength;
  }
  if (total <= 0) throw new Error('direct I/O read nothing');
  return { result: 'terminated', costMicros: 1 };
}
