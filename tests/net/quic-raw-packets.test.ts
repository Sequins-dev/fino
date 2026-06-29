import { describe, it } from 'fino:test/test';
import { QuicEndpoint, QuicVersionNegotiationError, quicAvailable, type QuicAddress } from 'fino:net/quic';
import {
  QuicPipe,
  SimulatedQuicDatagramTransportFactory,
  SimulatedQuicRuntime,
} from './fixtures/quic/sim-harness.ts';
import { QUIC_V2, makeVersionNegotiationPacket } from './fixtures/quic/packet-craft.ts';
import { parseQuicHeader } from './fixtures/quic/packet-parse.ts';

const QUIC_V1 = 0x00000001;

function newSimClient(pipe: QuicPipe, localAddress: QuicAddress): QuicEndpoint {
  return new QuicEndpoint({ alpnProtocols: ['fino-hq'] }, {
    transportFactory: pipe.transportFactory as SimulatedQuicDatagramTransportFactory,
    runtime: pipe.runtime as SimulatedQuicRuntime,
    clientBindAddress: localAddress,
  } as any);
}

describe('QUIC raw packet conformance', () => {
  it('retries connection on Version Negotiation offering a mutually-supported alternative version', async (t) => {
    if (!quicAvailable) return;

    const clientAddress = { family: 'ipv4' as const, ip: '10.0.0.1', port: 56_020 };
    const pipe = new QuicPipe();
    const clientEndpoint = newSimClient(pipe, clientAddress);
    try {
      const listener = await pipe.listen();
      pipe.setLink(clientAddress, listener.address, { latencyMs: 100 });
      const accepted = pipe.server.accept();
      const connected = clientEndpoint.connect({ address: listener.address, serverName: 'localhost' });

      const firstFlight = await pipe.pumpUntilCondition(() => pipe.queuedDatagrams(clientAddress, listener.address)[0]);
      const firstHeader = parseQuicHeader(firstFlight);

      pipe.rawDatagram(makeVersionNegotiationPacket({
        destinationConnectionId: firstHeader.sourceConnectionId,
        sourceConnectionId: firstHeader.destinationConnectionId,
        versions: [QUIC_V2],
      }), listener.address, clientAddress);

      pipe.setLink(clientAddress, listener.address, { latencyMs: 0 });
      const [client, server] = await pipe.pumpUntil(Promise.all([connected, accepted]), 5000);

      t.equal(client.handshakeComplete, true, 'client completes handshake after VN-triggered version retry');
      t.equal(server.handshakeComplete, true, 'server completes handshake after VN-triggered version retry');
    } finally {
      await clientEndpoint.close();
      await pipe.close();
    }
  });

  it('rejects connect with QuicVersionNegotiationError when no mutual version found', async (t) => {
    if (!quicAvailable) return;

    const UNSUPPORTED_VERSION = 0xabcd1234;
    const clientAddress = { family: 'ipv4' as const, ip: '10.0.0.1', port: 56_021 };
    const pipe = new QuicPipe();
    const clientEndpoint = newSimClient(pipe, clientAddress);
    try {
      const listener = await pipe.listen();
      pipe.setLink(clientAddress, listener.address, { latencyMs: 100 });
      const connected = clientEndpoint.connect({ address: listener.address, serverName: 'localhost' });

      const firstFlight = await pipe.pumpUntilCondition(() => pipe.queuedDatagrams(clientAddress, listener.address)[0]);
      const firstHeader = parseQuicHeader(firstFlight);

      pipe.rawDatagram(makeVersionNegotiationPacket({
        destinationConnectionId: firstHeader.sourceConnectionId,
        sourceConnectionId: firstHeader.destinationConnectionId,
        versions: [UNSUPPORTED_VERSION],
      }), listener.address, clientAddress);

      const error = await pipe.pumpUntil(connected.then(() => null, (e: unknown) => e), 3000);
      t.ok(error instanceof QuicVersionNegotiationError, 'connect rejects with QuicVersionNegotiationError');
      if (error instanceof QuicVersionNegotiationError) {
        t.ok(error.requestedVersions.includes(UNSUPPORTED_VERSION), 'error carries the VN packet versions');
      }
      const packetsToServerAfterVN = pipe.queuedDatagrams(clientAddress, listener.address).length;
      await pipe.runUntilIdle();
      t.equal(
        pipe.queuedDatagrams(clientAddress, listener.address).length,
        packetsToServerAfterVN,
        'client does not send CONNECTION_CLOSE in response to incompatible VN (local failure only, per RFC 9000 §6.2)',
      );
    } finally {
      await clientEndpoint.close();
      await pipe.close();
    }
  });

  it('silently ignores Version Negotiation with a mismatched destination connection ID', async (t) => {
    if (!quicAvailable) return;

    const clientAddress = { family: 'ipv4' as const, ip: '10.0.0.1', port: 56_030 };
    const pipe = new QuicPipe();
    const clientEndpoint = newSimClient(pipe, clientAddress);
    try {
      const listener = await pipe.listen();
      pipe.setLink(clientAddress, listener.address, { latencyMs: 100 });
      const accepted = pipe.server.accept();
      const connected = clientEndpoint.connect({ address: listener.address, serverName: 'localhost' });
      const firstFlight = await pipe.pumpUntilCondition(() => pipe.queuedDatagrams(clientAddress, listener.address)[0]);
      const firstHeader = parseQuicHeader(firstFlight);

      // RFC 9000 §6.2: a client MUST discard a Version Negotiation packet whose
      // Destination Connection ID does not match the Source Connection ID from its
      // Initial packet. Forge such a packet using a bit-flipped DCID.
      const scrambledDcid = new Uint8Array(firstHeader.sourceConnectionId.map((b) => ~b & 0xff));
      pipe.rawDatagram(makeVersionNegotiationPacket({
        destinationConnectionId: scrambledDcid,
        sourceConnectionId: firstHeader.destinationConnectionId,
        versions: [QUIC_V2], // mutually-supported — would trigger retry if accepted
      }), listener.address, clientAddress);

      pipe.setLink(clientAddress, listener.address, { latencyMs: 0 });
      const [client, server] = await pipe.pumpUntil(Promise.all([connected, accepted]), 5000);

      t.equal(client.handshakeComplete, true, 'client completes handshake after bad-CID VN is silently discarded');
      t.equal(server.handshakeComplete, true, 'server completes handshake after bad-CID VN is silently discarded');
    } finally {
      await clientEndpoint.close();
      await pipe.close();
    }
  });

  it('ignores forged Version Negotiation that lists the current version', async (t) => {
    if (!quicAvailable) return;

    const clientAddress = { family: 'ipv4' as const, ip: '10.0.0.1', port: 56_010 };
    const pipe = new QuicPipe();
    const clientEndpoint = newSimClient(pipe, clientAddress);
    try {
      const listener = await pipe.listen();
      pipe.setLink(clientAddress, listener.address, { latencyMs: 100 });
      const accepted = pipe.server.accept();
      const connected = clientEndpoint.connect({ address: listener.address, serverName: 'localhost' });
      const firstFlight = await pipe.pumpUntilCondition(() => pipe.queuedDatagrams(clientAddress, listener.address)[0]);
      const firstHeader = parseQuicHeader(firstFlight);

      pipe.rawDatagram(makeVersionNegotiationPacket({
        destinationConnectionId: firstHeader.sourceConnectionId,
        sourceConnectionId: firstHeader.destinationConnectionId,
        versions: [QUIC_V1, QUIC_V2],
      }), listener.address, clientAddress);
      pipe.setLink(clientAddress, listener.address, { latencyMs: 0 });
      const [client, server] = await pipe.pumpUntil(Promise.all([connected, accepted]));

      t.equal(client.handshakeComplete, true, 'client stays usable after forged VN');
      t.equal(server.handshakeComplete, true, 'server completes after forged VN is ignored');
    } finally {
      await clientEndpoint.close();
      await pipe.close();
    }
  });
});
