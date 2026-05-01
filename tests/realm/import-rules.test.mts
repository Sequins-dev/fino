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
      // Deny everything — fino:ffi is blocked; fixture throws if it unexpectedly succeeds
      overrides: ImportMap.deny([]),
      entry: new URL('./fixtures/import-ffi.mts', import.meta.url).pathname,
    });
    // run() rejects only if the fixture threw (i.e. the block was absent — regression)
    try {
      await realm.run();
      t.ok(true, 'realm exited cleanly — fino:ffi was correctly blocked');
    } catch (err) {
      t.fail('fino:ffi should have been blocked but fixture threw: ' + (err as Error).message);
    }
  });

  it('deny + specific allow follows last-match-wins', async (t) => {
    const realm = new Realm({
      // Deny all, but explicitly allow fino:ffi; fixture throws if import fails
      overrides: ImportMap.deny([
        { pattern: 'fino:ffi', directive: 'inherit' },
      ]),
      entry: new URL('./fixtures/import-allowed.mts', import.meta.url).pathname,
    });
    // run() rejects if fino:ffi import failed (last-match-wins regression)
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
    try {
      await realm.run();
      t.ok(true, 'realm exited cleanly — fino:ffi was correctly blocked');
    } catch (err) {
      t.fail('fino:ffi should have been blocked but fixture threw: ' + (err as Error).message);
    }
  });
});

describe('Exact pattern beats Prefix (last-match-wins)', () => {
  it('prefix block then exact allow: exact wins', async (t) => {
    const realm = new Realm({
      // Block all fino: then re-allow ffi specifically; import-allowed throws if import fails
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
      // Allow ffi first, then block all fino: — block wins; import-ffi throws if unblocked
      overrides: ImportMap.inherit([
        { pattern: 'fino:ffi', directive: 'inherit' },
        { pattern: 'fino:*', directive: 'block' },
      ]),
      entry: new URL('./fixtures/import-ffi.mts', import.meta.url).pathname,
    });
    try {
      await realm.run();
      t.ok(true, 'realm exited cleanly — fino:ffi was correctly blocked by later prefix rule');
    } catch (err) {
      t.fail('fino:ffi should have been blocked but fixture threw: ' + (err as Error).message);
    }
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

describe('Import rules — Remap directive (positive case)', () => {
  it('Remap rewrites virtual:utils → fino:ffi and the remapped module is accessible', async (t) => {
    const realm = new Realm<() => boolean>({
      overrides: ImportMap.inherit([
        // Remap virtual:utils to fino:ffi — any import of virtual:utils resolves as fino:ffi.
        { pattern: 'virtual:utils', directive: { type: 'remap', target: 'fino:ffi' } as any },
      ]),
      entry: new URL('./fixtures/import-alias-check.mts', import.meta.url).pathname,
    });
    const result = await realm.call();
    t.ok(result === true, 'virtual:utils was remapped to fino:ffi and Pointer is accessible');
  });

  it('import of non-remapped virtual: specifier rejects (no mapping)', async (t) => {
    const realm = new Realm<() => boolean>({
      overrides: ImportMap.inherit([]),
      entry: new URL('./fixtures/import-alias-check.mts', import.meta.url).pathname,
    });
    const result = await realm.call();
    t.ok(result === false, 'virtual:utils without remap is not accessible');
  });
});

describe('Import rules — `from` clause (per-module access control)', () => {
  it('`from` clause blocks a specifier only for the specific importer', async (t) => {
    // Rule: block `fino:ffi` BUT only when imported from `fino:ffi` itself.
    // The child realm should still be able to import fino:ffi from its entry module.
    const realm = new Realm<() => boolean>({
      overrides: ImportMap.inherit([
        // Only block fino:ffi when fino:ffi itself is the importer — harmless rule
        // but verifies that `from` restricts correctly and doesn't block other importers.
        { from: 'fino:ffi', pattern: 'fino:ffi', directive: 'block' },
      ]),
      entry: new URL('./fixtures/import-ffi-check.mts', import.meta.url).pathname,
    });
    const result = await realm.call();
    t.ok(result === true, 'fino:ffi accessible from entry module (from clause did not over-block)');
  });

  it('`from` clause blocks a specifier for a matching importer', async (t) => {
    // Block fino:ffi only when the root entry module imports it.
    // Since our fixture IS the root-like entry, this should block it.
    const realm = new Realm<() => boolean>({
      overrides: ImportMap.inherit([
        // Wildcard `from` — blocks fino:ffi for any importer
        { from: '*', pattern: 'fino:ffi', directive: 'block' },
      ]),
      entry: new URL('./fixtures/import-ffi-check.mts', import.meta.url).pathname,
    });
    const result = await realm.call();
    t.ok(result === false, 'fino:ffi blocked for all importers via from: * rule');
  });
});
