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

  // ---------------------------------------------------------------------------
  // Security regression tests (A1, A2, A3 fixes)
  // ---------------------------------------------------------------------------

  it('A1: tar extraction silently skips symlink/hardlink entries (typeflag 1 and 2)', async (t) => {
    // Craft a raw tar archive with a symlink entry (typeflag=50='2') followed by
    // a normal file entry. The symlink entry must be skipped; the file must extract.
    const enc = new TextEncoder();

    function tarHeader(name: string, size: number, typeflag: number): Uint8Array {
      const hdr = new Uint8Array(512);
      const nameBytes = enc.encode(name.slice(0, 99));
      hdr.set(nameBytes, 0);
      // mode
      const modeStr = '0000644\0';
      hdr.set(enc.encode(modeStr), 100);
      // size (octal)
      const sizeOctal = size.toString(8).padStart(11, '0') + '\0';
      hdr.set(enc.encode(sizeOctal), 124);
      // mtime
      const mtimeOctal = '00000000000\0';
      hdr.set(enc.encode(mtimeOctal), 136);
      // typeflag
      hdr[156] = typeflag;
      // checksum placeholder
      hdr.fill(0x20, 148, 156);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += hdr[i]!;
      const chk = sum.toString(8).padStart(6, '0') + '\0 ';
      hdr.set(enc.encode(chk), 148);
      return hdr;
    }

    const fileContent = enc.encode('safe file content');
    const fileSize = fileContent.length;
    const filePadded = Math.ceil(fileSize / 512) * 512;

    // Entry 1: symlink (typeflag=50='2'), size 0
    const symlinkHdr = tarHeader('link-target.txt', 0, 50);
    // Entry 2: regular file (typeflag=48='0')
    const fileHdr = tarHeader('safe.txt', fileSize, 48);
    const filePaddedBytes = new Uint8Array(filePadded);
    filePaddedBytes.set(fileContent);
    // Terminal: two zero blocks
    const terminal = new Uint8Array(1024);

    const totalLen = 512 + 512 + filePadded + 1024;
    const tarBytes = new Uint8Array(totalLen);
    let off = 0;
    tarBytes.set(symlinkHdr, off); off += 512;          // symlink header (no data block)
    tarBytes.set(fileHdr, off); off += 512;             // file header
    tarBytes.set(filePaddedBytes, off); off += filePadded; // file data
    tarBytes.set(terminal, off);                         // terminal blocks

    const archivePath = TEST_DIR + '/symlink-tar.tar';
    const outputDir   = TEST_DIR + '/symlink-tar-out';
    await fs.mkdir(outputDir);
    await fs.writeFile(archivePath, tarBytes);

    await extractArchive(archivePath, outputDir);

    // The safe file should be extracted
    t.equal(await fs.readFile(outputDir + '/safe.txt'), 'safe file content', 'regular file extracted');
    // The symlink entry must NOT have created a file
    let symlinkFileExists = false;
    try { await fs.stat(outputDir + '/link-target.txt'); symlinkFileExists = true; } catch (_) {}
    t.ok(!symlinkFileExists, 'symlink entry was skipped — no file created');
  });

  it('A2: tar extraction throws when an entry exceeds MAX_DECOMPRESSED_BYTES', async (t) => {
    // Craft a tar header claiming a file of 600 MiB (> 512 MiB limit).
    // parseTar checks size before slicing so this throws without OOM.
    const enc = new TextEncoder();
    const hdr = new Uint8Array(512);
    const nameBytes = enc.encode('huge.bin');
    hdr.set(nameBytes, 0);
    hdr.set(enc.encode('0000644\0'), 100);
    // 600 MiB in octal
    const hugeSizeOctal = (600 * 1024 * 1024).toString(8).padStart(11, '0') + '\0';
    hdr.set(enc.encode(hugeSizeOctal), 124);
    hdr.set(enc.encode('00000000000\0'), 136);
    hdr[156] = 48; // regular file
    hdr.fill(0x20, 148, 156);
    let sum = 0; for (let i = 0; i < 512; i++) sum += hdr[i]!;
    hdr.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);

    // The archive consists of just this header (the data block would be huge,
    // but parseTar checks size before reading data, so we can omit the data blocks
    // and just add the terminal blocks).
    const terminal = new Uint8Array(1024);
    const tarBytes = new Uint8Array(512 + 1024);
    tarBytes.set(hdr, 0);
    tarBytes.set(terminal, 512);

    const archivePath = TEST_DIR + '/huge-tar.tar';
    const outputDir   = TEST_DIR + '/huge-tar-out';
    await fs.mkdir(outputDir);
    await fs.writeFile(archivePath, tarBytes);

    await t.rejects(
      () => extractArchive(archivePath, outputDir),
      /limit|exceeding|512|bytes/i,
      'extract throws for entries exceeding the decompressed-size limit',
    );
  });

  it('A3: extract() unlinks pre-placed symlinks before writing', async (t) => {
    const archivePath = TEST_DIR + '/overwrite.zip';
    const outputDir   = TEST_DIR + '/overwrite-out';
    await fs.mkdir(outputDir);

    // Archive contains a single file 'data.txt' with known content.
    const archive = await createArchive(archivePath);
    await archive.write('data.txt', 'real content from archive');
    await archive.close();

    // Place a symlink at the expected output path pointing to a different file.
    const victim = TEST_DIR + '/victim.txt';
    await fs.writeFile(victim, 'original victim');
    await fs.symlink(victim, outputDir + '/data.txt');

    await extractArchive(archivePath, outputDir);

    // The symlink should have been replaced with the real file.
    const content = await fs.readFile(outputDir + '/data.txt');
    t.equal(content, 'real content from archive', 'archive content written to output path');
    // Victim file must not have been overwritten.
    const victimContent = await fs.readFile(victim);
    t.equal(victimContent, 'original victim', 'victim file was NOT modified (symlink was unlinked)');
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
