/** SQLite's null-name xOpen contract requires a usable delete-on-close file. */
import { describe, it } from 'fino:test/test';
import { ffiFunction, Pointer } from 'fino:ffi';
import { MemoryFileSystem } from 'fino:file/memory';
import { FinoVFS } from 'internal:database/sqlite/vfs';
import { cstr, requireSqlite, sqliteAvailable } from 'internal:database/sqlite/bindings';

describe('SQLite temporary file ownership', () => {
  it('initializes unnamed files, isolates their data, and deletes them on close', (t) => {
    if (!sqliteAvailable) return;
    const fs = new MemoryFileSystem();
    const vfs = new FinoVFS(fs, 'temporary-file-contract');
    vfs.register();
    const original = MemoryFileSystem.prototype.unlinkSync;
    const deleted: string[] = [];
    MemoryFileSystem.prototype.unlinkSync = function (path) {
      deleted.push(String(path));
      return original.call(this, path);
    };
    const opened: Array<{
      storage: Uint8Array;
      pointer: ArrayBuffer;
      close: (p: ArrayBuffer) => number;
    }> = [];
    try {
      const native = requireSqlite().symbols.sqlite3_vfs_find(vfs.nameCstrPointer);
      const open = ffiFunction(Pointer.readPointer(native, 40), {
        parameters: ['pointer', 'pointer', 'pointer', 'i32', 'pointer'],
        result: 'i32',
        fast: false,
      });
      const named = cstr('/named-temp');
      for (let i = 0; i < 3; i++) {
        const storage = new Uint8Array(16);
        const file = Pointer.of(storage);
        t.equal(open(native, i === 2 ? Pointer.of(named) : null, file, 2 | 4 | 8, null), 0);
        const methods = Pointer.readPointer(file, 0);
        t.ok(methods !== null, 'successful xOpen initializes pMethods');
        if (!methods) return;
        const bind = (offset: number, parameters: string[]) =>
          ffiFunction(Pointer.readPointer(methods, offset), {
            parameters,
            result: 'i32',
            fast: false,
          });
        const close = bind(8, ['pointer']);
        opened.push({ storage, pointer: file, close });
        const write = bind(24, ['pointer', 'pointer', 'i32', 'i64']);
        const read = bind(16, ['pointer', 'pointer', 'i32', 'i64']);
        const input = new Uint8Array([i + 1, 42]);
        const output = new Uint8Array(2);
        t.equal(write(file, Pointer.of(input), 2, 0n), 0);
        t.equal(read(file, Pointer.of(output), 2, 0n), 0);
        t.equal(output[0], i + 1);
      }
      t.equal(deleted.length, 0, 'temporary files remain owned until close');
      t.ok(fs.statSync('/named-temp').size > 0, 'named temporary file uses the supplied provider');
      const failed = new Uint8Array(16).fill(255);
      const missing = cstr('/missing');
      t.notEqual(open(native, Pointer.of(missing), Pointer.of(failed), 1, null), 0);
      t.equal(Pointer.readPointer(Pointer.of(failed), 0), null, 'failed open clears pMethods');
    } finally {
      for (const file of opened) t.equal(file.close(file.pointer), 0);
      t.equal(deleted.length, opened.length, 'each temporary file is removed');
      t.equal(new Set(deleted).size, deleted.length, 'temporary names are unique');
      t.throws(() => fs.statSync('/named-temp'));
      MemoryFileSystem.prototype.unlinkSync = original;
      vfs.unregister();
    }
  });
});
