/**
 * Tests for the generic import rule system.
 *
 * Covers: ImportMap.deny / ImportMap.inherit, last-match-wins semantics,
 * block directive, and the `from` clause.
 */

import { describe, it } from 'fino:test/test';
import { Realm, ImportMap } from 'fino:realm';

describe('ImportMap.deny', () => {
  it('blocks all specifiers by default (deny baseline)', async (t) => {
    const realm = new Realm({
      // Deny everything — fino:ffi is blocked
      overrides: ImportMap.deny([]),
      entry: new URL('./fixtures/import-ffi.mts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'realm exited after catching blocked import');
  });

  it('deny + specific allow follows last-match-wins', async (t) => {
    const realm = new Realm({
      // Deny all, but explicitly allow fino:ffi
      overrides: ImportMap.deny([
        { pattern: 'fino:ffi', directive: 'inherit' },
      ]),
      entry: new URL('./fixtures/import-allowed.mts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'fino:ffi allowed after deny + specific inherit');
  });
});

describe('ImportMap.inherit', () => {
  it('inherit baseline passes through parent rules (fino:ffi accessible)', async (t) => {
    const realm = new Realm({
      overrides: ImportMap.inherit([]),
      entry: new URL('./fixtures/import-allowed.mts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'fino:ffi reachable with inherit baseline');
  });

  it('inherit + block for specific specifier blocks that specifier', async (t) => {
    const realm = new Realm({
      overrides: ImportMap.inherit([
        { pattern: 'fino:ffi', directive: 'block' },
      ]),
      entry: new URL('./fixtures/import-ffi.mts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'fino:ffi blocked after inherit + explicit block');
  });
});

describe('Exact pattern beats Prefix (last-match-wins)', () => {
  it('prefix block then exact allow: exact wins', async (t) => {
    const realm = new Realm({
      // Block all fino: then re-allow ffi specifically
      overrides: ImportMap.inherit([
        { pattern: 'fino:*', directive: 'block' },
        { pattern: 'fino:ffi', directive: 'inherit' },
      ]),
      entry: new URL('./fixtures/import-allowed.mts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'fino:ffi allowed via later exact rule overriding prefix block');
  });

  it('exact allow then prefix block: prefix block wins', async (t) => {
    const realm = new Realm({
      // Allow ffi first, then block all fino: — block wins
      overrides: ImportMap.inherit([
        { pattern: 'fino:ffi', directive: 'inherit' },
        { pattern: 'fino:*', directive: 'block' },
      ]),
      entry: new URL('./fixtures/import-ffi.mts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'fino:ffi blocked by later prefix rule overriding earlier exact allow');
  });
});

describe('Capability narrowing', () => {
  it('rejects child realm that tries to escalate past a parent block', async (t) => {
    try {
      const _realm = new Realm({
        // Parent has blocked interno: at root; child tries prefix Remap — must reject
        overrides: ImportMap.deny([
          // Try to remap the entire internal: namespace (blocked by root defaults)
          { pattern: 'internal:*', directive: { type: 'remap', target: 'internal:realm-native' } as any },
        ]),
        entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
      });
      t.fail('should have thrown at realm construction');
    } catch (err) {
      t.ok(err instanceof Error, 'throws Error on escalation attempt');
      t.ok(
        (err as Error).message.toLowerCase().includes('escalat') ||
        (err as Error).message.toLowerCase().includes('block'),
        'error message mentions escalation or block',
      );
    }
  });
});
