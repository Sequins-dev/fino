import { describe, it } from 'fino:test/test';
import { BaseTransportPort, DeferredTransportPort } from 'internal:realm/transport-port';

class FakePort extends BaseTransportPort {
  sent: unknown[] = [];

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  emit(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: message }));
  }
}

describe('DeferredTransportPort', () => {
  it('ignores and closes a stale asynchronous replacement', async (t) => {
    let resolveOld!: (port: BaseTransportPort) => void;
    const oldPending = new Promise<BaseTransportPort>((resolve) => { resolveOld = resolve; });
    const deferred = new DeferredTransportPort(oldPending);
    const current = new FakePort();
    const stale = new FakePort();
    const received: unknown[] = [];
    deferred.addEventListener('message', (event) => received.push((event as MessageEvent).data));
    deferred.start();

    deferred.replace(current);
    resolveOld(stale);
    await Promise.resolve();
    stale.emit('stale');
    current.emit('current');

    t.equal(stale.closed, true, 'stale replacement was disposed');
    t.deepEqual(received, ['current']);
    deferred.close();
  });

  it('does not close a stale promise that resolves to the current port', async (t) => {
    let resolvePending!: (port: BaseTransportPort) => void;
    const pending = new Promise<BaseTransportPort>((resolve) => { resolvePending = resolve; });
    const deferred = new DeferredTransportPort(pending);
    const current = new FakePort();
    deferred.replace(current);

    resolvePending(current);
    await Promise.resolve();

    t.equal(current.closed, false);
    deferred.close();
  });
});
