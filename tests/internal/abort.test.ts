import { describe, it } from 'fino:test/test';
const helpers = await import('../../js/internal/abort.ts');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function trackedSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  let listeners = 0;
  signal.addEventListener = ((...args: Parameters<typeof add>) => {
    listeners++;
    add(...args);
  }) as typeof add;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    listeners--;
    remove(...args);
  }) as typeof remove;
  return { controller, signal, listeners: () => listeners };
}

describe('internal cancellation helpers', () => {
  it('owns an abort subscription until disposal or first abort', (t) => {
    const tracked = trackedSignal();
    const reasons: unknown[] = [];
    const dispose = helpers.onAbort(tracked.signal, (reason) => reasons.push(reason));
    t.equal(tracked.listeners(), 1);
    tracked.controller.abort(null);
    t.deepEqual(reasons, [null]);
    t.equal(tracked.listeners(), 0);
    dispose();
    dispose();
    t.equal(tracked.listeners(), 0);
    const other = trackedSignal();
    const stop = helpers.onAbort(other.signal, () => reasons.push('unexpected'));
    stop();
    other.controller.abort();
    t.deepEqual(reasons, [null]);
    helpers.onAbort(tracked.signal, (reason) => reasons.push(reason));
    t.deepEqual(reasons, [null, null]);
    helpers.onAbort(undefined, () => reasons.push('unexpected'))();
  });

  it('does not start pre-aborted work and preserves the exact reason', async (t) => {
    const controller = new AbortController();
    const reason = { cancelled: true };
    controller.abort(reason);
    let called = false;
    let caught: unknown;
    try {
      await helpers.withAbort(() => {
        called = true;
      }, controller.signal);
    } catch (error) {
      caught = error;
    }
    t.equal(caught, reason);
    t.equal(called, false);
  });

  it('cleans up after success, rejection, synchronous failure and synchronous abort', async (t) => {
    const tracked = trackedSignal();
    t.equal(await helpers.withAbort(() => 42, tracked.signal), 42);
    t.equal(tracked.listeners(), 0);
    await t.rejects(
      () =>
        helpers.withAbort(() => {
          throw new Error('sync');
        }, tracked.signal),
      /sync/,
    );
    t.equal(tracked.listeners(), 0);
    await t.rejects(
      () => helpers.withAbort(() => Promise.reject(new Error('async')), tracked.signal),
      /async/,
    );
    t.equal(tracked.listeners(), 0);
    await t.rejects(
      () =>
        helpers.withAbort(() => {
          tracked.controller.abort(new Error('cancelled'));
          return 7;
        }, tracked.signal),
      /cancelled/,
    );
    t.equal(tracked.listeners(), 0);
  });

  it('rejects a cancelled wait and observes the unfinished operation safely', async (t) => {
    const tracked = trackedSignal();
    const work = deferred<number>();
    const result = helpers.withAbort(() => work.promise, tracked.signal);
    const check = t.rejects(() => result, /cancelled/);
    tracked.controller.abort(new Error('cancelled'));
    await check;
    t.equal(tracked.listeners(), 0);
    work.reject(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();
    t.equal(await helpers.withAbort(() => Promise.resolve(9)), 9);
  });

  it('owns and disposes parent subscriptions and deadline timers', (t) => {
    const tracked = trackedSignal();
    let callback: (() => void) | null = null;
    let timers = 0;
    const schedule = (fire: () => void, delay: number) => {
      t.equal(delay, 12);
      timers++;
      callback = fire;
      return () => {
        if (callback !== null) {
          callback = null;
          timers--;
        }
      };
    };
    const reason = new Error('deadline');
    const scope = helpers.abortScope({
      signal: tracked.signal,
      timeoutMs: 12,
      timeoutReason: reason,
      schedule,
    });
    t.equal(tracked.listeners(), 1);
    t.equal(timers, 1);
    callback!();
    t.equal(scope.signal.reason, reason);
    t.equal(tracked.listeners(), 0);
    t.equal(timers, 0);
    scope.dispose();
    scope.dispose();
    const disposed = helpers.abortScope({ signal: tracked.signal, timeoutMs: 12, schedule });
    disposed.dispose();
    tracked.controller.abort('parent');
    t.equal(disposed.signal.aborted, false);
    t.equal(timers, 0);
    const inherited = helpers.abortScope({ signal: tracked.signal, timeoutMs: 12, schedule });
    t.equal(inherited.signal.reason, 'parent');
    t.equal(timers, 0, 'pre-aborted parents do not start a timer');
    t.throws(() => helpers.abortScope({ timeoutMs: -1 }), RangeError);
  });
});
