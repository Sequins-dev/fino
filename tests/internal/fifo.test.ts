import { describe, it } from 'fino:test/test';
import { Fifo } from 'internal:fifo';

describe('Fifo', () => {
  it('runs asynchronous tasks one at a time in call order', async (t) => {
    const fifo = new Fifo();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = fifo.run(async () => {
      events.push('first start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first end');
      return 1;
    });
    const second = fifo.run(async () => {
      events.push('second');
      return 2;
    });

    await Promise.resolve();
    t.deepEqual(events, ['first start']);
    releaseFirst();
    t.deepEqual(await Promise.all([first, second]), [1, 2]);
    t.deepEqual(events, ['first start', 'first end', 'second']);
  });

  it('continues after a task rejects', async (t) => {
    const fifo = new Fifo();
    const expected = new Error('expected');
    const rejected = fifo.run(async () => {
      throw expected;
    });
    const recovered = fifo.run(async () => 42);

    await t.rejects(() => rejected, /expected/);
    t.equal(await recovered, 42);
  });

  it('runs synchronous tasks only while no asynchronous task is pending', async (t) => {
    const fifo = new Fifo();
    const values: number[] = [];
    fifo.runSync(() => values.push(1));
    let release!: () => void;
    const pending = fifo.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    t.throws(() => fifo.runSync(() => values.push(2)), /pending asynchronous tasks/);
    release();
    await pending;
    fifo.runSync(() => values.push(3));
    t.deepEqual(values, [1, 3]);
  });
});
