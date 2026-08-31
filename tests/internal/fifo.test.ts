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

  it('exposes only asynchronous FIFO admission', (t) => {
    const fifo = new Fifo();
    t.equal('runSync' in fifo, false);
  });
});
