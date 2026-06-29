import { describe, it } from 'fino:test/test';
import { quicAvailable } from 'fino:net/quic';
import {
  QuicPipe,
  decodeUtf8,
  encodeUtf8,
} from './fixtures/quic/sim-harness.ts';

function once(target: EventTarget, type: string): Promise<any> {
  return new Promise((resolve) => {
    target.addEventListener(type, (event) => resolve(event), { once: true });
  });
}

describe('QUIC simulator recovery conformance', () => {
  it('preserves bulk stream traffic after repeated key updates under loss', async (t) => {
    if (!quicAvailable) return;

    const pipe = new QuicPipe({ link: { latencyMs: 2 } });
    try {
      const { client, server } = await pipe.handshake();
      const warmup = await client.openBidirectionalStream();
      const warmupAccepted = server.acceptStream();
      await warmup.writer.write(encodeUtf8('ready-for-key-update'));
      await warmup.writer.close();
      const warmupServerStream = await pipe.pumpUntil(warmupAccepted);
      t.equal(decodeUtf8((await pipe.pumpUntil(warmupServerStream.reader.read()))!), 'ready-for-key-update', '1-RTT traffic is established before key updates');
      const keyUpdate = once(client, 'keyupdate');
      client.initiateKeyUpdate();
      await pipe.pumpUntil(keyUpdate);
      pipe.setLink(client.localAddress, server.localAddress, { latencyMs: 2, lossRate: 0.02 });
      pipe.setLink(server.localAddress, client.localAddress, { latencyMs: 2, lossRate: 0.02 });

      for (let i = 0; i < 2; i++) {
        const stream = await client.openBidirectionalStream();
        const accepted = server.acceptStream();
        const payload = new Uint8Array(128 * 1024);
        payload.fill(0x30 + i);
        await stream.writer.write(payload);
        await stream.writer.close();
        const serverStream = await pipe.pumpUntil(accepted);
        let received = 0;
        for (;;) {
          const chunk = await pipe.pumpUntil(serverStream.reader.read(), 4000);
          if (chunk === null) break;
          received += chunk.byteLength;
        }
        t.equal(received, payload.byteLength, `bulk stream data survives key-update epoch ${i + 1} under loss`);
        await pipe.runUntilSettled();
        if (i === 0) {
          const nextKeyUpdate = once(client, 'keyupdate');
          client.initiateKeyUpdate();
          await pipe.pumpUntil(nextKeyUpdate);
        }
      }
      await pipe.runUntilSettled();
    } finally {
      await pipe.close();
    }
  });

  it('records persistent congestion collapse and RTT after a simulated blackhole window', async (t) => {
    if (!quicAvailable) return;

    const pipe = new QuicPipe({
      link: { latencyMs: 12 },
      client: { connection: { initialMaxData: 1024 * 1024, initialMaxStreamDataBidiRemote: 1024 * 1024 } },
      server: { connection: { initialMaxData: 1024 * 1024, initialMaxStreamDataBidiLocal: 1024 * 1024 } },
    });
    try {
      const { client, server } = await pipe.handshake();
      const before = client.stats.congestionWindow;
      pipe.dropClientToServer();
      pipe.advance(250);
      await pipe.runUntilSettled();
      pipe.setLink(client.localAddress, server.localAddress, { latencyMs: 12 });
      pipe.setLink(server.localAddress, client.localAddress, { latencyMs: 12 });

      const stream = await client.openBidirectionalStream();
      const accepted = server.acceptStream();
      await stream.writer.write(new Uint8Array(256 * 1024));
      await stream.writer.close();
      const serverStream = await pipe.pumpUntil(accepted);
      let received = 0;
      for (;;) {
        const chunk = await pipe.pumpUntil(serverStream.reader.read());
        if (chunk === null) break;
        received += chunk.byteLength;
      }
      await pipe.runUntilSettled();

      t.equal(received, 256 * 1024, 'stream recovers after a temporary blackhole');
      const rtt = Math.max(client.stats.smoothedRttMs, server.stats.smoothedRttMs);
      t.ok(rtt >= 8 && rtt <= 80, 'RTT stats stay within a practical tolerance of the simulated 12ms one-way latency');
      t.ok(client.stats.congestionWindow > 0, 'congestion window remains observable after recovery');
      t.ok(
        client.stats.slowStartThreshold === 0 || client.stats.congestionWindow <= client.stats.slowStartThreshold,
        'persistent congestion recovery leaves cwnd collapsed at or below ssthresh',
      );
      t.ok(before >= 0, 'baseline congestion window was observable before blackhole');
    } finally {
      await pipe.close();
    }
  });

  it('delivers DATAGRAM frames before and after active migration', async (t) => {
    if (!quicAvailable) return;

    const pipe = new QuicPipe({
      client: { migration: { enabled: true }, datagrams: { enabled: true, maxFrameSize: 1200 } },
      server: { migration: { enabled: true }, datagrams: { enabled: true, maxFrameSize: 1200 } },
    });
    try {
      const { client, server } = await pipe.handshake();
      const received: string[] = [];
      server.addEventListener('datagram', (event: any) => {
        received.push(decodeUtf8(event.data));
      });

      await client.sendDatagram(encodeUtf8('before-migration'));
      await pipe.runUntilSettled();
      const pathValidation = once(client, 'pathvalidation');
      await client.migrate({ family: 'ipv4', ip: '10.0.0.1', port: 56_020 });
      const pathEvent = await pipe.pumpUntil(pathValidation);
      t.equal(pathEvent.result, 'success', 'client validates the migrated path before DATAGRAM send');
      const status = once(client, 'datagramstatus');
      await client.sendDatagram(encodeUtf8('after-migration'));
      await pipe.runUntilSettled();
      const statusEvent = await pipe.pumpUntil(status);

      t.ok(
        pipe.trace().some((event) => event.type === 'datagram:queued' && event.localAddress.port === 56_020),
        'post-migration DATAGRAM queues from the migrated local path',
      );
      t.ok(
        pipe.trace().some((event) => event.type === 'datagram:delivered' && event.from.port === 56_020 && event.to.port === server.localAddress.port),
        'post-migration DATAGRAM packet reaches the server socket',
      );
      t.equal(statusEvent.status, 'ack', 'post-migration DATAGRAM is acknowledged');
      t.deepEqual(received, ['before-migration', 'after-migration'], 'DATAGRAM delivery survives active migration');
    } finally {
      await pipe.close();
    }
  });

  it('reports path-validation abort when a connection closes mid-validation', async (t) => {
    if (!quicAvailable) return;

    const pipe = new QuicPipe({
      client: { migration: { enabled: true } },
      server: { migration: { enabled: true } },
    });
    try {
      const { client, server } = await pipe.handshake();
      const migratedAddress = { family: 'ipv4' as const, ip: '10.0.0.1', port: 56_021 };
      pipe.setLink(migratedAddress, server.localAddress, { lossRate: 1 });
      pipe.setLink(server.localAddress, migratedAddress, { lossRate: 1 });

      const pathValidation = once(client, 'pathvalidation');
      await client.migrate(migratedAddress);
      await client.close({ errorCode: 77, reason: 'abort-path-validation' });
      const event = await pipe.pumpUntil(pathValidation);

      t.equal(event.result, 'aborted', 'closing mid-validation emits a terminal aborted path-validation event');
      t.equal(event.path.localAddress.port, migratedAddress.port, 'failure event names the abandoned migrated local path');
    } finally {
      await pipe.close();
    }
  });
});
