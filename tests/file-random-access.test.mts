import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { os } from 'internal:process';

const tmpDir = os === 'darwin' ? '/tmp' : '/tmp';
const testFile = `${tmpDir}/fino-file-rnd-${Date.now()}.bin`;
const fs = new DiskFileSystem();

describe('FileHandle — random-access methods', () => {
  it('pwrite + pread round-trip', async (t) => {
    const f    = await fs.open(testFile, 'w+');
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    const n    = await f.pwrite(0, data);
    t.equal(n, 5, 'wrote 5 bytes');

    const got = await f.pread(0, 5);
    t.deepEqual(Array.from(got), [10, 20, 30, 40, 50], 'pread returns what was written');
    await f.close();
    await fs.unlink(testFile);
  });

  it('pread at offset', async (t) => {
    const f    = await fs.open(testFile, 'w+');
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await f.pwrite(0, data);

    const mid = await f.pread(2, 4);
    t.deepEqual(Array.from(mid), [3, 4, 5, 6], 'reads correct slice');
    await f.close();
    await fs.unlink(testFile);
  });

  it('size() returns current file size', async (t) => {
    const f    = await fs.open(testFile, 'w+');
    const data = new Uint8Array(100);
    await f.pwrite(0, data);

    const sz = await f.size();
    t.equal(sz, 100n, 'size is 100');
    await f.close();
    await fs.unlink(testFile);
  });

  it('truncate() shrinks the file', async (t) => {
    const f    = await fs.open(testFile, 'w+');
    await f.pwrite(0, new Uint8Array(200));
    await f.truncate(50);

    const sz = await f.size();
    t.equal(sz, 50n, 'size is 50 after truncate');
    await f.close();
    await fs.unlink(testFile);
  });

  it('sync() completes without error', async (t) => {
    const f = await fs.open(testFile, 'w+');
    await f.pwrite(0, new Uint8Array([1, 2, 3]));
    await f.sync();
    t.ok(true, 'sync did not throw');
    await f.close();
    await fs.unlink(testFile);
  });

  it('pread returns partial data near EOF', async (t) => {
    const f    = await fs.open(testFile, 'w+');
    await f.pwrite(0, new Uint8Array([1, 2, 3]));

    const got = await f.pread(1, 10);   // request more than available
    t.ok(got.byteLength <= 10, 'does not exceed requested length');
    t.ok(got.byteLength >= 2,  'returns at least the bytes present');
    await f.close();
    await fs.unlink(testFile);
  });

  it('pwrite at non-zero offset', async (t) => {
    const f = await fs.open(testFile, 'w+');
    await f.pwrite(0,  new Uint8Array([0, 0, 0, 0, 0]));
    await f.pwrite(2,  new Uint8Array([9, 8]));

    const got = await f.pread(0, 5);
    t.deepEqual(Array.from(got), [0, 0, 9, 8, 0], 'offset write is correct');
    await f.close();
    await fs.unlink(testFile);
  });
});
