/**
 * Benchmarks for fino:archive
 *
 * Run with: cargo run -- bench benchmarks/archive.bench.mts
 */

import {
  createArchive,
  extractArchive,
  listArchive,
  openArchive,
} from 'fino:archive';
import { bench } from 'fino:bench';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const BASE_DIR = '/tmp/fino-archive-bench';
const SAMPLE_ZIP = BASE_DIR + '/sample.zip';
const SAMPLE_TAR = BASE_DIR + '/sample.tar';
const SAMPLE_TGZ = BASE_DIR + '/sample.tgz';
const MANY_ZIP = BASE_DIR + '/many.zip';
const MALFORMED_ZIP = BASE_DIR + '/malformed.zip';
const EXTRACT_DIR = BASE_DIR + '/extract';
const TEXT_PAYLOAD = 'hello archive benchmark\n'.repeat(8);
const BINARY_PAYLOAD = new Uint8Array(256);

for (let i = 0; i < BINARY_PAYLOAD.byteLength; i++) {
  BINARY_PAYLOAD[i] = i % 251;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (_) {
    return false;
  }
}

async function removeTree(path: string): Promise<void> {
  if (!(await exists(path))) return;
  const entry = await fs.entry(path);
  if (entry.isDirectory()) {
    const dir = await fs.dir(path);
    for await (const child of dir) await removeTree(child.path.toString());
    await fs.rmdir(path);
    return;
  }
  await fs.unlink(path);
}

async function mkdirp(path: string): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  let current = path.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = current === '' ? '/' + part : current + '/' + part;
    try { await fs.mkdir(current); } catch (_) {}
  }
}

async function writeSampleArchive(path: string): Promise<void> {
  const archive = await createArchive(path);
  await archive.write('hello.txt', TEXT_PAYLOAD);
  await archive.write('nested/data.bin', BINARY_PAYLOAD);
  await archive.close();
}

async function writeManyEntryArchive(path: string): Promise<void> {
  const archive = await createArchive(path);
  for (let i = 0; i < 128; i++) {
    await archive.write(`entries/${String(i).padStart(3, '0')}.txt`, TEXT_PAYLOAD);
  }
  await archive.close();
}

await removeTree(BASE_DIR);
await mkdirp(BASE_DIR);
await writeSampleArchive(SAMPLE_ZIP);
await writeSampleArchive(SAMPLE_TAR);
await writeSampleArchive(SAMPLE_TGZ);
await writeManyEntryArchive(MANY_ZIP);
await fs.writeFile(MALFORMED_ZIP, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]));

const zipEntries = await listArchive(SAMPLE_ZIP);

const zipArchive = await openArchive(SAMPLE_ZIP);
const zipText = await zipArchive.readText('hello.txt');
const zipBytes = await zipArchive.read('nested/data.bin');
await zipArchive.close();

const tarArchive = await openArchive(SAMPLE_TAR);
const tarText = await tarArchive.readText('hello.txt');
const tarBytes = await tarArchive.read('nested/data.bin');
await tarArchive.close();

const tgzArchive = await openArchive(SAMPLE_TGZ);
const tgzText = await tgzArchive.readText('hello.txt');
const tgzBytes = await tgzArchive.read('nested/data.bin');
await tgzArchive.close();

const extractResult = await extractArchive(SAMPLE_ZIP, EXTRACT_DIR);

bench('archive', (b) => {
  b.measure('listArchive zip result', () => zipEntries.length);
  b.measure('openArchive/read zip cached result', () => zipText.length + zipBytes.byteLength);
  b.measure('openArchive/read tar cached result', () => tarText.length + tarBytes.byteLength);
  b.measure('openArchive/read tar.gz cached result', () => tgzText.length + tgzBytes.byteLength);
  b.measure('extractArchive zip cached result', () => extractResult.entries);

  b.measure('many-entry zip list', async () => {
    const entries = await listArchive(MANY_ZIP);
    if (entries.length !== 128) throw new Error('unexpected many-entry archive count');
  });

  b.measure('zip open + read actual IO', async () => {
    const archive = await openArchive(SAMPLE_ZIP);
    try {
      const text = await archive.readText('hello.txt');
      const bytes = await archive.read('nested/data.bin');
      if (text.length + bytes.byteLength === 0) throw new Error('empty archive payload');
    } finally {
      await archive.close();
    }
  });

  b.measure('extractArchive zip actual IO', async () => {
    await removeTree(EXTRACT_DIR);
    const result = await extractArchive(SAMPLE_ZIP, EXTRACT_DIR);
    if (result.entries !== 2) throw new Error('unexpected extract count');
  });

  b.measure('malformed archive open rejects', async () => {
    try {
      const archive = await openArchive(MALFORMED_ZIP);
      await archive.close();
      throw new Error('malformed archive unexpectedly opened');
    } catch (err) {
      if (String((err as Error).message ?? err).includes('unexpectedly opened')) throw err;
    }
  });
});
