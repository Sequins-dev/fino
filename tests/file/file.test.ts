/**
* Tests for fino:file — DiskFileSystem, File, DirEntry, Stat, etc.
*/
import { describe, it, before, after } from 'fino:test/test';
import { DiskFileSystem, F_OK, R_OK } from 'fino:file';
import * as fileModule from 'fino:file';
const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | Uint8Array): string => new TextDecoder().decode(b);
const writeText = (fs: DiskFileSystem, path: string, text: string): Promise<void> => fs.writeFile(path, encodeUtf8(text));
const readText = async (fs: DiskFileSystem, path: string): Promise<string> => decodeUtf8(await fs.readFile(path));
const TEST_DIR = '/tmp/fino-file-test-' + Math.floor(Math.random() * 1e6);
describe('DiskFileSystem', () => {
  let fs: DiskFileSystem;
  before(async () => {
    fs = new DiskFileSystem();
    await fs.mkdir(TEST_DIR);
  });
  after(async () => {
    await fs.rmdir(TEST_DIR);
  });
  describe('stat / lstat', () => {
    it('fs.stat — regular file', async (t) => {
      const st = await fs.stat(TEST_DIR);
      t.ok(st.isDirectory(), 'isDirectory()');
      t.ok(!st.isFile(), '!isFile()');
      t.ok(!st.isSymlink(), '!isSymlink()');
    });
    it('fs.stat — on the test script itself', async (t) => {
      const st = await fs.stat('/etc/hosts');
      t.ok(st.isFile(), 'isFile()');
      t.ok(st.size > 0, 'size > 0');
      t.ok(st.mtimeMs > 0, 'mtimeMs > 0');
    });
    it('fs.lstat — does not follow symlink', async (t) => {
      const linkPath = TEST_DIR + '/lstat-link';
      const targetPath = '/etc/hosts';
      await fs.symlink(targetPath, linkPath);
      const lstatResult = await fs.lstat(linkPath);
      t.ok(lstatResult.isSymlink(), 'lstat sees symlink');
      const statResult = await fs.stat(linkPath);
      t.ok(statResult.isFile(), 'stat follows symlink to file');
      await fs.unlink(linkPath);
    });
  });
  describe('open / read / write / append', () => {
    it('fs.open file supports await using disposal', async (t) => {
      const path = TEST_DIR + '/using-dispose.txt';
      await writeText(fs, path, 'scoped file');
      let fileRef: any = null;
      {
        await using file = await fs.open(path, 'r');
        t.equal(await file.text(), 'scoped file', 'file is usable inside await using scope');
        t.equal(file.closed, false, 'file is open inside await using scope');
        fileRef = file;
      }
      t.equal(fileRef.closed, true, 'file closes when await using scope exits');
      await fs.unlink(path);
    });
    it('fs.open — read mode, file.text()', async (t) => {
      const path = TEST_DIR + '/read-test.txt';
      await writeText(fs, path, 'hello world');
      const file = await fs.open(path, 'r');
      const text = await file.text();
      t.equal(text, 'hello world', 'text() reads full contents');
      await file.close();
      t.ok(file.closed, 'file.closed after close()');
      await fs.unlink(path);
    });
    it('fs.open — read mode, reader() iterator', async (t) => {
      const path = TEST_DIR + '/reader-iter.txt';
      await writeText(fs, path, 'chunk data');
      const file = await fs.open(path, 'r');
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.reader()) {
        chunks.push(chunk);
      }
      t.ok(chunks.length > 0, 'received at least one chunk');
      const joined = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
      let pos = 0;
      for (const c of chunks) {
        joined.set(c, pos);
        pos += c.byteLength;
      }
      t.equal(decodeUtf8(joined), 'chunk data', 'chunks reassemble correctly');
      await file.close();
      await fs.unlink(path);
    });
    it('fs.open — reader() yields multiple chunks for files larger than the read buffer', async (t) => {
      // The read buffer is 65536 bytes. A 200 KB file must produce >1 chunk
      // AND the reassembled content must match exactly.
      const path = TEST_DIR + '/large-file.bin';
      const SIZE = 200 * 1024;
      const original = new Uint8Array(SIZE);
      // Fill with a deterministic pattern so accidental truncation is visible.
      for (let i = 0; i < SIZE; i++) original[i] = i & 255;
      await fs.writeFile(path, original);
      const file = await fs.open(path, 'r');
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.reader()) chunks.push(chunk);
      await file.close();
      t.ok(chunks.length > 1, `file yields ${chunks.length} chunks (expected >1 for 200 KiB)`);
      const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
      t.equal(totalLen, SIZE, 'total bytes received equals file size');
      // Verify content byte-by-byte to catch truncation or corruption.
      const reassembled = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of chunks) {
        reassembled.set(c, pos);
        pos += c.byteLength;
      }
      let match = true;
      for (let i = 0; i < SIZE; i++) {
        if (reassembled[i] !== (i & 255)) {
          match = false;
          break;
        }
      }
      t.ok(match, 'reassembled content matches the original large file byte-for-byte');
      await fs.unlink(path);
    });
    it('fs.open — write mode, writer().write()', async (t) => {
      const path = TEST_DIR + '/write-test.txt';
      const file = await fs.open(path, 'w');
      await file.writer().write(encodeUtf8('written'));
      await file.close();
      const readBack = await readText(fs, path);
      t.equal(readBack, 'written', 'written data reads back correctly');
      await fs.unlink(path);
    });
    it('fs.open — append mode', async (t) => {
      const path = TEST_DIR + '/append-test.txt';
      await writeText(fs, path, 'hello');
      const file = await fs.open(path, 'a');
      await file.writer().write(encodeUtf8(' world'));
      await file.close();
      const result = await readText(fs, path);
      t.equal(result, 'hello world', 'append adds to end');
      await fs.unlink(path);
    });
    it('fs.open — r+ read-write mode, split()', async (t) => {
      const path = TEST_DIR + '/split-test.txt';
      await writeText(fs, path, 'initial');
      const file = await fs.open(path, 'r');
      await file.close();
      const rw = await fs.open(path, 'r+');
      t.ok(typeof rw.split === 'function', 'split() method exists on r+ file');
      if (rw.split === undefined) throw new Error('split() should exist for r+ files');
      const [r, w] = rw.split();
      t.ok(r !== null, 'reader from split');
      t.ok(w !== null, 'writer from split');
      await rw.close();
      await fs.unlink(path);
    });
    it('file.stat() — fstat on open file', async (t) => {
      const path = TEST_DIR + '/fstat-test.txt';
      await writeText(fs, path, 'fstat test content');
      const file = await fs.open(path, 'r');
      const st = await file.stat();
      t.ok(st.isFile(), 'fstat: isFile()');
      t.ok(st.size > 0, 'fstat: size > 0');
      await file.close();
      await fs.unlink(path);
    });
    it('file.bytes() reads full file', async (t) => {
      const path = TEST_DIR + '/bytes-test.txt';
      await writeText(fs, path, 'bytes test');
      const file = await fs.open(path, 'r');
      const data = await file.bytes();
      t.ok(data instanceof Uint8Array, 'bytes() returns Uint8Array');
      t.equal(new TextDecoder().decode(data), 'bytes test', 'correct content');
      await file.close();
      await fs.unlink(path);
    });
  });
  describe('readFile / writeFile', () => {
    it('readFile returns bytes and writeFile requires byte data', async (t) => {
      const path = TEST_DIR + '/roundtrip.txt';
      await fs.writeFile(path, encodeUtf8('roundtrip data'));
      const bytes = await fs.readFile(path);
      t.ok(bytes instanceof Uint8Array, 'readFile returns Uint8Array bytes');
      t.equal(decodeUtf8(bytes), 'roundtrip data', 'caller decodes readFile bytes explicitly');
      await t.rejects(() => fs.writeFile(path, 'text data' as never), TypeError, 'writeFile rejects string data');
      await fs.unlink(path);
    });
    it('writeFile overwrites existing file', async (t) => {
      const path = TEST_DIR + '/overwrite.txt';
      await fs.writeFile(path, encodeUtf8('first'));
      await fs.writeFile(path, encodeUtf8('second'));
      t.equal(await readText(fs, path), 'second', 'second write truncates first');
      await fs.unlink(path);
    });
    it('writeFile accepts Uint8Array and ArrayBuffer data without encoding options', async (t) => {
      const typedPath = TEST_DIR + '/typed-array.bin';
      const bufferPath = TEST_DIR + '/array-buffer.bin';
      await fs.writeFile(typedPath, new Uint8Array([
        102,
        105,
        110,
        111
      ]));
      await fs.writeFile(bufferPath, new Uint8Array([106, 115]).buffer);
      t.equal(await readText(fs, typedPath), 'fino', 'Uint8Array data is written as bytes');
      t.equal(await readText(fs, bufferPath), 'js', 'ArrayBuffer data is written as bytes');
      await fs.unlink(typedPath);
      await fs.unlink(bufferPath);
    });
  });
  describe('mkdir / rmdir', () => {
    it('mkdir + rmdir', async (t) => {
      const path = TEST_DIR + '/newdir';
      await fs.mkdir(path);
      const st = await fs.stat(path);
      t.ok(st.isDirectory(), 'created directory is a directory');
      await fs.rmdir(path);
      let threw = false;
      try {
        await fs.stat(path);
      } catch {
        threw = true;
      }
      t.ok(threw, 'stat throws after rmdir');
    });
    it('mkdir is a single-directory POSIX operation, not recursive Node mkdir', async (t) => {
      const path = TEST_DIR + '/missing-parent/child';
      await t.rejects(() => fs.mkdir(path, { recursive: true } as any), (err) => (err as any)?.code === 'ENOENT', 'recursive option object does not create missing parents');
    });
  });
  describe('unlink / rename / symlink', () => {
    it('unlink removes a file', async (t) => {
      const path = TEST_DIR + '/unlink-me.txt';
      await writeText(fs, path, 'delete me');
      await fs.unlink(path);
      let threw = false;
      try {
        await fs.stat(path);
      } catch {
        threw = true;
      }
      t.ok(threw, 'stat throws after unlink');
    });
    it('rename moves a file', async (t) => {
      const src = TEST_DIR + '/rename-src.txt';
      const dst = TEST_DIR + '/rename-dst.txt';
      await writeText(fs, src, 'move me');
      await fs.rename(src, dst);
      let srcGone = false;
      try {
        await fs.stat(src);
      } catch {
        srcGone = true;
      }
      t.ok(srcGone, 'source no longer exists');
      const text = await readText(fs, dst);
      t.equal(text, 'move me', 'destination has original content');
      await fs.unlink(dst);
    });
    it('symlink + readlink', async (t) => {
      const target = '/etc/hosts';
      const linkPath = TEST_DIR + '/symlink-test';
      await fs.symlink(target, linkPath);
      const target2 = await fs.readlink(linkPath);
      t.equal(target2, target, 'readlink returns symlink target');
      await fs.unlink(linkPath);
    });
  });
  describe('DirEntry', () => {
    it('fs.dir — returns DirEntry for directory', async (t) => {
      const d = await fs.dir(TEST_DIR);
      t.ok(d !== null, 'dir() returns a DirEntry');
      t.ok(d.isDirectory(), 'DirEntry.isDirectory()');
    });
    it('DirEntry.entries — lists created files', async (t) => {
      const subDir = TEST_DIR + '/dir-entries-test';
      await fs.mkdir(subDir);
      await writeText(fs, subDir + '/alpha.txt', 'a');
      await writeText(fs, subDir + '/beta.txt', 'b');
      const d = await fs.dir(subDir);
      const list = await d.entries();
      const names = list.map((e) => e.name).sort();
      t.ok(names.includes('alpha.txt'), 'alpha.txt present');
      t.ok(names.includes('beta.txt'), 'beta.txt present');
      t.ok(!names.includes('.'), '. excluded');
      t.ok(!names.includes('..'), '.. excluded');
      for (const e of list) {
        await fs.unlink(subDir + '/' + e.name);
      }
      await fs.rmdir(subDir);
    });
    it('DirEntry.entries — returns both files and subdirectories with correct types', async (t) => {
      const mixedDir = TEST_DIR + '/mixed-entries-test';
      await fs.mkdir(mixedDir);
      await writeText(fs, mixedDir + '/file1.txt', 'data');
      await writeText(fs, mixedDir + '/file2.txt', 'data');
      await fs.mkdir(mixedDir + '/subdir');
      const d = await fs.dir(mixedDir);
      const list = await d.entries();
      t.equal(list.length, 3, 'three entries: 2 files + 1 subdirectory');
      const names = list.map((e) => e.name).sort();
      t.ok(names.includes('file1.txt'), 'file1.txt present');
      t.ok(names.includes('file2.txt'), 'file2.txt present');
      t.ok(names.includes('subdir'), 'subdir present');
      const dirEntry = list.find((e) => e.name === 'subdir')!;
      t.ok(dirEntry.isDirectory(), 'subdir entry isDirectory() === true');
      t.ok(!dirEntry.isFile(), 'subdir entry isFile() === false');
      const fileEntry = list.find((e) => e.name === 'file1.txt')!;
      t.ok(fileEntry.isFile(), 'file entry isFile() === true');
      t.ok(!fileEntry.isDirectory(), 'file entry isDirectory() === false');
      await fs.unlink(mixedDir + '/file1.txt');
      await fs.unlink(mixedDir + '/file2.txt');
      await fs.rmdir(mixedDir + '/subdir');
      await fs.rmdir(mixedDir);
    });
    it('fs.dir — throws ENOENT on non-existent path', async (t) => {
      try {
        await fs.dir(TEST_DIR + '/__nonexistent__' + Math.random());
        t.fail('should have thrown ENOENT');
      } catch (err) {
        t.ok(err instanceof Error, 'throws Error');
        t.equal((err as any).code, 'ENOENT', 'err.code is ENOENT');
      }
    });
    it('DirEntry for-await iteration', async (t) => {
      const subDir = TEST_DIR + '/forawait-test';
      await fs.mkdir(subDir);
      await writeText(fs, subDir + '/one.txt', '1');
      await writeText(fs, subDir + '/two.txt', '2');
      const d = await fs.dir(subDir);
      const names = [];
      for await (const entry of d) {
        names.push(entry.name);
      }
      t.ok(names.length === 2, 'got 2 entries');
      t.ok(names.includes('one.txt'), 'one.txt');
      t.ok(names.includes('two.txt'), 'two.txt');
      for (const n of names) {
        await fs.unlink(subDir + '/' + n);
      }
      await fs.rmdir(subDir);
    });
    it('DirEntry.child + FileEntry.open', async (t) => {
      const subDir = TEST_DIR + '/child-test';
      await fs.mkdir(subDir);
      await writeText(fs, subDir + '/child.txt', 'child content');
      const d = await fs.dir(subDir);
      const child = await d.child('child.txt');
      t.ok(child.isFile(), 'child is a file');
      t.equal(child.name, 'child.txt', 'child name');
      if (!('open' in child) || typeof child.open !== 'function') throw new Error('child entry should be openable');
      const file = await child.open('r');
      const text = await file.text();
      t.equal(text, 'child content', 'child content via FileEntry.open');
      await file.close();
      await fs.unlink(subDir + '/child.txt');
      await fs.rmdir(subDir);
    });
    it('DirEntry.mkdir + DirEntry.remove', async (t) => {
      const parent = await fs.dir(TEST_DIR);
      await parent.mkdir('direntry-sub');
      const st = await fs.stat(TEST_DIR + '/direntry-sub');
      t.ok(st.isDirectory(), 'DirEntry.mkdir creates directory');
      await parent.remove('direntry-sub');
      let threw = false;
      try {
        await fs.stat(TEST_DIR + '/direntry-sub');
      } catch {
        threw = true;
      }
      t.ok(threw, 'DirEntry.remove removes directory');
    });
    it('fs.entry — constructs correct entry type', async (t) => {
      const filePath = TEST_DIR + '/entry-file.txt';
      await writeText(fs, filePath, 'x');
      const fe = await fs.entry(filePath);
      t.ok(fe.isFile(), 'entry for file → isFile()');
      const de = await fs.entry(TEST_DIR);
      t.ok(de.isDirectory(), 'entry for dir → isDirectory()');
      await fs.unlink(filePath);
    });
  });
});
// ---------------------------------------------------------------------------
// Advanced file operations (chmod, chown, utimes, truncate, link, access, copyFile)
// ---------------------------------------------------------------------------
const ADV_DIR = '/tmp/fino-file-adv-test-' + Math.floor(Math.random() * 1e6);
describe('DiskFileSystem — advanced operations', () => {
  let fs: DiskFileSystem;
  before(async () => {
    fs = new DiskFileSystem();
    await fs.mkdir(ADV_DIR);
  });
  after(async () => {
    // Best-effort cleanup
    try {
      await fs.rmdir(ADV_DIR);
    } catch {}
  });
  it('chmod changes file permissions', async (t) => {
    const path = ADV_DIR + '/chmod-test.txt';
    await writeText(fs, path, 'data');
    await fs.chmod(path, 384);
    const st = await fs.stat(path);
    t.equal(st.mode & 511, 384, 'mode bits changed to 600');
    await fs.unlink(path);
  });
  it('chown with -1/-1 is a no-op (does not throw)', async (t) => {
    const path = ADV_DIR + '/chown-test.txt';
    await writeText(fs, path, 'data');
    await fs.chown(path, -1, -1);
    t.ok(true, 'chown(-1, -1) succeeded');
    await fs.unlink(path);
  });
  it('access resolves for an existing file with F_OK', async (t) => {
    const path = ADV_DIR + '/access-test.txt';
    await writeText(fs, path, 'data');
    await fs.access(path, F_OK);
    t.ok(true, 'access(F_OK) resolved');
    await fs.unlink(path);
  });
  it('access rejects for a nonexistent path', async (t) => {
    let threw = false;
    try {
      await fs.access(ADV_DIR + '/does-not-exist.txt', F_OK);
    } catch {
      threw = true;
    }
    t.ok(threw, 'access rejects for missing path');
  });
  it('access resolves with R_OK for a readable file', async (t) => {
    const path = ADV_DIR + '/readable.txt';
    await writeText(fs, path, 'hi');
    await fs.access(path, R_OK);
    t.ok(true, 'access(R_OK) resolved');
    await fs.unlink(path);
  });
  it('copyFile copies content and preserves mode bits', async (t) => {
    const src = ADV_DIR + '/copy-src.txt';
    const dest = ADV_DIR + '/copy-dest.txt';
    await writeText(fs, src, 'hello from src');
    await fs.chmod(src, 420);
    await fs.copyFile(src, dest);
    const content = await readText(fs, dest);
    t.equal(content, 'hello from src', 'dest has same content as src');
    const srcMode = (await fs.stat(src)).mode & 511;
    const destMode = (await fs.stat(dest)).mode & 511;
    t.equal(destMode, srcMode, 'dest has same mode as src');
    await fs.unlink(src);
    await fs.unlink(dest);
  });
  it('link creates a hard link with the same inode', async (t) => {
    const src = ADV_DIR + '/link-src.txt';
    const hard = ADV_DIR + '/link-hard.txt';
    await writeText(fs, src, 'linked');
    await fs.link(src, hard);
    const stSrc = await fs.stat(src);
    const stHard = await fs.stat(hard);
    t.equal(stSrc.ino, stHard.ino, 'hard link has same inode');
    await fs.unlink(src);
    await fs.unlink(hard);
  });
  it('utimes updates modification time', async (t) => {
    const path = ADV_DIR + '/utimes-test.txt';
    await writeText(fs, path, 'data');
    const before = (await fs.stat(path)).mtimeMs;
    const fixedDate = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(path, fixedDate, fixedDate);
    const after = (await fs.stat(path)).mtimeMs;
    t.ok(after < before, 'mtime was set to a past date');
    await fs.unlink(path);
  });
  it('truncate reduces file size to zero', async (t) => {
    const path = ADV_DIR + '/truncate-test.txt';
    await writeText(fs, path, 'some content here');
    await fs.truncate(path, 0);
    const st = await fs.stat(path);
    t.equal(st.size, 0, 'file size is 0 after truncate');
    await fs.unlink(path);
  });
});
describe('DiskFileSystem error codes', () => {
  let fs: DiskFileSystem;
  before(() => {
    fs = new DiskFileSystem();
  });
  it('stat on missing path rejects with ENOENT', async (t) => {
    try {
      await fs.stat('/tmp/__fino_no_such_file__' + Math.random());
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws Error');
      t.equal((err as any).code, 'ENOENT', 'error.code is ENOENT string');
      t.ok((err as any).path !== undefined, 'error.path is set');
    }
  });
  it('readFile on missing path rejects with ENOENT', async (t) => {
    try {
      await fs.readFile('/tmp/__fino_no_such_file__' + Math.random());
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws Error');
      t.equal((err as any).code, 'ENOENT', 'error.code is ENOENT string');
    }
  });
  it('unlink on missing path rejects with ENOENT', async (t) => {
    try {
      await fs.unlink('/tmp/__fino_no_such_file__' + Math.random());
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws Error');
      t.equal((err as any).code, 'ENOENT', 'error.code is ENOENT string');
    }
  });
  it('mkdir on existing path rejects with EEXIST', async (t) => {
    try {
      await fs.mkdir('/tmp');
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws Error');
      t.equal((err as any).code, 'EEXIST', 'error.code is EEXIST string');
    }
  });
});
describe('fino:file release contract', () => {
  it('does not expose Node fs convenience globals or rm APIs', (t) => {
    t.equal((globalThis as Record<string, unknown>).fs, undefined, 'fs is not installed on globalThis');
    t.equal((globalThis as Record<string, unknown>).Buffer, undefined, 'Buffer is not installed on globalThis');
    t.equal((fileModule as Record<string, unknown>).rm, undefined, 'fino:file does not expose rm()');
    t.equal((fileModule as Record<string, unknown>).promises, undefined, 'fino:file does not expose fs.promises');
  });
});
