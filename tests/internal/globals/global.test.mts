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
  it('aliases self to globalThis and exposes a minimal navigator', (t) => {
    t.equal(globalThis.self, globalThis, 'self aliases globalThis');

    const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
    t.equal(selfDescriptor?.writable, true, 'self is writable');
    t.equal(selfDescriptor?.configurable, true, 'self is configurable');

    t.equal(typeof navigator, 'object', 'navigator is installed');
    t.equal(navigator.userAgent, 'Fino/0.1', 'navigator exposes the Fino user agent');
    t.equal((navigator as { hardwareConcurrency?: unknown }).hardwareConcurrency, undefined, 'navigator has no hardwareConcurrency shim');

    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    t.equal(navigatorDescriptor?.writable, true, 'navigator is writable');
    t.equal(navigatorDescriptor?.configurable, true, 'navigator is configurable');
  });

  it('does not install Node process or browser rejection-event globals', (t) => {
    t.equal((globalThis as { process?: unknown }).process, undefined, 'global process is intentionally absent');
    t.equal((globalThis as { onunhandledrejection?: unknown }).onunhandledrejection, undefined, 'onunhandledrejection is not installed');
    t.equal((globalThis as { onrejectionhandled?: unknown }).onrejectionhandled, undefined, 'onrejectionhandled is not installed');
  });

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
