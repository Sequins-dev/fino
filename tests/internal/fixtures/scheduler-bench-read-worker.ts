/**
* Benchmark tenant: reads `inputPath` `iterations` times through its
* scheduler-owned `fino:file` facade (each read is a host-op round trip:
* serialize args → scheduler performs the real read on its loop → serialize the
* bytes back → re-pump), then terminates. Used to measure the facade's per-op
* tax against a direct, non-scheduler read loop.
*/
import { DiskFileSystem } from 'fino:file';

export default async function benchReadWorker(request: {
  data: { inputPath: string; iterations: number };
}): Promise<{ result: string; costMicros: number }> {
  const fs = new DiskFileSystem();
  const { inputPath, iterations } = request.data;
  for (let i = 0; i < iterations; i++) {
    await fs.readFile(inputPath);
  }
  return { result: 'terminated', costMicros: 0 };
}
