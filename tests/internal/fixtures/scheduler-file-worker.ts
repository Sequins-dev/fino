// Runs inside a scheduler-managed tenant isolate. `fino:file` is remapped to the
// scheduler-backed provider, so every operation here is performed by the
// scheduler on the tenant's behalf — the tenant never touches the filesystem
// directly. Exercises whole-file ops, metadata, a directory, and an open handle.
import { DiskFileSystem } from 'fino:file';

export default async function schedulerFileWorker(request: {
  data: { inputPath: string; outputPath: string; dir: string; handlePath: string; marker: string };
}): Promise<{
  result: 'idle';
  costMicros: number;
  size: number;
  handleText: string;
  dirNames: string[];
}> {
  const fs = new DiskFileSystem();
  const { inputPath, outputPath, dir, handlePath, marker } = request.data;

  const input = new TextDecoder().decode(await fs.readFile(inputPath));
  await fs.writeFile(outputPath, new TextEncoder().encode(`${marker}:${input}`));
  const stat = await fs.stat(outputPath);

  await fs.mkdir(dir);
  await fs.writeFile(`${dir}/a.txt`, new TextEncoder().encode('a'));
  await fs.writeFile(`${dir}/b.txt`, new TextEncoder().encode('b'));
  const entries = await fs.dir(dir);
  const dirNames = (await entries.entries()).map((e) => e.name).sort();

  // Open handle: write via the handle, then read it back through pread.
  const handle = await fs.open(handlePath, 'w');
  handle.write(new TextEncoder().encode('handle-'));
  handle.write('data');
  await handle.close();
  const reopened = await fs.open(handlePath, 'r');
  const handleText = new TextDecoder().decode(await reopened.bytes());
  await reopened.close();

  return {
    result: 'idle',
    costMicros: Number(stat.size),
    size: Number(stat.size),
    handleText,
    dirNames
  };
}
