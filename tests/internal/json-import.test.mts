/**
 * Tests for JSON import support.
 */

import { describe, it } from 'boats:test/test';
import config from '../fixtures/test-config.json';
import configNoExt from '../fixtures/test-config';

describe('JSON imports', () => {
  it('imports a JSON file as a default export', (t) => {
    t.ok(config !== null && typeof config === 'object', 'default export is an object');
    t.equal(config.name, 'boats', 'name field');
    t.equal(config.version, '1.0.0', 'version field');
    t.equal(config.nested.key, 'value', 'nested key');
    t.equal(config.nested.count, 42, 'nested count');
    t.deepEqual(config.tags, ['fast', 'async', 'rust'], 'tags array');
    t.equal(config.enabled, true, 'boolean field');
    t.equal(config.ratio, 3.14, 'number field');
    t.equal(config.nothing, null, 'null field');
  });

  it('extension probing resolves .json without explicit extension', (t) => {
    t.ok(configNoExt !== null && typeof configNoExt === 'object', 'resolved without extension');
    t.equal(configNoExt.name, 'boats', 'same data as explicit import');
  });
});
