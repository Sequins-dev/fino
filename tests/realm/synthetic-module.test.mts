import { describe, it } from 'fino:test/test';
import { SyntheticModule } from 'fino:module';
import { Realm } from 'fino:realm';

describe('SyntheticModule — install/import/uninstall lifecycle', () => {
  it('value export is accessible after install', async (t) => {
    const mod = new SyntheticModule('testValues', { answer: 42, greeting: 'hello' });
    mod.install();
    try {
      const ns = await import('testValues') as { answer: number; greeting: string };
      t.equal(ns.answer, 42);
      t.equal(ns.greeting, 'hello');
    } finally {
      mod.uninstall();
    }
  });

  it('function export is callable after install', async (t) => {
    const add = (a: number, b: number) => a + b;
    const mod = new SyntheticModule('testFunctions', { add });
    mod.install();
    try {
      const ns = await import('testFunctions') as { add: (a: number, b: number) => number };
      t.equal(ns.add(3, 4), 7);
    } finally {
      mod.uninstall();
    }
  });

  it('function returning AsyncIterable works by identity', async (t) => {
    async function* counter(n: number) {
      for (let i = 0; i < n; i++) yield i;
    }
    const mod = new SyntheticModule('testStream', { counter });
    mod.install();
    try {
      const ns = await import('testStream') as { counter: (n: number) => AsyncGenerator<number> };
      const results: number[] = [];
      for await (const v of ns.counter(3)) results.push(v);
      t.deepEqual(results, [0, 1, 2]);
    } finally {
      mod.uninstall();
    }
  });

  it('function accepting AsyncIterable works by identity', async (t) => {
    async function collectAll(source: AsyncIterable<number>): Promise<number[]> {
      const result: number[] = [];
      for await (const v of source) result.push(v);
      return result;
    }
    const mod = new SyntheticModule('testSink', { collectAll });
    mod.install();
    try {
      const ns = await import('testSink') as { collectAll: (src: AsyncIterable<number>) => Promise<number[]> };
      async function* gen() { yield 10; yield 20; yield 30; }
      const result = await ns.collectAll(gen());
      t.deepEqual(result, [10, 20, 30]);
    } finally {
      mod.uninstall();
    }
  });
});

describe('SyntheticModule — prefix rejection', () => {
  it('fino: prefix throws', (t) => {
    const mod = new SyntheticModule('fino:foo', {});
    t.throws(() => mod.install(), /reserved for builtins/);
  });

  it('internal: prefix throws', (t) => {
    const mod = new SyntheticModule('internal:foo', {});
    t.throws(() => mod.install(), /reserved for builtins/);
  });

  it('app: prefix throws', (t) => {
    const mod = new SyntheticModule('app:foo', {});
    t.throws(() => mod.install(), /reserved for builtins/);
  });

  it('virtual: prefix throws', (t) => {
    const mod = new SyntheticModule('virtual:foo', {});
    t.throws(() => mod.install(), /reserved for builtins/);
  });

  it('https: prefix throws', (t) => {
    const mod = new SyntheticModule('https://example.com', {});
    t.throws(() => mod.install(), /reserved for builtins/);
  });
});

describe('SyntheticModule — double-install and double-uninstall', () => {
  it('installing same specifier twice throws', (t) => {
    const mod = new SyntheticModule('testDouble', { x: 1 });
    mod.install();
    try {
      t.throws(() => mod.install(), /already installed/);
    } finally {
      mod.uninstall();
    }
  });

  it('uninstalling non-installed specifier throws', (t) => {
    const mod = new SyntheticModule('testNotInstalled', { x: 1 });
    t.throws(() => mod.uninstall(), /not installed/);
  });
});

describe('SyntheticModule — uninstall then re-install', () => {
  it('fresh import after re-install sees new exports', async (t) => {
    const specifier = 'testReinstall';
    const mod1 = new SyntheticModule(specifier, { version: 1 });
    mod1.install();
    const ns1 = await import(specifier) as { version: number };
    t.equal(ns1.version, 1);
    mod1.uninstall();

    const mod2 = new SyntheticModule(specifier, { version: 2 });
    mod2.install();
    try {
      const ns2 = await import(specifier) as { version: number };
      t.equal(ns2.version, 2);
    } finally {
      mod2.uninstall();
    }
  });
});

describe('SyntheticModule — realm isolation', () => {
  it('installed module is not visible in child realm', async (t) => {
    const mod = new SyntheticModule('testIsolation', { x: 99 });
    mod.install();
    try {
      const ENTRY = new URL('./fixtures/synthetic-import-attempt.mts', import.meta.url).pathname;
      const realm = new Realm<() => Promise<boolean>>({ entry: ENTRY });
      const threw = await realm.call();
      t.ok(threw, 'child realm import of testIsolation should throw');
    } finally {
      mod.uninstall();
    }
  });
});
