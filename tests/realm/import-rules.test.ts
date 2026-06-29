/**
* Tests for the generic import rule system.
*
* Covers: ImportMap.deny / ImportMap.inherit, last-match-wins semantics,
* block directive, and the `from` clause.
*/
import { describe, it } from 'fino:test/test';
import { Realm, ImportMap } from 'fino:realm';
describe('Realm import policy precedence', () => {
  it('overrides take precedence over legacy blocked specifiers', async (t) => {
    const realm = Realm.fromSource([
      'import { Pointer } from \'fino:ffi\';',
      'export default () => Pointer !== undefined;',
      ''
    ].join('\n'), {
      overrides: ImportMap.inherit([{
        pattern: 'fino:ffi',
        directive: 'inherit'
      }]),
      blocked: ['fino:ffi']
    });
    t.equal(await realm.call(), true, 'blocked is ignored when overrides are present');
  });
  it('legacy blocked specifiers apply when overrides are absent', async (t) => {
    const realm = new Realm({
      blocked: ['fino:ffi'],
      entry: new URL('./fixtures/import-ffi.ts', import.meta.url).pathname
    });
    await realm.run();
    t.ok(true, 'blocked applies in legacy policy mode');
  });
  it('overrides take precedence over legacy provider conversion', (t) => {
    const throwingProviders = { fs: { toRules(): never {
      throw new Error('legacy provider conversion should not run');
    } } };
    const realm = Realm.fromSource('export default () => true;\n', {
      overrides: ImportMap.inherit([]),
      providers: throwingProviders as any
    });
    t.ok(realm instanceof Realm, 'realm constructs without converting legacy providers');
  });
  it('legacy provider conversion is used when overrides are absent', (t) => {
    const throwingProviders = { fs: { toRules(): never {
      throw new Error('legacy provider conversion ran');
    } } };
    t.throws(() => Realm.fromSource('export default () => true;\n', { providers: throwingProviders as any }), /legacy provider conversion ran/, 'providers are converted in legacy policy mode');
  });
});
describe('ImportMap.deny', () => {
  it('prepends a block-all default before caller rules', (t) => {
    t.deepEqual(ImportMap.deny([{
      pattern: 'fino:ffi',
      directive: 'inherit'
    }]).toRules(), [{
      pattern: '*',
      directive: 'block'
    }, {
      pattern: 'fino:ffi',
      directive: 'inherit'
    }], 'deny starts from a safe block-all baseline');
  });
  it('blocks all specifiers by default (deny baseline)', async (t) => {
    const realm = new Realm({
      overrides: ImportMap.deny([]),
      entry: new URL('./fixtures/import-ffi.ts', import.meta.url).pathname
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
      overrides: ImportMap.deny([{
        pattern: 'fino:ffi',
        directive: 'inherit'
      }]),
      entry: new URL('./fixtures/import-allowed.ts', import.meta.url).pathname
    });
    // run() rejects if fino:ffi import failed (last-match-wins regression)
    await realm.run();
    t.ok(true, 'fino:ffi allowed after deny + specific inherit');
  });
});
describe('ImportMap.inherit', () => {
  it('prepends an inherit-all default before caller rules', (t) => {
    t.deepEqual(ImportMap.inherit([{
      pattern: 'fino:ffi',
      directive: 'block'
    }]).toRules(), [{
      pattern: '*',
      directive: 'inherit'
    }, {
      pattern: 'fino:ffi',
      directive: 'block'
    }], 'inherit starts from an explicit inherit baseline');
  });
  it('inherit baseline passes through parent rules (fino:ffi accessible)', async (t) => {
    const realm = new Realm({
      overrides: ImportMap.inherit([]),
      entry: new URL('./fixtures/import-allowed.ts', import.meta.url).pathname
    });
    await realm.run();
    t.ok(true, 'fino:ffi reachable with inherit baseline');
  });
  it('inherit + block for specific specifier blocks that specifier', async (t) => {
    const realm = new Realm({
      overrides: ImportMap.inherit([{
        pattern: 'fino:ffi',
        directive: 'block'
      }]),
      entry: new URL('./fixtures/import-ffi.ts', import.meta.url).pathname
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
  it('stores duplicate rules in caller order for last-match-wins evaluation', (t) => {
    t.deepEqual(new ImportMap([{
      pattern: 'fino:ffi',
      directive: 'block'
    }, {
      pattern: 'fino:ffi',
      directive: 'inherit'
    }]).toRules(), [{
      pattern: 'fino:ffi',
      directive: 'block'
    }, {
      pattern: 'fino:ffi',
      directive: 'inherit'
    }], 'ImportMap preserves rule order');
  });
  it('prefix block then exact allow: exact wins', async (t) => {
    const realm = new Realm({
      overrides: ImportMap.inherit([{
        pattern: 'fino:*',
        directive: 'block'
      }, {
        pattern: 'fino:ffi',
        directive: 'inherit'
      }]),
      entry: new URL('./fixtures/import-allowed.ts', import.meta.url).pathname
    });
    await realm.run();
    t.ok(true, 'fino:ffi allowed via later exact rule overriding prefix block');
  });
  it('exact allow then prefix block: prefix block wins', async (t) => {
    const realm = new Realm({
      overrides: ImportMap.inherit([{
        pattern: 'fino:ffi',
        directive: 'inherit'
      }, {
        pattern: 'fino:*',
        directive: 'block'
      }]),
      entry: new URL('./fixtures/import-ffi.ts', import.meta.url).pathname
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
        overrides: ImportMap.deny([(
        // Try to remap the entire internal: namespace (blocked by root defaults)
        {
          pattern: 'internal:*',
          directive: {
            type: 'remap',
            target: 'internal:realm-native'
          } as any
        })]),
        entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname
      });
      t.fail('should have thrown at realm construction');
    } catch (err) {
      t.ok(err instanceof Error, 'throws Error on escalation attempt');
      t.ok((err as Error).message.toLowerCase().includes('escalat') || (err as Error).message.toLowerCase().includes('block'), 'error message mentions escalation or block');
    }
  });
});
describe('Import rules — Remap directive (positive case)', () => {
  it('Remap rewrites virtual:utils → fino:ffi and the remapped module is accessible', async (t) => {
    const realm = new Realm<() => boolean>({
      overrides: ImportMap.inherit([(
      // Remap virtual:utils to fino:ffi — any import of virtual:utils resolves as fino:ffi.
      {
        pattern: 'virtual:utils',
        directive: {
          type: 'remap',
          target: 'fino:ffi'
        } as any
      })]),
      entry: new URL('./fixtures/import-alias-check.ts', import.meta.url).pathname
    });
    const result = await realm.call();
    t.ok(result === true, 'virtual:utils was remapped to fino:ffi and Pointer is accessible');
  });
  it('import of non-remapped virtual: specifier rejects (no mapping)', async (t) => {
    const realm = new Realm<() => boolean>({
      overrides: ImportMap.inherit([]),
      entry: new URL('./fixtures/import-alias-check.ts', import.meta.url).pathname
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
      overrides: ImportMap.inherit([(
      // Only block fino:ffi when fino:ffi itself is the importer — harmless rule
      // but verifies that `from` restricts correctly and doesn't block other importers.
      {
        from: 'fino:ffi',
        pattern: 'fino:ffi',
        directive: 'block'
      })]),
      entry: new URL('./fixtures/import-ffi-check.ts', import.meta.url).pathname
    });
    const result = await realm.call();
    t.ok(result === true, 'fino:ffi accessible from entry module (from clause did not over-block)');
  });
  it('`from` clause blocks a specifier for a matching importer', async (t) => {
    // Block fino:ffi only when the root entry module imports it.
    // Since our fixture IS the root-like entry, this should block it.
    const realm = new Realm<() => boolean>({
      overrides: ImportMap.inherit([(
      // Wildcard `from` — blocks fino:ffi for any importer
      {
        from: '*',
        pattern: 'fino:ffi',
        directive: 'block'
      })]),
      entry: new URL('./fixtures/import-ffi-check.ts', import.meta.url).pathname
    });
    const result = await realm.call();
    t.ok(result === false, 'fino:ffi blocked for all importers via from: * rule');
  });
});
