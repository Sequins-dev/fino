/**
 * Contract tests for the web globals registry.
 *
 * The bootstrap imports `internal:globals/global` and installs each public
 * export on `globalThis`. Internal helper exports may stay module-only.
 */

import { describe, it } from 'fino:test/test';
import * as globals from 'internal:globals/global';

const moduleRecord = globals as Record<string, unknown>;
const globalRecord = globalThis as Record<string, unknown>;

describe('internal:globals/global registry', () => {
  it('installs every public registry export on globalThis', (t) => {
    const skippedInternal = new Set(['_flushPorts']);
    const names = Object.keys(moduleRecord).filter((name) => !skippedInternal.has(name));
    names.sort();

    t.ok(names.length > 0, 'registry has public exports');

    for (const name of names) {
      t.ok(name in globalRecord, `${name} is installed on globalThis`);
      t.equal(globalRecord[name], moduleRecord[name], `${name} matches registry export`);
    }
  });

  it('keeps internal helper exports off globalThis', (t) => {
    t.equal(typeof moduleRecord._flushPorts, 'function', '_flushPorts remains importable for bootstrap');
    t.equal(globalRecord._flushPorts, undefined, '_flushPorts is not installed globally');
  });

  it('does not add timer/performance facade exports to the registry', (t) => {
    for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance']) {
      t.equal(moduleRecord[name], undefined, `${name} is installed by the time facade, not the global registry`);
      t.ok(typeof globalRecord[name] !== 'undefined', `${name} is available on globalThis`);
    }
  });
});
