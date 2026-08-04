/** A guest written against fino:file, unaware it may be simulated. */
import { DiskFileSystem, Stat } from 'fino:file';
export default async function run(): Promise<{
  config: string;
  statSize: number;
  statIsFile: boolean;
  statIsDir: boolean;
  listing: { name: string; dir: boolean }[];
  afterRename: string;
  missingCode: string;
  wroteLog: boolean;
}> {
  const fs = new DiskFileSystem();
  const config = new TextDecoder().decode(await fs.readFile('/etc/app/config'));
  const stat: Stat = await fs.stat('/etc/app/config');
  const dirStat = await fs.stat('/etc/app');
  const dir = await fs.dir('/etc/app');
  const listing: { name: string; dir: boolean }[] = [];
  for await (const entry of dir) listing.push({ name: entry.name, dir: entry.isDirectory() });
  const file = await fs.open('/var/log/app.log', 'w');
  const writer = file.writer();
  writer.write('started\n');
  writer.write('ready\n');
  await file.close();
  await fs.writeFile('/tmp/scratch', new TextEncoder().encode('draft'));
  await fs.rename('/tmp/scratch', '/tmp/final');
  const afterRename = new TextDecoder().decode(await fs.readFile('/tmp/final'));
  await fs.unlink('/tmp/final');
  let missingCode = '';
  try {
    await fs.readFile('/tmp/final');
  } catch (err) {
    missingCode = (err as { code?: string }).code ?? 'none';
  }
  return {
    config,
    statSize: stat.size,
    statIsFile: stat.isFile(),
    statIsDir: dirStat.isDirectory(),
    listing,
    afterRename,
    missingCode,
    wroteLog: (await fs.stat('/var/log/app.log')).size > 0,
  };
}
