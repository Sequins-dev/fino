/**
 * Tests for fino:archive — zip, tar, tar.gz create/read/mutate/extract.
 */

import { describe, it, before, after } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import {
  createArchive,
  extractArchive,
  listArchive,
  openArchive,
} from 'fino:archive';

const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const TEST_DIR = '/tmp/fino-archive-test-' + Math.floor(Math.random() * 1_000_000);

async function exists(fs: DiskFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (_) {
    return false;
  }
}

async function removeTree(fs: DiskFileSystem, path: string): Promise<void> {
  if (!(await exists(fs, path))) return;
  const entry = await fs.entry(path);
  if (entry.isDirectory()) {
    const dir = await fs.dir(path);
    for (const child of await dir.entries()) {
      await removeTree(fs, child.path.toString());
    }
    await fs.rmdir(path);
    return;
  }
  await fs.unlink(path);
}

describe('fino:archive', () => {
  let fs: DiskFileSystem;

  before(async () => {
    fs = new DiskFileSystem();
    await fs.mkdir(TEST_DIR);
  });

  after(async () => {
    await removeTree(fs, TEST_DIR);
  });

  it('creates, lists, reads, and extracts zip archives', async (t) => {
    const archivePath = TEST_DIR + '/sample.zip';
    const outputDir = TEST_DIR + '/zip-out';

    const archive = await createArchive(archivePath);
    await archive.write('hello.txt', 'hello zip');
    await archive.write('nested/data.bin', new Uint8Array([1, 2, 3, 4]));
    await archive.save();
    await archive.close();

    const entries = await listArchive(archivePath);
    t.equal(entries.length, 2, 'lists two entries');
    t.equal(entries[0]?.name, 'hello.txt', 'first entry name');
    t.equal(entries[1]?.name, 'nested/data.bin', 'second entry name');

    const opened = await openArchive(archivePath);
    t.equal(await opened.readText('hello.txt'), 'hello zip', 'reads text entry');
    const bytes = await opened.read('nested/data.bin');
    t.equal(bytes.byteLength, 4, 'reads binary entry');
    t.equal(bytes[3], 4, 'binary content preserved');
    await opened.close();

    await extractArchive(archivePath, outputDir);
    t.equal(await fs.readFile(outputDir + '/hello.txt'), 'hello zip', 'extracts text file');
    const nested = await fs.open(outputDir + '/nested/data.bin', 'r');
    const nestedBytes = await nested.bytes();
    await nested.close();
    t.equal(nestedBytes[0], 1, 'extracts binary file');
    t.equal(nestedBytes[3], 4, 'extracts full binary payload');
  });

  it('buffers zip mutations until save and persists on close', async (t) => {
    const archivePath = TEST_DIR + '/mutate.zip';

    const created = await createArchive(archivePath);
    await created.write('alpha.txt', 'alpha');
    await created.close();

    const archive = await openArchive(archivePath);
    await archive.write('alpha.txt', 'beta');
    await archive.write('new.txt', 'new value');
    await archive.remove('missing.txt');

    const beforeSave = await openArchive(archivePath);
    t.equal(await beforeSave.readText('alpha.txt'), 'alpha', 'disk content unchanged before save');
    await beforeSave.close();

    await archive.save();
    await archive.close();

    const reopened = await openArchive(archivePath);
    t.equal(await reopened.readText('alpha.txt'), 'beta', 'save persists overwrite');
    t.equal(await reopened.readText('new.txt'), 'new value', 'save persists new entry');
    await reopened.remove('new.txt');
    await reopened.close();

    const afterClose = await openArchive(archivePath);
    const names = (await afterClose.entries()).map(entry => entry.name);
    t.equal(names.length, 1, 'dirty close persisted removal');
    t.equal(names[0], 'alpha.txt', 'remaining entry after dirty close');
    await afterClose.close();
  });

  it('creates, reads, and extracts tar archives', async (t) => {
    const archivePath = TEST_DIR + '/sample.tar';
    const outputDir = TEST_DIR + '/tar-out';

    const archive = await createArchive(archivePath);
    await archive.write('docs/readme.txt', 'hello tar');
    await archive.close();

    const entries = await listArchive(archivePath);
    t.equal(entries.length, 1, 'tar lists one entry');
    t.equal(entries[0]?.name, 'docs/readme.txt', 'tar entry name');

    const opened = await openArchive(archivePath);
    t.equal(await opened.readText('docs/readme.txt'), 'hello tar', 'tar readText');
    await opened.close();

    await extractArchive(archivePath, outputDir);
    t.equal(await fs.readFile(outputDir + '/docs/readme.txt'), 'hello tar', 'tar extract');
  });

  it('creates, reads, mutates, and extracts tar.gz archives', async (t) => {
    const archivePath = TEST_DIR + '/sample.tgz';
    const outputDir = TEST_DIR + '/tgz-out';

    const archive = await createArchive(archivePath);
    await archive.write('a.txt', 'one');
    await archive.write('b/c.txt', 'two');
    await archive.close();

    const opened = await openArchive(archivePath);
    t.equal(await opened.readText('a.txt'), 'one', 'tar.gz reads entry');
    await opened.rename('a.txt', 'renamed.txt');
    await opened.remove('b/c.txt');
    await opened.write('added.txt', encodeUtf8('three'));
    await opened.close();

    const reopened = await openArchive(archivePath);
    const names = (await reopened.entries()).map(entry => entry.name);
    t.equal(names.length, 2, 'tar.gz has two entries after mutation');
    t.equal(names[0], 'added.txt', 'first mutated tar.gz entry');
    t.equal(names[1], 'renamed.txt', 'second mutated tar.gz entry');
    t.equal(await reopened.readText('renamed.txt'), 'one', 'renamed entry preserved');
    await reopened.close();

    await extractArchive(archivePath, outputDir);
    t.equal(await fs.readFile(outputDir + '/renamed.txt'), 'one', 'tar.gz extract renamed file');
    t.equal(await fs.readFile(outputDir + '/added.txt'), 'three', 'tar.gz extract added file');
  });

  it('rejects traversal entries during extract', async (t) => {
    const archivePath = TEST_DIR + '/unsafe.zip';
    const outputDir = TEST_DIR + '/unsafe-out';

    const archive = await createArchive(archivePath);
    await archive.write('../escape.txt', 'nope');
    await archive.close();

    await t.rejects(
      () => extractArchive(archivePath, outputDir),
      /unsafe archive path|traversal|absolute/i,
      'extract blocks traversal paths',
    );
  });
});
