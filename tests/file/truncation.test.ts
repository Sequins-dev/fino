/** Regular file EOF must remain observable when another writer truncates it. */
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { timeout } from 'internal:runtime/loop';

describe('File reads during truncation', () => {
  // Process entrypoints now use the same reactor driver; there is no separate
  // process-main JavaScript event loop to exercise here.

  for (const afterChunk of [false, true]) {
    it(`observes EOF after truncation ${afterChunk ? 'between chunks' : 'before the first chunk'}`, async (t) => {
      const fs = new DiskFileSystem();
      const path = `/tmp/fino-truncation-${Math.random()}.bin`;
      const size = 128 * 1024;
      await fs.writeFile(path, new Uint8Array(size));
      try {
        await using file = await fs.open(path, 'r+');
        const reader = file.reader()[Symbol.asyncIterator]();
        if (afterChunk) t.equal((await reader.next()).done, false);
        file.truncateSync(afterChunk ? 65536 : 0);
        const pending = reader.next();
        const deadline = timeout(100);
        let result;
        try {
          result = await Promise.race([pending, deadline.then(() => null)]);
        } finally {
          deadline.cancel();
          // Release the pre-fix readiness wait so a failing regression cleans
          // up its handle instead of hanging the runner itself.
          if (result === null) file.truncateSync(size);
          await pending;
        }
        t.notEqual(result, null, 'EOF cannot depend on future bytes arriving');
        if (result !== null) t.equal(result.done, true);
      } finally {
        await fs.unlink(path);
      }
    });
  }
  it('reads the current whole-file contents and reports read failures', async (t) => {
    const fs = new DiskFileSystem();
    const path = `/tmp/fino-truncation-bytes-${Math.random()}.bin`;
    const bytes = new Uint8Array(128 * 1024).fill(7);
    await fs.writeFile(path, bytes);
    try {
      t.deepEqual(await fs.readFile(path), bytes, 'whole-file reads span multiple chunks');
      await using file = await fs.open(path, 'r+');
      file.truncateSync(0);
      t.equal((await file.bytes()).byteLength, 0, 'whole-file reads observe current EOF');
      await using directory = await fs.open('/tmp', 'r');
      await t.rejects(
        () => directory.bytes(),
        /EISDIR/,
        'read errors are not silently returned as empty data',
      );
    } finally {
      await fs.unlink(path);
    }
  });
});
