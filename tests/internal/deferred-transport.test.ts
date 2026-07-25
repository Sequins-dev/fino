import { describe, it } from 'fino:test/test';
import { BaseTransportPort, DeferredTransportPort } from 'internal:realm/transport-port';

function isDataCloneError(error: unknown): boolean {
  return error instanceof Error && error.name === 'DataCloneError';
}

class FakePort extends BaseTransportPort {
  sent: unknown[] = [];

  postMessage(message: unknown): void {
    this.sent.push(message);
  }
}

describe('DeferredTransportPort', () => {
  it('buffers messages until a concrete endpoint is attached', (t) => {
    const deferred = new DeferredTransportPort({ allowPortTransfer: false });
    const current = new FakePort();
    deferred.postMessage('before');
    deferred.replace(current);
    t.deepEqual(current.sent, ['before']);
    deferred.close();
  });

  it('detaches a queued MessagePort synchronously', (t) => {
    const deferred = new DeferredTransportPort();
    const channel = new MessageChannel();
    try {
      deferred.postMessage({ port: channel.port1 }, [channel.port1]);
      t.throws(
        () => deferred.postMessage('again', [channel.port1]),
        isDataCloneError,
        'the first queued transfer neuters the source port before allocation finishes'
      );
    } finally {
      deferred.close();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
