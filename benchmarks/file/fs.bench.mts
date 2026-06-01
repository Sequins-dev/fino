
/**
 * Benchmarks for fino:file
 *
 * Run with: cargo run -- --bench benchmarks/file.bench.mts
 */

import { DiskFileSystem } from 'fino:file';
import { bench } from 'fino:bench';

const WRITE_PATH = '/tmp/surge_bench_file.txt';
const KB_DATA    = 'x'.repeat(1024);
const MB_DATA    = 'x'.repeat(1024 * 1024);

bench('stat', (b) => {
  b.measure('stat file',       async () => { const fs = new DiskFileSystem(); await fs.stat('/etc/hosts'); });
  b.measure('stat directory',  async () => { const fs = new DiskFileSystem(); await fs.stat('/tmp'); });
  b.measure('lstat file',      async () => { const fs = new DiskFileSystem(); await fs.lstat('/etc/hosts'); });
});

bench('open + close', (b) => {
  b.measure('open r + close', async () => {
    const fs   = new DiskFileSystem();
    const file = await fs.open('/etc/hosts', 'r');
    await file.close();
  });

  b.measure('open w + close', async () => {
    const fs   = new DiskFileSystem();
    const file = await fs.open(WRITE_PATH, 'w');
    await file.close();
  });
});

bench('readFile', (b) => {
  // /etc/hosts is always present and small (a few KB)
  b.measure('readFile /etc/hosts',   async () => { const fs = new DiskFileSystem(); await fs.readFile('/etc/hosts'); });

  b.measure('open + bytes()',  async () => {
    const fs   = new DiskFileSystem();
    const file = await fs.open('/etc/hosts', 'r');
    await file.bytes();
    await file.close();
  });

  b.measure('open + text()',   async () => {
    const fs   = new DiskFileSystem();
    const file = await fs.open('/etc/hosts', 'r');
    await file.text();
    await file.close();
  });
});

bench('writeFile', (b) => {
  b.measure('write 1KB', async () => {
    const fs = new DiskFileSystem();
    await fs.writeFile(WRITE_PATH, KB_DATA);
  });

  b.measure('write 1MB', async () => {
    const fs = new DiskFileSystem();
    await fs.writeFile(WRITE_PATH, MB_DATA);
  });
});

bench('readFile + writeFile round-trip', (b) => {
  b.measure('write 1KB + read back', async () => {
    const fs = new DiskFileSystem();
    await fs.writeFile(WRITE_PATH, KB_DATA);
    await fs.readFile(WRITE_PATH);
  });
});

bench('DiskFileSystem construction', (b) => {
  b.measure('new DiskFileSystem', () => {
    new DiskFileSystem();
  });
});
