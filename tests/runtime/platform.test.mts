/**
 * Tests for fino:process — platform info fields (formerly fino:platform).
 */

import { describe, it } from 'fino:test/test';
import { os, arch, argv } from 'fino:runtime/process';

describe('platform info', () => {
  it('os is a non-empty string', (t) => {
    t.equal(typeof os, 'string');
    t.ok(os.length > 0, 'os is non-empty');
  });

  it('arch is a non-empty string', (t) => {
    t.equal(typeof arch, 'string');
    t.ok(arch.length > 0, 'arch is non-empty');
  });

  it('os is a known platform', (t) => {
    const known = ['darwin', 'linux', 'windows', 'freebsd', 'unknown'];
    t.ok(known.includes(os), 'os is known: ' + os);
  });

  it('arch is a known architecture', (t) => {
    const known = ['x86_64', 'aarch64', 'x86', 'arm', 'unknown'];
    t.ok(known.includes(arch), 'arch is known: ' + arch);
  });

  it('argv is an array with at least one entry', (t) => {
    t.ok(Array.isArray(argv), 'argv is an Array');
    t.ok(argv.length >= 1, 'argv has at least the binary name');
    t.equal(typeof argv[0], 'string', 'argv[0] is a string');
  });
});
