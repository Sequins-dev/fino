import { describe, it } from 'fino:test/test';
import { quicAvailable, quicResetStreamAtAvailable } from 'fino:net/quic';
import { quicConnectionInternals } from 'internal:net/quic/endpoint';
import { QuicPipe, decodeUtf8, encodeUtf8 } from './fixtures/quic/sim-harness.ts';
function once(target: EventTarget, type: string): Promise<any> {
  return new Promise((resolve) => {
    target.addEventListener(type, resolve, { once: true });
  });
}
function trackPromise<T>(promise: Promise<T>): {
  settled(): boolean;
  promise: Promise<T>;
} {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return {
    settled: () => settled,
    promise,
  };
}
async function readAll(
  pipe: QuicPipe,
  stream: Awaited<ReturnType<NonNullable<QuicPipe['serverConnection']>['acceptStream']>>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await pipe.pumpUntil(stream.reader.read());
    if (chunk === null) break;
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
describe('QUIC stream state conformance', () => {
  it('tracks finalSize and bytesAcked across stream half-close', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('half-close-stats'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const received = await readAll(pipe, serverStream);
      await pipe.runUntilSettled();
      t.equal(decodeUtf8(received), 'half-close-stats', 'peer reads all bytes through FIN');
      t.equal(
        serverStream.stats.finalSize,
        received.byteLength,
        'receiving stream records final size at FIN',
      );
      t.equal(
        clientStream.stats.bytesAcked,
        received.byteLength,
        'sending stream records acknowledged bytes',
      );
    } finally {
      await pipe.close();
    }
  });
  it('rejects peer writes after STOP_SENDING drains in-flight data', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('in-flight-before-stop'));
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const reset = new Promise<any>((resolve) => {
        serverStream.addEventListener('reset', resolve, { once: true });
      });
      const stopSending = new Promise<any>((resolve) => {
        serverStream.addEventListener('stopsending', resolve, { once: true });
      });
      serverStream.stopSending(123);
      t.equal(
        decodeUtf8((await pipe.pumpUntil(serverStream.reader.read()))!),
        'in-flight-before-stop',
        'in-flight data remains readable',
      );
      t.equal(
        await pipe.pumpUntil(serverStream.reader.read()),
        null,
        'local read side ends after STOP_SENDING',
      );
      await pipe.pumpUntil(stopSending);
      await pipe.pumpUntil(reset);
      await clientStream.writer.write(encodeUtf8('crossing-after-stop'));
      await pipe.runUntilSettled();
      await t.rejects(
        () => clientStream.writer.write(encodeUtf8('after-stop')),
        /closed|stop sending/i,
        'peer writer rejects once STOP_SENDING has been processed',
      );
    } finally {
      await pipe.close();
    }
  });
  it('rejects peer reads when RESET_STREAM arrives before data', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      const reset = new Promise<any>((resolve) => {
        server.addEventListener(
          'stream',
          (event: any) => {
            event.stream.addEventListener('reset', resolve, { once: true });
          },
          { once: true },
        );
      });
      clientStream.reset(701);
      const [serverStream, resetEvent] = await pipe.pumpUntil(
        Promise.all([serverStreamPromise, reset]),
      );
      await t.rejects(
        () => serverStream.reader.read(),
        /reset: 701/,
        'peer reader rejects with the reset code before exposing data',
      );
      t.equal(resetEvent.errorCode, 701, 'reset event carries the reset-before-data code');
      t.equal(
        serverStream.stats.finalSize,
        null,
        'reset-before-data does not report a FIN final size',
      );
    } finally {
      await pipe.close();
    }
  });
  it('exposes resetAt and fails clearly when reset_stream_at is unavailable', async (t) => {
    if (!quicAvailable || quicResetStreamAtAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client } = await pipe.handshake();
      const stream = await client.openBidirectionalStream();
      t.equal(typeof stream.resetAt, 'function', 'resetAt method is present');
      t.throws(
        () => stream.resetAt(704, 0),
        /reset_stream_at is not supported/i,
        'missing ngtcp2 reset-at support fails clearly',
      );
    } finally {
      await pipe.close();
    }
  });
  it('rejects peer reads when RESET_STREAM crosses data in flight', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({ link: { latencyMs: 5 } });
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      const reset = new Promise<any>((resolve) => {
        server.addEventListener(
          'stream',
          (event: any) => {
            event.stream.addEventListener('reset', resolve, { once: true });
          },
          { once: true },
        );
      });
      await clientStream.writer.write(encodeUtf8('reset-crossing-data'));
      await pipe.runUntilIdle();
      clientStream.reset(702);
      const [serverStream, resetEvent] = await pipe.pumpUntil(
        Promise.all([serverStreamPromise, reset]),
      );
      t.equal(resetEvent.errorCode, 702, 'reset event carries the in-flight reset code');
      t.equal(
        decodeUtf8((await pipe.pumpUntil(serverStream.reader.read()))!),
        'reset-crossing-data',
        'in-flight data that arrived before RESET remains readable',
      );
      await t.rejects(
        () => serverStream.reader.read(),
        /reset: 702/,
        'in-flight reset terminates the readable side after delivered data',
      );
      t.ok(clientStream.stats.bytesSent > 0, 'sender records data queued before reset');
    } finally {
      await pipe.close();
    }
  });
  it('ignores a local RESET_STREAM after FIN is fully consumed by the peer', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('fin-before-reset'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      t.equal(
        decodeUtf8((await pipe.pumpUntil(serverStream.reader.read()))!),
        'fin-before-reset',
        'peer receives data before FIN',
      );
      t.equal(
        await pipe.pumpUntil(serverStream.reader.read()),
        null,
        'peer observes EOF before late reset',
      );
      clientStream.reset(703);
      await pipe.runUntilSettled();
      t.equal(
        serverStream.stats.finalSize,
        'fin-before-reset'.length,
        'late reset does not erase the FIN final size',
      );
      t.equal(
        await serverStream.reader.read(),
        null,
        'late reset after FIN does not turn EOF into an error',
      );
    } finally {
      await pipe.close();
    }
  });
  it('unblocks stream-level MAX_STREAM_DATA writes after peer read credit returns', async (t) => {
    if (!quicAvailable) return;
    const payload = new Uint8Array(96 * 1024);
    payload.fill(90);
    const pipe = new QuicPipe({
      client: { connection: { initialMaxData: 1024 * 1024 } },
      server: {
        connection: {
          initialMaxData: 1024 * 1024,
          initialMaxStreamDataBidiRemote: 16 * 1024,
        },
      },
    });
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openBidirectionalStream();
      const blocked = once(clientStream, 'blocked');
      const serverStreamPromise = server.acceptStream();
      const write = trackPromise(clientStream.writer.write(payload));
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      await pipe.pumpUntil(blocked);
      await pipe.runUntilSettled();
      t.ok(
        client[quicConnectionInternals.inspectSendState]().pendingWriteBytes > 0,
        'pending bytes are tracked while stream credit is exhausted',
      );
      let received = 0;
      while (received < payload.byteLength) {
        const chunk = await pipe.pumpUntil(serverStream.reader.read());
        if (chunk === null) break;
        received += chunk.byteLength;
      }
      await pipe.pumpUntil(write.promise, 5e3);
      await clientStream.writer.close();
      t.equal(
        await pipe.pumpUntil(serverStream.reader.read()),
        null,
        'peer receives FIN after stream-level credit drains queued data',
      );
      await pipe.runUntilSettled();
      t.equal(
        received,
        payload.byteLength,
        'peer read returns stream-level credit until the write completes',
      );
      t.equal(
        client[quicConnectionInternals.inspectSendState]().pendingWriteCount,
        0,
        'stream-level blocked write queue drains',
      );
    } finally {
      await pipe.close();
    }
  });
  it('pends unidirectional stream opens at MAX_STREAMS until peer returns credit', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({ server: { connection: { initialMaxStreamsUni: 3 } } });
    try {
      const { client, server } = await pipe.handshake();
      const serverStreams = [server.acceptStream(), server.acceptStream(), server.acceptStream()];
      const opened = [];
      for (let i = 0; i < 3; i++) {
        const stream = await client.openUnidirectionalStream();
        await stream.writer.write(encodeUtf8(`uni-${i}`));
        await stream.writer.close();
        opened.push(stream);
      }
      const fourth = trackPromise(client.openUnidirectionalStream());
      await pipe.runUntilSettled();
      t.equal(fourth.settled(), false, 'fourth unidirectional stream waits for MAX_STREAMS credit');
      const firstPeerStream = await pipe.pumpUntil(serverStreams[0]!);
      t.equal(
        decodeUtf8((await pipe.pumpUntil(firstPeerStream.reader.read()))!),
        'uni-0',
        'peer receives one unidirectional stream',
      );
      t.equal(
        await pipe.pumpUntil(firstPeerStream.reader.read()),
        null,
        'peer consumes FIN and returns stream credit',
      );
      const fourthStream = await pipe.pumpUntil(fourth.promise);
      await fourthStream.writer.write(encodeUtf8('uni-3'));
      await fourthStream.writer.close();
      const fourthPeerStream = await pipe.pumpUntil(server.acceptStream());
      t.equal(
        decodeUtf8((await pipe.pumpUntil(fourthPeerStream.reader.read()))!),
        'uni-3',
        'fourth unidirectional stream opens after credit return',
      );
      t.equal(
        opened.length,
        3,
        'initial unidirectional stream limit was exhausted before credit returned',
      );
    } finally {
      await pipe.close();
    }
  });
  it('graceful close rejects new stream operations and drains existing streams', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openUnidirectionalStream();
      await clientStream.writer.write(encodeUtf8('drain-me'));
      const serverStreamPromise = server.acceptStream();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const closePromise = client.close();
      t.ok(client.closing || client.state === 'closed', 'client enters closing state immediately');
      await t.rejects(
        () => client.openBidirectionalStream(),
        /closing/,
        'openBidirectionalStream rejected after graceful close',
      );
      await t.rejects(
        () => client.openUnidirectionalStream(),
        /closing/,
        'openUnidirectionalStream rejected after graceful close',
      );
      await t.rejects(
        () => client.sendDatagram(encodeUtf8('x')),
        /closing/,
        'sendDatagram rejected after graceful close',
      );
      const received = await readAll(pipe, serverStream);
      t.equal(decodeUtf8(received), 'drain-me', 'in-flight stream drains before connection closes');
      await pipe.pumpUntil(closePromise, 3e3);
      t.equal(client.state, 'closed', 'client reaches closed state after all streams drain');
    } finally {
      await pipe.close();
    }
  });
  it('graceful close does not surface new peer streams to acceptStream', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      client.close();
      const streamOpenedOnClient = new Promise<void>((resolve) => {
        client.addEventListener('stream', () => resolve(), { once: true });
      });
      const serverStream = await server.openBidirectionalStream();
      await serverStream.writer.write(encodeUtf8('ignored'));
      await serverStream.writer.close();
      const raced = await pipe
        .pumpUntil(
          Promise.race([
            streamOpenedOnClient.then(() => 'stream'),
            new Promise<string>((resolve) =>
              pipe.pumpUntil(new Promise<never>(() => {})).catch(() => resolve('timeout')),
            ),
          ]),
          300,
        )
        .catch(() => 'timeout');
      t.ok(raced !== 'stream', 'no stream event fires on gracefully-closing connection');
    } finally {
      await pipe.close();
    }
  });
  it('graceful close half-close nudge lets read-ended streams complete', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openBidirectionalStream();
      await clientStream.writer.write(encodeUtf8('ping'));
      const serverStreamPromise = server.acceptStream();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      await serverStream.writer.write(encodeUtf8('server-half-close'));
      await serverStream.writer.close();
      const received = await readAll(pipe, clientStream);
      t.equal(decodeUtf8(received), 'server-half-close', 'client reads server data');
      const closePromise = client.close();
      await pipe.pumpUntil(closePromise, 3e3);
      t.equal(client.state, 'closed', 'closed after half-close nudge drained write side');
    } finally {
      await pipe.close();
    }
  });
});
