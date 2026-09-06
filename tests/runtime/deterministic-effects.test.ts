import { describe, it } from 'fino:test/test';
import { Facade, ImportMap, Realm } from 'fino:realm';
import * as loop from 'internal:runtime/loop';
import * as runtimeRandom from 'internal:runtime/random';
import {
  elapsedMillis,
  setClockOverride,
  timeOriginMillis,
  wallMillis,
} from 'internal:runtime/clock';
import { VirtualTimerQueue } from 'internal:runtime/virtual-timers';

describe('seeded runtime randomness', () => {
  it('repeats one sequence for equal numeric and named seeds', (t) => {
    const numericLeft = runtimeRandom.createSeededRandom(42);
    const numericRight = runtimeRandom.createSeededRandom(42);
    const namedLeft = runtimeRandom.createSeededRandom('checkout-flow');
    const namedRight = runtimeRandom.createSeededRandom('checkout-flow');

    t.deepEqual(
      [numericLeft.nextUint32(), numericLeft.nextFloat(), numericLeft.nextUint32()],
      [numericRight.nextUint32(), numericRight.nextFloat(), numericRight.nextUint32()],
    );
    t.deepEqual(
      [namedLeft.nextUint32(), namedLeft.nextFloat(), namedLeft.nextUint32()],
      [namedRight.nextUint32(), namedRight.nextFloat(), namedRight.nextUint32()],
    );
  });

  it('fills bytes from the same deterministic stream', (t) => {
    const bytes = new Uint8Array(9);
    runtimeRandom.createSeededRandom(7).fillBytes(bytes);

    const draws = runtimeRandom.createSeededRandom(7);
    const expected = new Uint8Array(9);
    for (let offset = 0; offset < expected.length; offset += 4) {
      let word = draws.nextUint32();
      for (let byte = 0; byte < 4 && offset + byte < expected.length; byte++) {
        expected[offset + byte] = word & 0xff;
        word >>>= 8;
      }
    }

    t.deepEqual(bytes, expected);
  });

  it('routes runtime entropy through the installed Realm source', (t) => {
    const expected = new Uint8Array(12);
    runtimeRandom.createSeededRandom('realm-seed').fillBytes(expected);
    runtimeRandom.setRandomOverride(runtimeRandom.createSeededRandom('realm-seed'));
    try {
      t.deepEqual(crypto.getRandomValues(new Uint8Array(12)), expected);
    } finally {
      runtimeRandom.setRandomOverride(null);
    }
    t.equal(runtimeRandom.randomOverride(), null);
  });
});

describe('runtime clock sources', () => {
  it('uses one override for wall and elapsed time', (t) => {
    const platformTimeOrigin = performance.timeOrigin;
    let monotonicNanos = 5_000_000;
    let wallTime = 1_700_000_000_000;
    setClockOverride({
      monotonicNanos: () => monotonicNanos,
      wallMillis: () => wallTime,
    });
    try {
      t.equal(timeOriginMillis(), 1_700_000_000_000);
      t.equal(elapsedMillis(), 0);

      monotonicNanos += 8_500_000;
      wallTime += 12;
      t.equal(elapsedMillis(), 8.5);
      t.equal(wallMillis(), 1_700_000_000_012);
    } finally {
      setClockOverride(null);
    }
    t.equal(performance.timeOrigin, platformTimeOrigin, 'restoring preserves the platform origin');
  });
});

describe('virtual runtime timers', () => {
  it('advances to the next deadline and preserves insertion order', async (t) => {
    const queue = new VirtualTimerQueue(100);
    const order: string[] = [];
    void queue.schedule(20).then(() => order.push('first'));
    void queue.schedule(10).then(() => order.push('second'));
    void queue.schedule(10).then(() => order.push('third'));

    t.equal(queue.earliest(), 110);
    t.equal(queue.advance(), 2);
    await Promise.resolve();
    t.equal(queue.now(), 110);
    t.deepEqual(order, ['second', 'third']);

    t.equal(queue.advance(), 1);
    await Promise.resolve();
    t.equal(queue.now(), 120);
    t.deepEqual(order, ['second', 'third', 'first']);
  });

  it('clamps invalid delays and drops cancelled timers without settling them', async (t) => {
    const queue = new VirtualTimerQueue(50);
    let cancelledSettled = false;
    const cancelled = queue.schedule(5);
    t.equal(cancelled.hasRef(), true);
    cancelled.unref();
    t.equal(cancelled.hasRef(), false);
    t.equal(queue.referencedSize(), 0);
    cancelled.ref();
    t.equal(queue.referencedSize(), 1);
    void cancelled.then(() => {
      cancelledSettled = true;
    });
    cancelled.cancel();
    queue.schedule(-1);
    queue.schedule(Number.NaN);

    t.equal(queue.size(), 2);
    t.equal(queue.advance(), 2);
    await Promise.resolve();
    t.equal(queue.now(), 50);
    t.equal(cancelledSettled, false);
    t.equal(queue.advance(), 0);
  });

  it('drives runtime timeout promises without arming the platform loop', async (t) => {
    const queue = new VirtualTimerQueue(1_000);
    const baselineAlive = loop.alive();
    let blocked = true;
    let settled = false;
    loop._setVirtualTimerQueue(queue, () => blocked);
    try {
      const timer = loop.timeout(5_000);
      void timer.then(() => {
        settled = true;
      });
      t.equal(queue.size(), 1);
      t.equal(loop.alive(), true, 'referenced virtual timer keeps the loop alive');
      timer.unref();
      t.equal(loop.alive(), baselineAlive, 'unref restores the previous liveness state');
      timer.ref();
      t.equal(loop._advanceVirtualTime(), 0, 'external work blocks virtual time');
      t.equal(queue.now(), 1_000);
      blocked = false;
      t.equal(loop._advanceVirtualTime(), 1);
      await Promise.resolve();
      t.equal(settled, true);
      t.equal(queue.now(), 6_000);
      t.equal(loop.alive(), baselineAlive, 'firing restores the previous liveness state');
    } finally {
      loop._setVirtualTimerQueue(null);
    }
  });
});

describe('deterministic Realm effects', () => {
  it('delivers Facade responses through deterministic virtual latency', async (t) => {
    const facade = new Facade('app:latency', [])
      .handle('ping', async () => 'pong')
      .stream('tail', async function* () {
        yield 'a';
        yield 'b';
        yield 'c';
      });
    using realm = new Realm<() => Promise<unknown>>({
      entry: new URL('./fixtures/facade-latency.ts', import.meta.url).pathname,
      deterministic: { seed: 7, startTime: 100, responseLatency: [25, 25] },
      overrides: ImportMap.deny([
        { pattern: 'internal:runtime/loop', directive: 'inherit' },
        { pattern: 'internal:runtime/deterministic-effects', directive: 'inherit' },
        { pattern: 'app:latency', directive: facade },
      ]),
    });

    t.deepEqual(await realm.call(), {
      random: runtimeRandom.createSeededRandom(7).nextFloat(),
      elapsed: 25,
      order: ['timer', 'response'],
      chunkTimes: [25, 50, 75],
    });
  });

  it('carries Facade response latency across a process boundary', async (t) => {
    const facade = new Facade('app:latency', [])
      .handle('ping', async () => 'pong')
      .stream('tail', async function* () {
        yield 'a';
        yield 'b';
        yield 'c';
      });
    const realm = new Realm<() => Promise<unknown>>({
      entry: new URL('./fixtures/facade-latency.ts', import.meta.url).pathname,
      process: true,
      deterministic: { seed: 7, startTime: 100, responseLatency: [25, 25] },
      overrides: ImportMap.deny([
        { pattern: 'internal:runtime/loop', directive: 'inherit' },
        { pattern: 'internal:runtime/deterministic-effects', directive: 'inherit' },
        { pattern: 'app:latency', directive: facade },
      ]),
    });
    try {
      t.deepEqual(await realm.call(), {
        random: runtimeRandom.createSeededRandom(7).nextFloat(),
        elapsed: 25,
        order: ['timer', 'response'],
        chunkTimes: [25, 50, 75],
      });
    } finally {
      realm.terminate();
      await realm.run();
    }
  });

  it('repeats time and randomness from one Realm configuration', async (t) => {
    const entry = new URL('./fixtures/deterministic-effects.ts', import.meta.url).pathname;
    const options = {
      entry,
      deterministic: {
        seed: 'checkout-flow',
        startTime: 1_700_000_000_000,
      },
    };
    const first = new Realm(options);
    const second = new Realm(options);
    try {
      const [left, right] = await Promise.all([first.call(), second.call()]);
      t.deepEqual(left, right);
      t.equal(left.before.date, 1_700_000_000_000);
      t.equal(left.before.constructedDate, 1_700_000_000_000);
      t.equal(left.before.timeOrigin, 1_700_000_000_000);
      t.equal(left.before.performance, 0);
      t.equal(left.after.date, 1_700_000_000_025);
      t.equal(left.after.performance, 25);
    } finally {
      first.terminate();
      second.terminate();
      await Promise.all([first.run(), second.run()]);
    }
  });

  it('crosses a process boundary with the same bootstrap contract', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/deterministic-effects.ts', import.meta.url).pathname,
      process: true,
      deterministic: { seed: 9, startTime: 100 },
    });
    try {
      const result = await realm.call();
      t.equal(result.before.date, 100);
      t.equal(result.before.performance, 0);
      t.equal(result.after.date, 125);
      t.equal(result.after.performance, 25);
    } finally {
      realm.terminate();
      await realm.run();
    }
  });

  it('does not implicitly pass deterministic effects to nested Realms', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/nested-effects.ts', import.meta.url).pathname,
      deterministic: { seed: 1, startTime: 100 },
    });
    try {
      const result = await realm.call(
        new URL('./fixtures/deterministic-effects.ts', import.meta.url).pathname,
      );
      t.ok(result.before.date > 100, 'nested Realm reads its ordinary platform clock');
      t.notEqual(result.before.timeOrigin, 100);
    } finally {
      realm.terminate();
      await realm.run();
    }
  });

  it('rejects invalid configuration before starting a Realm', (t) => {
    const entry = new URL('./fixtures/deterministic-effects.ts', import.meta.url).pathname;
    t.throws(
      () =>
        new Realm({
          entry,
          deterministic: { seed: Number.NaN },
        }),
      TypeError,
    );
    t.throws(
      () =>
        new Realm({
          entry,
          deterministic: { seed: 1, startTime: Infinity },
        }),
      TypeError,
    );
    t.throws(
      () => new Realm({ entry, remote: true, deterministic: { seed: 1 } }),
      /deterministic.*remote/,
    );
    for (const responseLatency of [
      [-1, 1],
      [2, 1],
      [0, Number.POSITIVE_INFINITY],
    ]) {
      t.throws(
        () =>
          new Realm({
            entry,
            deterministic: { seed: 1, responseLatency: responseLatency as [number, number] },
          }),
        /responseLatency/,
      );
    }
  });
});
