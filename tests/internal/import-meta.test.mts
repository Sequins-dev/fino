/**
 * Tests for import.meta enrichment.
 *
 * import.meta provides per-module metadata:
 *   url       — file:// URL of the module
 *   filename  — absolute filesystem path
 *   dirname   — parent directory of the module
 *   resolve() — resolves a specifier relative to this module's location
 */

import { describe, it } from 'fino:test/test';

const meta = import.meta as ImportMeta & {
  filename: string;
  dirname: string;
  resolve(specifier: string): string;
};

// The test file itself is the module under test — import.meta refers to this file.
const thisFile = meta.filename;
const thisDir  = meta.dirname;
const thisUrl  = meta.url;

describe('properties', () => {
  it('import.meta.url is a file:// URL', (t) => {
    t.ok(typeof thisUrl === 'string', 'url is a string');
    t.ok(thisUrl.startsWith('file://'), 'url starts with file://');
    t.ok(thisUrl.endsWith('import-meta.test.mts'), 'url ends with module filename');
  });

  it('import.meta.filename is an absolute path', (t) => {
    t.ok(typeof thisFile === 'string', 'filename is a string');
    t.ok(thisFile.startsWith('/'), 'filename is absolute');
    t.ok(thisFile.endsWith('import-meta.test.mts'), 'filename ends with module filename');
  });

  it('import.meta.dirname is the parent directory', (t) => {
    t.ok(typeof thisDir === 'string', 'dirname is a string');
    t.ok(thisDir.startsWith('/'), 'dirname is absolute');
    // dirname should not include the filename
    t.ok(!thisDir.endsWith('import-meta.test.mjs'), 'dirname does not include filename');
    // filename should start with dirname
    t.ok(thisFile.startsWith(thisDir + '/'), 'filename is inside dirname');
  });

  it('import.meta.url matches file:// + filename', (t) => {
    t.equal(thisUrl, 'file://' + thisFile, 'url == file:// + filename');
  });
});

describe('resolve()', () => {
  it('import.meta.resolve is a function', (t) => {
    t.ok(typeof meta.resolve === 'function', 'resolve is a function');
  });

  it('import.meta.resolve resolves a relative path', (t) => {
    const resolved = meta.resolve('./typescript.test.mts');
    t.ok(resolved.startsWith('file://'), 'resolved URL starts with file://');
    t.ok(resolved.endsWith('typescript.test.mts'), 'resolved URL ends with typescript.test.mts');
  });

  it('import.meta.resolve resolves an absolute path', (t) => {
    const resolved = meta.resolve(thisFile);
    t.equal(resolved, 'file://' + thisFile, 'absolute path resolves to file:// URL');
  });

  it('import.meta.resolve passes through fino: specifiers', (t) => {
    const resolved = meta.resolve('fino:test/test');
    t.equal(resolved, 'fino:test/test', 'fino: specifier returned as-is');
  });

  it('import.meta.resolve throws on non-existent path', async (t) => {
    await t.rejects(
      async () => meta.resolve('./definitely-does-not-exist-xyz.mjs'),
      /Cannot resolve/,
      'throws on missing file',
    );
  });
});
