/** Objective-C bridge contracts; native calls are gated to Apple arm64. */
import { describe, it } from 'fino:test/test';
import { dlopen, structType } from 'fino:ffi';
import { os, arch } from 'fino:process';
import { Realm } from 'fino:realm';
const supported = os === 'darwin' && arch === 'aarch64';
describe('Objective-C runtime bridge', () => {
  it('imports without opening an unavailable runtime', async (t) => {
    const objc = await import('internal:objc');
    t.equal(objc.available(), supported);
    if (!supported) t.throws(() => objc.getClass('NSObject'), /unavailable/);
  });
  it('rejects embedded NUL names', async (t) => {
    const objc = await import('internal:objc');
    t.throws(() => objc.selector('description\0other'), /NUL/);
    t.throws(() => objc.getClass('NSObject\0other'), /NUL/);
  });
  it('rejects async and variadic message bindings before native access', async (t) => {
    const objc = await import('internal:objc');
    for (const option of [{ async: true }, { nonblocking: true }, { variadic: 2 }]) {
      t.throws(
        () => objc.bindMessage({ parameters: [], result: 'void', ...option }),
        /synchronous concrete/,
      );
    }
  });
  it('uses independent scopes in concurrent scheduled Realms', { skip: !supported }, async (t) => {
    const source = `
      import { dlopen } from 'fino:ffi';
      import { getClass, selector, bindMessage, withAutoreleasePool } from 'internal:objc';
      const foundation = dlopen('/System/Library/Frameworks/Foundation.framework/Foundation', {});
      const send = bindMessage({ parameters: [], result: 'pointer' });
      export default async function run() {
        for (let i = 0; i < 5; i++) {
          withAutoreleasePool(() => {
            const value = send(getClass('NSObject'), selector('new'));
            send(value, selector('autorelease'));
            withAutoreleasePool(() => send(value, selector('description')));
          });
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        return Boolean(foundation);
      }
    `;
    const realms = Array.from({ length: 4 }, () => Realm.fromSource(source));
    try {
      t.deepEqual(await Promise.all(realms.map((realm) => realm.call())), [true, true, true, true]);
    } finally {
      for (const realm of realms) realm.terminate();
    }
  });
  it(
    'looks up classes and binds concrete scalar and struct signatures',
    { skip: !supported },
    async (t) => {
      const objc = await import('internal:objc');
      const foundation = dlopen('/System/Library/Frameworks/Foundation.framework/Foundation', {});
      const string = objc.getClass('NSString');
      t.ok(string);
      t.equal(objc.getClass('FinoMissingObjectiveCClass'), null);
      t.equal(objc.selector('length'), objc.selector('length'));
      const create = objc.bindMessage({ parameters: ['buffer'], result: 'pointer' });
      const length = objc.bindMessage({ parameters: [], result: 'usize' });
      const rangeType = structType([
        ['location', 'usize'],
        ['length', 'usize'],
      ]);
      const range = objc.bindMessage({ parameters: ['pointer'], result: rangeType });
      objc.withAutoreleasePool(() => {
        const value = create(
          string,
          objc.selector('stringWithUTF8String:'),
          new TextEncoder().encode('hello\0'),
        );
        t.equal(length(value, objc.selector('length')), 5);
        const result = range(value, objc.selector('rangeOfString:'), value);
        const view = new DataView(result.buffer ?? result, result.byteOffset ?? 0);
        t.equal(view.getBigUint64(0, true), 0n);
        t.equal(view.getBigUint64(8, true), 5n);
      });
      t.ok(foundation);
    },
  );
  it(
    'drains pools on success and throw, and retains objects across scopes',
    { skip: !supported },
    async (t) => {
      const objc = await import('internal:objc');
      const foundation = dlopen('/System/Library/Frameworks/Foundation.framework/Foundation', {});
      const weak = dlopen('/usr/lib/libobjc.A.dylib', {
        objc_initWeak: { parameters: ['buffer', 'pointer'], result: 'pointer' },
        objc_destroyWeak: { parameters: ['buffer'], result: 'void' },
      });
      const send = objc.bindMessage({ parameters: [], result: 'pointer' });
      for (const throws of [false, true]) {
        const slot = new BigUint64Array(1);
        try {
          const action = () =>
            objc.withAutoreleasePool(() => {
              const value = send(objc.getClass('NSObject'), objc.selector('new'));
              weak.symbols.objc_initWeak(slot, value);
              send(value, objc.selector('autorelease'));
              t.ok(slot[0] !== 0n);
              if (throws) throw new Error('pool fixture');
              return 42;
            });
          if (throws) t.throws(action, /pool fixture/);
          else t.equal(action(), 42);
          t.equal(slot[0], 0n, 'autoreleased object was deallocated');
        } finally {
          weak.symbols.objc_destroyWeak(slot);
        }
      }
      const slot = new BigUint64Array(1);
      const retained = objc.withAutoreleasePool(() => {
        const value = send(objc.getClass('NSObject'), objc.selector('new'));
        weak.symbols.objc_initWeak(slot, value);
        send(value, objc.selector('autorelease'));
        return objc.retain(value);
      });
      try {
        t.ok(slot[0] !== 0n, 'retain survives the pool');
        objc.release(retained);
        t.equal(slot[0], 0n, 'explicit release deallocates');
      } finally {
        weak.symbols.objc_destroyWeak(slot);
      }
      t.throws(() => objc.withAutoreleasePool(() => Promise.resolve()), /synchronous/);
      t.ok(foundation);
    },
  );
});
