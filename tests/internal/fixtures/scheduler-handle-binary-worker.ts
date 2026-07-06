/**
* Writes the full 0..255 byte range through the scheduler-owned file *handle*
* paths — `pwrite` (positional) and the buffered `write`/`flush` — so a test can
* prove request-side binary survives the serializer transport on those paths,
* not just whole-file `writeFile`.
*/
import { DiskFileSystem } from 'fino:file';

export default async function schedulerHandleBinaryWorker(request: {
  data: { pwritePath: string; writePath: string };
}): Promise<{ result: string; costMicros: number }> {
  const fs = new DiskFileSystem();
  const payload = new Uint8Array(256);
  for (let i = 0; i < 256; i++) payload[i] = i;

  const positional = await fs.open(request.data.pwritePath, 'w');
  await positional.pwrite(0, payload);
  await positional.close();

  const buffered = await fs.open(request.data.writePath, 'w');
  buffered.write(payload);
  await buffered.close();

  return { result: 'terminated', costMicros: 1 };
}
