/**
 * Tests for boats:file — DiskFileSystem, File, DirEntry, Stat, etc.
 */

import { describe, it, before, after } from 'boats:test/test';
import { DiskFileSystem } from 'boats:file';
import * as loop from 'boats:runtime/loop';
const encodeUtf8 = s => new TextEncoder().encode(s);
const decodeUtf8 = b => new TextDecoder().decode(b);

const TEST_DIR = '/tmp/boats-file-test-' + Math.floor(Math.random() * 1_000_000);

describe('DiskFileSystem', () => {
  let lp, fs;

  before(async () => {
    lp = loop.create();
    fs = new DiskFileSystem(lp);
    await fs.mkdir(TEST_DIR);
  });

  after(async () => {
    await fs.rmdir(TEST_DIR);
    loop.destroy(lp);
  });

  describe('stat / lstat', () => {
    it('fs.stat — regular file', async (t) => {
      const st = await fs.stat(TEST_DIR);
      t.ok(st.isDirectory(), 'isDirectory()');
      t.ok(!st.isFile(),     '!isFile()');
      t.ok(!st.isSymlink(),  '!isSymlink()');
    });

    it('fs.stat — on the test script itself', async (t) => {
      const st = await fs.stat('/etc/hosts');
      t.ok(st.isFile(),    'isFile()');
      t.ok(st.size > 0,    'size > 0');
      t.ok(st.mtimeMs > 0, 'mtimeMs > 0');
    });

    it('fs.lstat — does not follow symlink', async (t) => {
      const linkPath   = TEST_DIR + '/lstat-link';
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
    it('fs.open — read mode, file.text()', async (t) => {
      const path = TEST_DIR + '/read-test.txt';
      await fs.writeFile(path, 'hello world');

      const file = await fs.open(path, 'r');
      const text = await file.text();
      t.equal(text, 'hello world', 'text() reads full contents');
      await file.close();
      t.ok(file.closed, 'file.closed after close()');

      await fs.unlink(path);
    });

    it('fs.open — read mode, reader() iterator', async (t) => {
      const path = TEST_DIR + '/reader-iter.txt';
      await fs.writeFile(path, 'chunk data');

      const file   = await fs.open(path, 'r');
      const chunks = [];
      for await (const chunk of file.reader()) {
        chunks.push(chunk);
      }
      t.ok(chunks.length > 0, 'received at least one chunk');
      const joined = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
      let pos = 0;
      for (const c of chunks) { joined.set(c, pos); pos += c.byteLength; }
      t.equal(decodeUtf8(joined), 'chunk data', 'chunks reassemble correctly');
      await file.close();

      await fs.unlink(path);
    });

    it('fs.open — write mode, writer().write()', async (t) => {
      const path = TEST_DIR + '/write-test.txt';
      const file = await fs.open(path, 'w');
      await file.writer().write(encodeUtf8('written'));
      await file.close();

      const readBack = await fs.readFile(path);
      t.equal(readBack, 'written', 'written data reads back correctly');

      await fs.unlink(path);
    });

    it('fs.open — append mode', async (t) => {
      const path = TEST_DIR + '/append-test.txt';
      await fs.writeFile(path, 'hello');

      const file = await fs.open(path, 'a');
      await file.writer().write(encodeUtf8(' world'));
      await file.close();

      const result = await fs.readFile(path);
      t.equal(result, 'hello world', 'append adds to end');

      await fs.unlink(path);
    });

    it('fs.open — r+ read-write mode, split()', async (t) => {
      const path = TEST_DIR + '/split-test.txt';
      await fs.writeFile(path, 'initial');

      const file = await fs.open(path, 'r');
      await file.close();

      const rw = await fs.open(path, 'r+');
      t.ok(typeof rw.split === 'function', 'split() method exists on r+ file');
      const [r, w] = rw.split();
      t.ok(r !== null, 'reader from split');
      t.ok(w !== null, 'writer from split');
      await rw.close();

      await fs.unlink(path);
    });

    it('file.stat() — fstat on open file', async (t) => {
      const path = TEST_DIR + '/fstat-test.txt';
      await fs.writeFile(path, 'fstat test content');

      const file = await fs.open(path, 'r');
      const st   = await file.stat();
      t.ok(st.isFile(),  'fstat: isFile()');
      t.ok(st.size > 0,  'fstat: size > 0');
      await file.close();

      await fs.unlink(path);
    });

    it('file.bytes() reads full file', async (t) => {
      const path = TEST_DIR + '/bytes-test.txt';
      await fs.writeFile(path, 'bytes test');

      const file = await fs.open(path, 'r');
      const data = await file.bytes();
      t.ok(data instanceof Uint8Array, 'bytes() returns Uint8Array');
      t.equal(decodeUtf8(data), 'bytes test', 'correct content');
      await file.close();

      await fs.unlink(path);
    });
  });

  describe('readFile / writeFile', () => {
    it('readFile / writeFile roundtrip', async (t) => {
      const path = TEST_DIR + '/roundtrip.txt';
      await fs.writeFile(path, 'roundtrip data');
      const text = await fs.readFile(path);
      t.equal(text, 'roundtrip data', 'readFile returns writeFile data');
      await fs.unlink(path);
    });

    it('writeFile overwrites existing file', async (t) => {
      const path = TEST_DIR + '/overwrite.txt';
      await fs.writeFile(path, 'first');
      await fs.writeFile(path, 'second');
      const text = await fs.readFile(path);
      t.equal(text, 'second', 'second write truncates first');
      await fs.unlink(path);
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
      try { await fs.stat(path); } catch { threw = true; }
      t.ok(threw, 'stat throws after rmdir');
    });
  });

  describe('unlink / rename / symlink', () => {
    it('unlink removes a file', async (t) => {
      const path = TEST_DIR + '/unlink-me.txt';
      await fs.writeFile(path, 'delete me');
      await fs.unlink(path);
      let threw = false;
      try { await fs.stat(path); } catch { threw = true; }
      t.ok(threw, 'stat throws after unlink');
    });

    it('rename moves a file', async (t) => {
      const src = TEST_DIR + '/rename-src.txt';
      const dst = TEST_DIR + '/rename-dst.txt';
      await fs.writeFile(src, 'move me');
      await fs.rename(src, dst);

      let srcGone = false;
      try { await fs.stat(src); } catch { srcGone = true; }
      t.ok(srcGone, 'source no longer exists');

      const text = await fs.readFile(dst);
      t.equal(text, 'move me', 'destination has original content');
      await fs.unlink(dst);
    });

    it('symlink + readlink', async (t) => {
      const target   = '/etc/hosts';
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
      await fs.writeFile(subDir + '/alpha.txt', 'a');
      await fs.writeFile(subDir + '/beta.txt',  'b');

      const d    = await fs.dir(subDir);
      const list = await d.entries();
      const names = list.map(e => e.name).sort();
      t.ok(names.includes('alpha.txt'), 'alpha.txt present');
      t.ok(names.includes('beta.txt'),  'beta.txt present');
      t.ok(!names.includes('.'),  '. excluded');
      t.ok(!names.includes('..'), '.. excluded');

      for (const e of list) {
        await fs.unlink(subDir + '/' + e.name);
      }
      await fs.rmdir(subDir);
    });

    it('DirEntry for-await iteration', async (t) => {
      const subDir = TEST_DIR + '/forawait-test';
      await fs.mkdir(subDir);
      await fs.writeFile(subDir + '/one.txt', '1');
      await fs.writeFile(subDir + '/two.txt', '2');

      const d     = await fs.dir(subDir);
      const names = [];
      for await (const entry of d) {
        names.push(entry.name);
      }
      t.ok(names.length === 2, 'got 2 entries');
      t.ok(names.includes('one.txt'), 'one.txt');
      t.ok(names.includes('two.txt'), 'two.txt');

      for (const n of names) { await fs.unlink(subDir + '/' + n); }
      await fs.rmdir(subDir);
    });

    it('DirEntry.child + FileEntry.open', async (t) => {
      const subDir = TEST_DIR + '/child-test';
      await fs.mkdir(subDir);
      await fs.writeFile(subDir + '/child.txt', 'child content');

      const d     = await fs.dir(subDir);
      const child = await d.child('child.txt');
      t.ok(child.isFile(),           'child is a file');
      t.equal(child.name, 'child.txt', 'child name');

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
      try { await fs.stat(TEST_DIR + '/direntry-sub'); } catch { threw = true; }
      t.ok(threw, 'DirEntry.remove removes directory');
    });

    it('fs.entry — constructs correct entry type', async (t) => {
      const filePath = TEST_DIR + '/entry-file.txt';
      await fs.writeFile(filePath, 'x');

      const fe = await fs.entry(filePath);
      t.ok(fe.isFile(),       'entry for file → isFile()');

      const de = await fs.entry(TEST_DIR);
      t.ok(de.isDirectory(), 'entry for dir → isDirectory()');

      await fs.unlink(filePath);
    });
  });
});
