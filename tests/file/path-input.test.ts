import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Path } from 'fino:file/path';
import { _toRawStr, _toStr, _toPath } from 'internal:file/bindings';

describe('filesystem path inputs', () => {
  it('rejects invalid inputs before coercion or filesystem access', async (t) => {
    let coerced = false;
    const object = {
      toString() {
        coerced = true;
        return '/tmp/invalid-path';
      },
    };
    for (const input of [undefined, null, 42, true, 1n, Symbol('path'), object]) {
      for (const convert of [_toRawStr, _toStr, _toPath]) {
        t.throws(() => convert(input as never), TypeError);
      }
      await t.rejects(() => new DiskFileSystem().stat(input as never), TypeError);
      await t.rejects(() => new DiskFileSystem().open(input as never), TypeError);
    }
    t.equal(coerced, false, 'invalid objects cannot run coercion hooks');
  });

  it('preserves valid strings, Path values, and relative symlink targets', (t) => {
    t.equal(_toRawStr('../target'), '../target');
    t.equal(_toRawStr(new Path('/tmp/target')), '/tmp/target');
    t.equal(_toStr('/tmp/target'), '/tmp/target');
    t.equal(_toPath('/tmp/target').toString(), '/tmp/target');
  });
});
