/**
* Tests for fino:path — Path class and module-level helpers.
*/
import { describe, it } from 'fino:test/test';
import { Path, join, resolve, normalize, dirname, basename, extname, isAbsolute, relative, sep } from 'fino:file/path';
describe('Constructor / coercion', () => {
  it('constructs from string', (t) => {
    const p = new Path('/usr/local/bin');
    t.equal(p.toString(), '/usr/local/bin');
  });
  it('constructs from another Path', (t) => {
    const a = new Path('/foo/bar');
    const b = new Path(a);
    t.equal(b.toString(), '/foo/bar');
  });
  it('Path.from — passes Path through', (t) => {
    const a = new Path('/x/y');
    const b = Path.from(a);
    t.ok(a === b, 'same reference');
  });
  it('Path.from — wraps string', (t) => {
    const p = Path.from('/x/y');
    t.ok(p instanceof Path);
    t.equal(p.toString(), '/x/y');
  });
  it('template literal coercion', (t) => {
    const p = new Path('/a/b');
    t.equal(`${p}`, '/a/b');
  });
  it('toJSON', (t) => {
    const p = new Path('/a/b');
    t.equal(p.toJSON(), '/a/b');
  });
  it('Path.from — accepts string or Path uniformly', (t) => {
    const a = Path.from('/x/y/z');
    const b = Path.from(a);
    t.equal(a.toString(), b.toString());
  });
});
describe('sep', () => {
  it('is / on POSIX', (t) => {
    t.equal(sep, '/');
  });
  it('does not implement Windows drive or namespace path semantics on POSIX', (t) => {
    const drivePath = String.raw`C:\temp\file.txt`;
    const dottedDrivePath = String.raw`C:\temp\..\file.txt`;
    t.equal(isAbsolute(drivePath), false, 'drive-letter paths are not absolute on POSIX');
    t.equal(normalize(dottedDrivePath).toString(), dottedDrivePath, 'backslashes are ordinary characters on POSIX');
    t.equal(basename(drivePath), drivePath, 'backslashes are not path separators on POSIX');
  });
});
describe('basename', () => {
  it('simple file', (t) => {
    t.equal(new Path('/usr/local/bin/node').basename(), 'node');
  });
  it('trailing slash ignored', (t) => {
    t.equal(new Path('/usr/local/').basename(), 'local');
  });
  it('root', (t) => {
    t.equal(new Path('/').basename(), '');
  });
  it('no directory', (t) => {
    t.equal(new Path('file.txt').basename(), 'file.txt');
  });
  it('with suffix', (t) => {
    t.equal(new Path('/src/index.mjs').basename('.mjs'), 'index');
  });
  it('suffix not present', (t) => {
    t.equal(new Path('/src/index.mjs').basename('.js'), 'index.mjs');
  });
  it('basename() module fn', (t) => {
    t.equal(basename('/a/b/c.txt'), 'c.txt');
    t.equal(basename('/a/b/c.txt', '.txt'), 'c');
  });
});
describe('extname', () => {
  it('.mjs', (t) => {
    t.equal(new Path('/src/index.mjs').extname(), '.mjs');
  });
  it('double extension', (t) => {
    t.equal(new Path('/archive.tar.gz').extname(), '.gz');
  });
  it('no extension', (t) => {
    t.equal(new Path('/usr/bin/node').extname(), '');
  });
  it('hidden file (leading dot)', (t) => {
    t.equal(new Path('/home/user/.bashrc').extname(), '');
  });
  it('hidden file with ext', (t) => {
    t.equal(new Path('/home/user/.config.json').extname(), '.json');
  });
  it('extname() module fn', (t) => {
    t.equal(extname('/foo/bar.ts'), '.ts');
  });
});
describe('dirname', () => {
  it('typical path', (t) => {
    t.equal(new Path('/usr/local/bin').dirname().toString(), '/usr/local');
  });
  it('trailing slash ignored', (t) => {
    t.equal(new Path('/usr/local/bin/').dirname().toString(), '/usr/local');
  });
  it('single segment', (t) => {
    t.equal(new Path('/usr').dirname().toString(), '/');
  });
  it('root', (t) => {
    t.equal(new Path('/').dirname().toString(), '/');
  });
  it('relative path', (t) => {
    t.equal(new Path('a/b/c').dirname().toString(), 'a/b');
  });
  it('relative single segment', (t) => {
    t.equal(new Path('file.txt').dirname().toString(), '.');
  });
  it('dirname() module fn', (t) => {
    t.ok(dirname('/a/b/c') instanceof Path);
    t.equal(dirname('/a/b/c').toString(), '/a/b');
  });
});
describe('isAbsolute', () => {
  it('absolute path', (t) => {
    t.equal(new Path('/etc/hosts').isAbsolute(), true);
  });
  it('relative path', (t) => {
    t.equal(new Path('relative/path').isAbsolute(), false);
  });
  it('dot-relative', (t) => {
    t.equal(new Path('./foo').isAbsolute(), false);
  });
  it('isAbsolute() module fn', (t) => {
    t.equal(isAbsolute('/a'), true);
    t.equal(isAbsolute('a'), false);
  });
});
describe('normalize', () => {
  it('collapses double slashes', (t) => {
    t.equal(new Path('/a//b').normalize().toString(), '/a/b');
  });
  it('resolves dots', (t) => {
    t.equal(new Path('/a/./b').normalize().toString(), '/a/b');
  });
  it('resolves double dots', (t) => {
    t.equal(new Path('/a/b/../c').normalize().toString(), '/a/c');
  });
  it('relative with double dots', (t) => {
    t.equal(new Path('a/b/../../c').normalize().toString(), 'c');
  });
  it('double dots at relative root stay', (t) => {
    t.equal(new Path('../a').normalize().toString(), '../a');
  });
  it('empty string becomes dot', (t) => {
    t.equal(new Path('').normalize().toString(), '.');
  });
  it('normalize() module fn', (t) => {
    t.equal(normalize('/a/b/../c').toString(), '/a/c');
  });
});
describe('join', () => {
  it('simple join', (t) => {
    t.equal(new Path('/usr').join('local', 'bin').toString(), '/usr/local/bin');
  });
  it('normalizes result', (t) => {
    t.equal(new Path('/a').join('b', '..', 'c').toString(), '/a/c');
  });
  it('with Path segment', (t) => {
    t.equal(new Path('/usr').join(new Path('local')).toString(), '/usr/local');
  });
  it('join() module fn — multiple segments', (t) => {
    t.equal(join('/a', 'b', 'c').toString(), '/a/b/c');
  });
  it('join() module fn — relative', (t) => {
    t.equal(join('a', 'b', 'c').toString(), 'a/b/c');
  });
  it('join() module fn — normalizes dots', (t) => {
    t.equal(join('a', './b', '../c').toString(), 'a/c');
  });
});
describe('resolve', () => {
  it('absolute path wins from right', (t) => {
    t.equal(new Path('c').resolve('/a', '/b').toString(), '/b/c');
  });
  it('stops at first absolute base from right', (t) => {
    t.equal(new Path('c').resolve('/base').toString(), '/base/c');
  });
  it('multiple relative stays relative', (t) => {
    t.equal(new Path('c').resolve('a', 'b').toString(), 'a/b/c');
  });
  it('resolve() module fn — right-to-left', (t) => {
    t.equal(resolve('/a', 'b', 'c').toString(), '/a/b/c');
  });
  it('resolve() module fn — later absolute overrides', (t) => {
    t.equal(resolve('/a', '/b', 'c').toString(), '/b/c');
  });
});
describe('relative', () => {
  it('sibling directory', (t) => {
    const p = new Path('/a/b/c');
    t.equal(p.relative('/a/b/d').toString(), '../c');
  });
  it('deeper path', (t) => {
    const p = new Path('/a/b/c/d');
    t.equal(p.relative('/a/b').toString(), 'c/d');
  });
  it('same path', (t) => {
    const p = new Path('/a/b');
    t.equal(p.relative('/a/b').toString(), '.');
  });
  it('relative() module fn', (t) => {
    const r = relative('/a/b', '/a/b/c/d');
    t.ok(r instanceof Path);
    t.equal(r.toString(), 'c/d');
  });
});
describe('Chaining', () => {
  it('chained normalize + dirname', (t) => {
    const p = new Path('/usr/local/share/../lib/node_modules/pkg/index.js');
    t.equal(p.normalize().dirname().toString(), '/usr/local/lib/node_modules/pkg');
  });
  it('join then extname / basename', (t) => {
    const p = new Path('/project/src').join('index.ts');
    t.equal(p.extname(), '.ts');
    t.equal(p.basename('.ts'), 'index');
  });
});
