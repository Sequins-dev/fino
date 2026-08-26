import { Realm } from 'fino:realm';
import { DiskFileSystem } from 'fino:file';
import { pid } from 'fino:process';
import * as loop from 'internal:runtime/loop';

const readyPath = `/tmp/fino-abandoned-process-${pid}`;
new Realm({
  entry: new URL('./abandoned-process-child.ts', import.meta.url).pathname,
  process: true,
  data: readyPath,
});

const fs = new DiskFileSystem();
const startupDeadline = Date.now() + 5000;
while (true) {
  try {
    await fs.unlink(readyPath);
    break;
  } catch {
    if (Date.now() >= startupDeadline) throw new Error('process Realm did not start');
    await loop.timeout(10);
  }
}
