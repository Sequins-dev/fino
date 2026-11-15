import { describe, it } from 'fino:test/test';
import * as sync from 'internal:serial-executor';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('serial executors', () => {
  it('runs FIFO without overlap and recovers after either kind of failure', async (t) => {
    const executor = new sync.SerialExecutor();
    const blocked = gate();
    const started = gate();
    const order: number[] = [];
    const first = executor.run(async () => {
      order.push(1);
      started.resolve();
      await blocked.promise;
      order.push(2);
    });
    const failure = new Error('failed');
    const second = executor.run(() => {
      order.push(3);
      throw failure;
    });
    const third = executor.run(async () => {
      order.push(4);
      throw failure;
    });
    const fourth = executor.run(() => {
      order.push(5);
      return 42;
    });
    const checks = [t.rejects(() => second, /failed/), t.rejects(() => third, /failed/)];
    await started.promise;
    t.deepEqual(order, [1]);
    t.equal(executor.pending, 4);
    blocked.resolve();
    await first;
    await Promise.all(checks);
    t.equal(await fourth, 42);
    await executor.drain();
    t.deepEqual(order, [1, 2, 3, 4, 5]);
    t.equal(executor.pending, 0);
  });

  it('rejects overload and releases cancelled queue entries immediately', async (t) => {
    const executor = new sync.SerialExecutor({ maxPending: 2 });
    const blocked = gate();
    const started = gate();
    const first = executor.run(async () => {
      started.resolve();
      await blocked.promise;
    });
    await started.promise;
    const abort = new AbortController();
    let called = false;
    const cancelled = executor.run(
      () => {
        called = true;
      },
      { signal: abort.signal },
    );
    const check = t.rejects(() => cancelled, /cancelled/);
    await t.rejects(() => executor.run(() => {}), RangeError);
    abort.abort(new Error('cancelled'));
    await check;
    t.equal(executor.pending, 1);
    const third = executor.run(() => 3);
    blocked.resolve();
    await first;
    t.equal(await third, 3);
    t.equal(called, false);
    await t.rejects(() => executor.run(() => {}, { signal: abort.signal }), /cancelled/);
    t.throws(() => new sync.SerialExecutor({ maxPending: 0 }), RangeError);
  });

  it('removes cancelled entries at any queue position without disturbing later work', async (t) => {
    const executor = new sync.SerialExecutor();
    const blocked = gate();
    const started = gate();
    const first = executor.run(async () => {
      started.resolve();
      await blocked.promise;
    });
    await started.promise;
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    let called = 0;
    const queued = controllers.map((controller) =>
      executor.run(
        () => {
          called++;
        },
        { signal: controller.signal },
      ),
    );
    const checks = queued.map((promise) => t.rejects(() => promise, /cancelled/));
    for (const index of [1, 0, 2]) controllers[index]!.abort(new Error('cancelled'));
    await Promise.all(checks);
    t.equal(executor.pending, 1);
    const last = executor.run(() => 9);
    blocked.resolve();
    await first;
    t.equal(await last, 9);
    t.equal(called, 0);
    // Late abort cannot affect an already completed operation or corrupt its queue.
    const late = new AbortController();
    t.equal(await executor.run(() => 10, { signal: late.signal }), 10);
    late.abort();
    t.equal(await executor.run(() => 11), 11);
    t.equal(executor.pending, 0);
  });

  it('does not release the active slot when its signal aborts', async (t) => {
    const executor = new sync.SerialExecutor();
    const abort = new AbortController();
    const blocked = gate();
    const started = gate();
    const order: number[] = [];
    const first = executor.run(
      async () => {
        started.resolve();
        await blocked.promise;
        order.push(1);
      },
      { signal: abort.signal },
    );
    await started.promise;
    abort.abort();
    const next = executor.run(() => order.push(2));
    await Promise.resolve();
    t.deepEqual(order, []);
    blocked.resolve();
    await Promise.all([first, next]);
    t.deepEqual(order, [1, 2]);
  });

  it('closes admission immediately and waits for accepted work', async (t) => {
    const executor = new sync.SerialExecutor();
    const blocked = gate();
    const work = executor.run(() => blocked.promise);
    let drained = false;
    const drain = executor.drain().then(() => {
      drained = true;
    });
    const close = executor.close();
    t.equal(executor.closed, true);
    await t.rejects(() => executor.run(() => {}), /closed/);
    await Promise.resolve();
    t.equal(drained, false);
    blocked.resolve();
    await Promise.all([work, drain, close, executor.close()]);
    t.equal(drained, true);
  });

  it('serializes each key while letting other keys progress and releases idle keys', async (t) => {
    const executor = new sync.KeyedSerialExecutor<string>();
    const blocked = gate();
    const started = gate();
    const order: string[] = [];
    const first = executor.run('a', async () => {
      started.resolve();
      await blocked.promise;
      order.push('a1');
    });
    await started.promise;
    const next = executor.run('a', () => order.push('a2'));
    const other = executor.run('b', () => order.push('b'));
    await other;
    t.deepEqual(order, ['b']);
    t.equal(executor.size, 1);
    blocked.resolve();
    await Promise.all([first, next]);
    t.deepEqual(order, ['b', 'a1', 'a2']);
    t.equal(executor.size, 0);
    await t.rejects(
      () =>
        executor.run('a', () => {
          throw new Error('failure');
        }),
      /failure/,
    );
    t.equal(executor.size, 0);
    t.equal(await executor.run('a', () => 7), 7);
    await executor.close();
    await t.rejects(() => executor.run('a', () => {}), /closed/);
  });
});
