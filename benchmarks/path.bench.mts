
/**
 * Benchmarks for fino:path
 *
 * Run with: cargo run -- --bench benchmarks/path.bench.mjs
 */

import { Path, join, resolve, normalize, relative, dirname, basename, extname, isAbsolute } from 'fino:path';
import { bench } from 'fino:bench';

bench('module-level functions', (b) => {
  b.group('join', (g) => {
    g.measure('2 segments',  () => join('/usr/local', 'bin'));
    g.measure('4 segments',  () => join('/usr', 'local', 'lib', 'node_modules'));
    g.measure('with dotdot', () => join('/a/b/c', '..', 'd'));
  });

  b.group('resolve', (g) => {
    g.measure('absolute only',  () => resolve('/home', 'user', 'docs'));
    g.measure('with relative',  () => resolve('/a', 'b', 'c'));
    g.measure('abs override',   () => resolve('/a', 'b', '/c', 'd'));
  });

  b.group('normalize', (g) => {
    g.measure('clean path',     () => normalize('/a/b/c'));
    g.measure('double slashes', () => normalize('/a//b///c'));
    g.measure('dot segments',   () => normalize('/a/./b/./c'));
    g.measure('dotdot',         () => normalize('/a/b/../c/./d'));
    g.measure('trailing slash', () => normalize('/a/b/c/'));
  });

  b.group('relative', (g) => {
    g.measure('same dir',      () => relative('/a/b', '/a/b/c/d'));
    g.measure('diverge',       () => relative('/a/b/c', '/a/x/y'));
    g.measure('root to deep',  () => relative('/', '/a/b/c/d/e'));
  });

  b.group('decomposition', (g) => {
    g.measure('dirname',    () => dirname('/usr/local/bin/node'));
    g.measure('basename',   () => basename('/usr/local/bin/node'));
    g.measure('extname',    () => extname('/path/to/file.tar.gz'));
    g.measure('isAbsolute', () => isAbsolute('/usr/local'));
  });
});

bench('Path class', (b) => {
  b.group('construction', (g) => {
    g.measure('new Path',    () => new Path('/usr/local/bin'));
    g.measure('Path.from str', () => Path.from('/usr/local/bin'));
    g.measure('Path.from Path', { setup: () => new Path('/usr/local'), fn: (p) => Path.from(p) });
  });

  b.group('methods', (g) => {
    const p = new Path('/usr/local/lib');
    g.measure('join',      () => p.join('node_modules', 'pkg'));
    g.measure('resolve',   () => p.resolve('../bin'));
    g.measure('relative',  () => p.relative(new Path('/usr/local/bin')));
    g.measure('normalize', () => new Path('/a/b/../c').normalize());
    g.measure('dirname',   () => p.dirname());
    g.measure('basename',  () => p.basename());
    g.measure('extname',   () => new Path('/file.tar.gz').extname());
    g.measure('isAbsolute', () => p.isAbsolute());
    g.measure('toString',  () => p.toString());
  });

  b.group('Path class vs module functions', (g) => {
    const p = new Path('/usr');
    g.measure('module join',  () => join('/usr', 'local', 'bin'));
    g.measure('Path.join',    () => p.join('local', 'bin'));
  });
});
