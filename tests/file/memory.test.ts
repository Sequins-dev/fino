/**
 * MemoryFileSystem behaves like DiskFileSystem without touching a disk: the
 * same handles, entries, stats, and errno codes.
 */
import { describe, it } from 'fino:test/test';
import { MemoryFileSystem } from 'fino:file/memory';
import { DirEntry, FileEntry } from 'fino:file';
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return '<no error>';
  } catch (error) {
    return String((error as { code?: string }).code);
  }
}
describe('fino:file/memory', () => {
  it('seeds a tree and reads it back', async (t) => {
    const fs = new MemoryFileSystem({
      '/etc/app/config': 'debug=true',
      '/etc/app/nested/deep.txt': 'deep',
    });
    t.equal(decode(await fs.readFile('/etc/app/config')), 'debug=true', 'readFile');
    t.ok((await fs.stat('/etc/app')).isDirectory(), 'implied parents are directories');
    t.equal((await fs.stat('/etc/app/config')).size, 10, 'stat reports size');
    t.equal(await fs.realpath('/etc/./app/../app/config'), '/etc/app/config', 'realpath');
  });
  it('lists directories through the provider, not libc', async (t) => {
    const fs = new MemoryFileSystem({ '/work/a.txt': 'a', '/work/sub/b.txt': 'b' });
    const dir = await fs.dir('/work');
    t.ok(dir instanceof DirEntry, 'dir() returns the real DirEntry');
    const entries = await dir.entries();
    t.deepEqual(
      entries.map((entry) => [entry.name, entry.isDirectory()]),
      [
        ['a.txt', false],
        ['sub', true],
      ],
      'children are listed with kinds',
    );
    t.ok(entries[0] instanceof FileEntry, 'files come back as FileEntry');
    const seen: string[] = [];
    for await (const entry of dir) seen.push(entry.name);
    t.deepEqual(seen, ['a.txt', 'sub'], 'async iteration works too');
  });
  it('opens handles for reading and writing', async (t) => {
    const fs = new MemoryFileSystem();
    const file = await fs.open('/log.txt', 'w');
    const writer = file.writer();
    writer.write('started\n');
    writer.write(encode('ready\n'));
    await writer.close();
    await file.close();
    t.equal(decode(await fs.readFile('/log.txt')), 'started\nready\n', 'writes land');
    const reopened = await fs.open('/log.txt', 'r');
    t.equal(await reopened.text(), 'started\nready\n', 'text() reads it back');
    t.equal(decode(await reopened.pread(0, 7)), 'started', 'pread is positional');
    t.equal(await reopened.size(), 14n, 'size is a bigint');
    await reopened.close();
    t.equal(await codeOf(() => reopened.bytes()), 'EBADF', 'a closed handle is EBADF');
  });
  it('appends without overwriting', async (t) => {
    const fs = new MemoryFileSystem({ '/a.txt': 'one\n' });
    const file = await fs.open('/a.txt', 'a');
    await file.pwrite(0, encode('two\n'));
    await file.close();
    t.equal(decode(await fs.readFile('/a.txt')), 'one\ntwo\n', 'append ignores the offset');
  });
  it('reports POSIX errno codes', async (t) => {
    const fs = new MemoryFileSystem({ '/a.txt': 'hi', '/dir/b.txt': 'b' });
    t.equal(await codeOf(() => fs.readFile('/missing')), 'ENOENT', 'missing file');
    t.equal(await codeOf(() => fs.mkdir('/dir')), 'EEXIST', 'existing directory');
    t.equal(await codeOf(() => fs.mkdir('/no/parent')), 'ENOENT', 'missing parent');
    t.equal(await codeOf(() => fs.rmdir('/dir')), 'ENOTEMPTY', 'non-empty directory');
    t.equal(await codeOf(() => fs.unlink('/dir')), 'EISDIR', 'unlink on a directory');
    t.equal(await codeOf(() => fs.rmdir('/a.txt')), 'ENOTDIR', 'rmdir on a file');
    t.equal(await codeOf(() => fs.open('/a.txt', 'wx')), 'EEXIST', 'exclusive create');
  });
  it('renames files and whole subtrees', async (t) => {
    const fs = new MemoryFileSystem({ '/src/a.txt': 'a', '/src/deep/b.txt': 'b' });
    await fs.rename('/src', '/dst');
    t.deepEqual(
      fs.snapshot(),
      { '/dst/a.txt': 'a', '/dst/deep/b.txt': 'b' },
      'the subtree moved wholesale',
    );
    t.equal(await codeOf(() => fs.stat('/src')), 'ENOENT', 'the old path is gone');
  });
  it('follows symlinks except through lstat', async (t) => {
    const fs = new MemoryFileSystem({ '/real/a.txt': 'contents' });
    await fs.symlink('/real', '/link');
    t.equal(decode(await fs.readFile('/link/a.txt')), 'contents', 'links resolve mid-path');
    t.ok((await fs.lstat('/link')).isSymlink(), 'lstat sees the link itself');
    t.ok((await fs.stat('/link')).isDirectory(), 'stat sees the target');
    t.equal(await fs.readlink('/link'), '/real', 'readlink returns the target');
    t.equal(await fs.realpath('/link/a.txt'), '/real/a.txt', 'realpath expands it');
    await fs.symlink('/loop', '/loop');
    t.equal(await codeOf(() => fs.stat('/loop')), 'ELOOP', 'a cycle is ELOOP');
  });
  it('takes timestamps from an injected clock', async (t) => {
    let tick = 0;
    const fs = new MemoryFileSystem({ files: { '/a.txt': 'hi' }, now: () => ++tick });
    const seeded = (await fs.stat('/a.txt')).mtimeMs;
    t.ok(seeded > 0 && seeded <= tick, `the seeded file got a tick, not a wall clock: ${seeded}`);
    await fs.writeFile('/a.txt', encode('bye'));
    const after = (await fs.stat('/a.txt')).mtimeMs;
    t.ok(after > seeded, `writing advanced the clock: ${seeded} -> ${after}`);
  });
  it('supports synchronous access for native callbacks', async (t) => {
    const fs = new MemoryFileSystem({ '/db.sqlite': 'header' });
    const file = fs.openSync('/db.sqlite', 'r+');
    t.equal(decode(file.preadSync!(0, 6)), 'header', 'preadSync');
    file.pwriteSync!(6, encode('!'));
    t.equal(file.sizeSync!(), 7n, 'sizeSync reflects the write');
    file.closeSync!();
    t.equal(fs.statSync('/db.sqlite').size, 7, 'statSync');
  });
});
