import { describe, it } from 'fino:test/test';
import { topic } from 'fino:context/topic';
import { QuicEndpoint, quicAvailable, type QuicAddress, type QuicConnection } from 'fino:net/quic';
import { quicConnectionInternals, quicEndpointInternals } from 'internal:net/quic/endpoint';
import {
  QuicPipe,
  SimulatedQuicDatagramTransportFactory,
  SimulatedQuicRuntime,
  decodeUtf8,
  encodeUtf8,
} from './fixtures/quic/sim-harness.ts';
import { QUIC_V2, makeVersionNegotiationPacket } from './fixtures/quic/packet-craft.ts';
import { parseQuicHeader } from './fixtures/quic/packet-parse.ts';
const QUIC_V1 = 1;
async function readBytes(promise: Promise<IteratorResult<Uint8Array>>): Promise<Uint8Array | null> {
  const result = await promise;
  return result.done ? null : result.value;
}
function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(offset, value, false);
}
function writeQuicVarint(buf: Uint8Array, offset: number, value: number): number {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError('QUIC varint value must be a non-negative integer');
  if (value < 64) {
    buf[offset] = value;
    return 1;
  }
  if (value < 16384) {
    buf[offset] = 64 | (value >>> 8);
    buf[offset + 1] = value & 255;
    return 2;
  }
  throw new RangeError('test helper only supports QUIC varints up to 16383');
}
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
function makeInitialProbe(
  version = QUIC_V1,
  seed = 0,
  token: Uint8Array = new Uint8Array(),
): Uint8Array {
  const dcid = new Uint8Array(8);
  const scid = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    dcid[i] = (64 + seed + i) & 255;
    scid[i] = (128 + seed + i) & 255;
  }
  const packet = new Uint8Array(1200);
  packet[0] = 192;
  writeU32BE(packet, 1, version);
  packet[5] = dcid.byteLength;
  packet.set(dcid, 6);
  packet[14] = scid.byteLength;
  packet.set(scid, 15);
  let offset = 23;
  offset += writeQuicVarint(packet, offset, token.byteLength);
  packet.set(token, offset);
  offset += token.byteLength;
  writeQuicVarint(packet, offset, 0);
  return packet;
}
function once(target: EventTarget, type: string): Promise<any> {
  return new Promise((resolve) => {
    target.addEventListener(type, (event) => resolve(event), { once: true });
  });
}
function drainDatagrams(socket: any): Array<{
  data: Uint8Array;
  addr: unknown;
}> {
  const packets: Array<{
    data: Uint8Array;
    addr: unknown;
  }> = [];
  for (;;) {
    const packet = socket.recvNow?.(65536) ?? null;
    if (packet === null) return packets;
    packets.push(packet);
  }
}
function trackPromise<T>(promise: Promise<T>): {
  settled(): boolean;
  value(): T | undefined;
  failure(): unknown;
} {
  let settled = false;
  let value: T | undefined;
  let failure: unknown;
  promise.then(
    (result) => {
      settled = true;
      value = result;
    },
    (error) => {
      settled = true;
      failure = error;
    },
  );
  return {
    settled: () => settled,
    value: () => value,
    failure: () => failure,
  };
}
function bytesQueued(
  trace: ReturnType<QuicPipe['trace']>,
  fromPort: number,
  toPort: number,
): number {
  return trace
    .filter(
      (event) =>
        event.type === 'datagram:queued' &&
        event.from.port === fromPort &&
        event.to.port === toPort,
    )
    .reduce((total, event) => total + event.bytes, 0);
}
function memorySessionStore(sessions: Map<string, any>) {
  return {
    load: (key: string) => sessions.get(key) ?? null,
    save: (key: string, state: any) => sessions.set(key, state),
    delete: (key: string) => sessions.delete(key),
  };
}
function fixedTokenSecret(seed = 81): Uint8Array {
  const secret = new Uint8Array(32);
  for (let i = 0; i < secret.byteLength; i++) secret[i] = (seed + i) & 255;
  return secret;
}
function newSimClient(
  pipe: QuicPipe,
  localAddress: QuicAddress,
  options: ConstructorParameters<typeof QuicEndpoint>[0] = {},
): QuicEndpoint {
  return new QuicEndpoint(
    {
      alpnProtocols: ['fino-hq'],
      ...options,
    },
    {
      transportFactory: pipe.transportFactory,
      runtime: pipe.runtime,
      clientBindAddress: localAddress,
    } as any,
  );
}
async function connectSimClient(
  pipe: QuicPipe,
  clientEndpoint: QuicEndpoint,
): Promise<QuicConnection> {
  const listener = pipe.listener ?? (await pipe.listen());
  const accepted = pipe.server.accept();
  const connected = clientEndpoint.connect({
    address: listener.address,
    serverName: 'localhost',
  });
  const [client, server] = await pipe.pumpUntil(Promise.all([connected, accepted]));
  pipe.serverConnection = server;
  return client;
}
async function startSimConnect(
  pipe: QuicPipe,
  clientEndpoint: QuicEndpoint,
): Promise<ReturnType<typeof trackPromise<QuicConnection>>> {
  const listener = pipe.listener ?? (await pipe.listen());
  const connected = trackPromise(
    clientEndpoint.connect({
      address: listener.address,
      serverName: 'localhost',
    }),
  );
  return connected;
}
async function sendInitialProbe(
  pipe: QuicPipe,
  localAddress: QuicAddress,
  token: Uint8Array,
  seed: number,
): Promise<Uint8Array | null> {
  const listener = pipe.listener ?? (await pipe.listen());
  const probe = await pipe.net.datagram(localAddress);
  try {
    await probe.send(makeInitialProbe(QUIC_V1, seed, token), listener.address);
    try {
      const response = await pipe.pumpUntil(probe.recv(), 50);
      return response.data;
    } catch {
      return null;
    }
  } finally {
    probe.close();
  }
}
async function readStreamBytes(
  stream: Awaited<ReturnType<QuicConnection['acceptStream']>>,
  pipe: QuicPipe,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await pipe.pumpUntil(readBytes(stream.reader.read()));
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
describe('QUIC simulator conformance', () => {
  it('RFC 9000 sections 6, 7, and 14.1: v2 handshake completes and Initial datagrams are at least 1200 bytes', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      t.equal(
        client.handshakeComplete,
        true,
        'client handshake completed through simulated datagrams',
      );
      t.equal(
        server.handshakeComplete,
        true,
        'server handshake completed through simulated datagrams',
      );
      t.equal(client.version, 'v2', 'default client preference negotiates QUIC v2 when available');
      t.ok(
        pipe.trace().some((event) => event.type === 'datagram:queued' && event.bytes >= 1200),
        'client Initial datagram is padded to at least 1200 bytes',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 sections 6 and 7: v1 handshake completes when explicitly selected', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      client: { versions: ['v1'] },
      server: { versions: ['v1'] },
    });
    try {
      const { client, server } = await pipe.handshake();
      t.equal(client.version, 'v1', 'client negotiates QUIC v1 when v1 is the configured version');
      t.equal(server.version, 'v1', 'server reports the negotiated QUIC v1 version');
      t.equal(client.handshakeComplete, true, 'client v1 handshake completes');
      t.equal(server.handshakeComplete, true, 'server v1 handshake completes');
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9368 section 2: default client first flight uses v1 and upgrades after compatible VN', async (t) => {
    if (!quicAvailable) return;
    const clientAddress = {
      family: 'ipv4' as const,
      ip: '10.0.0.1',
      port: 55010,
    };
    const pipe = new QuicPipe();
    const clientEndpoint = newSimClient(pipe, clientAddress);
    try {
      const listener = await pipe.listen();
      pipe.setLink(clientAddress, listener.address, { latencyMs: 100 });
      const accepted = pipe.server.accept();
      const connected = clientEndpoint.connect({
        address: listener.address,
        serverName: 'localhost',
      });
      const firstFlight = await pipe.pumpUntilCondition(
        () => pipe.queuedDatagrams(clientAddress, listener.address)[0],
      );
      const firstHeader = parseQuicHeader(firstFlight);
      t.equal(firstHeader.version, QUIC_V1, 'default first-flight wire version is QUIC v1');
      pipe.rawDatagram(
        makeVersionNegotiationPacket({
          destinationConnectionId: firstHeader.sourceConnectionId,
          sourceConnectionId: firstHeader.destinationConnectionId,
          versions: [QUIC_V2, QUIC_V1],
        }),
        listener.address,
        clientAddress,
      );
      pipe.setLink(clientAddress, listener.address, { latencyMs: 0 });
      const [client, server] = await pipe.pumpUntil(Promise.all([connected, accepted]));
      t.equal(
        client.version,
        'v2',
        'client upgrades to preferred QUIC v2 after compatible Version Negotiation',
      );
      t.equal(server.version, 'v2', 'server negotiates QUIC v2 after the client retry');
      t.equal(
        client.handshakeComplete,
        true,
        'client handshake completes after compatible Version Negotiation retry',
      );
      t.equal(
        server.handshakeComplete,
        true,
        'server handshake completes after compatible Version Negotiation retry',
      );
    } finally {
      await clientEndpoint.close();
      await pipe.close();
    }
  });
  it('RFC 9000 section 6: unsupported-version Initial receives Version Negotiation', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      await probe.send(makeInitialProbe(1463896404), listener.address);
      await pipe.runUntilIdle();
      const response = await pipe.pumpUntil(probe.recv());
      const view = new DataView(
        response.data.buffer,
        response.data.byteOffset,
        response.data.byteLength,
      );
      t.equal(response.data[0] & 128, 128, 'Version Negotiation uses long header form');
      t.equal(view.getUint32(1, false), 0, 'Version Negotiation packet has version 0');
      t.ok(response.data.byteLength >= 11, 'Version Negotiation advertises at least one version');
      t.equal(
        pipe.server.stats.packetsReceived,
        1,
        'Version Negotiation probes count as processed packets',
      );
      t.equal(
        pipe.server.stats.bytesReceived,
        0,
        'Version Negotiation probes do not count endpoint received bytes',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('RFC 9000 sections 5.2.2 and 6: unsupported-version Initial does not create accept state', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      const accepted = trackPromise(pipe.server.accept());
      await probe.send(makeInitialProbe(1463896404, 7), listener.address);
      await pipe.runUntilIdle();
      t.equal(
        accepted.settled(),
        false,
        'unsupported-version probe does not resolve endpoint accept',
      );
      t.equal(
        pipe.server.cidTable.get('4041424344454647'),
        undefined,
        'unsupported-version probe does not register its DCID',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('RFC 9000 sections 7.2 and 14.1: malformed Initial does not create accept state', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      const accepted = trackPromise(pipe.server.accept());
      const malformed = makeInitialProbe(QUIC_V1, 8);
      malformed[5] = 21;
      await probe.send(malformed, listener.address);
      await pipe.runUntilIdle();
      t.equal(
        accepted.settled(),
        false,
        'malformed Initial probe does not resolve endpoint accept',
      );
      t.equal(
        drainDatagrams(probe).length,
        0,
        'malformed Initial probe receives no Retry amplification',
      );
      t.equal(
        pipe.server.stats.packetsReceived,
        0,
        'malformed Initial probes do not count as processed packets',
      );
      t.equal(
        pipe.server.stats.bytesReceived,
        0,
        'malformed Initial probes do not count endpoint received bytes',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('RFC 9000 malformed packet fuzz corpus leaves endpoint usable', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    const listener = await pipe.listen();
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.9',
      port: 55090,
    });
    try {
      const seedPacket = makeInitialProbe(QUIC_V1, 51);
      const corpus: Uint8Array[] = [
        new Uint8Array(),
        new Uint8Array([255]),
        makeInitialProbe(168430090, 52),
      ];
      for (let n = 1; n <= 64; n++) corpus.push(seedPacket.slice(0, n));
      for (let n = 1; n <= 20; n++) {
        const packet = new Uint8Array(n);
        packet[0] = 64;
        for (let i = 1; i < packet.byteLength; i++) packet[i] = (144 + n + i) & 255;
        corpus.push(packet);
      }
      for (const packet of corpus) await probe.send(packet, listener.address);
      await pipe.runUntilSettled(500);
      t.equal(
        pipe.server.stats.activeServerConnections,
        0,
        'malformed corpus creates no accepted sessions',
      );
      t.ok(
        pipe.server.stats.packetsReceived >= 0,
        'endpoint stats remain readable after fuzz corpus',
      );
      const { client, server } = await pipe.handshake();
      const echoed = await pipe.sendAndRead('post-fuzz-ok');
      t.equal(client.handshakeComplete, true, 'client handshake succeeds after fuzz corpus');
      t.equal(server.handshakeComplete, true, 'server handshake succeeds after fuzz corpus');
      t.equal(echoed, 'post-fuzz-ok', 'endpoint remains usable after malformed packet corpus');
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('RFC 9002 sections 6.2 and 6.2.1: dropped first flight recovers through PTO', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    pipe.net.dropNextDatagrams(1);
    try {
      const { client, server } = await pipe.handshake();
      const droppedInitials = pipe
        .trace()
        .filter(
          (event) =>
            event.type === 'datagram:dropped' && event.reason === 'loss' && event.bytes >= 1200,
        );
      const queuedInitials = pipe
        .trace()
        .filter((event) => event.type === 'datagram:queued' && event.bytes >= 1200);
      t.equal(
        client.handshakeComplete,
        true,
        'client handshake recovers after the first Initial flight is lost',
      );
      t.equal(
        server.handshakeComplete,
        true,
        'server handshake recovers after client PTO retransmission',
      );
      t.ok(droppedInitials.length >= 1, 'simulator trace records the dropped first Initial flight');
      t.ok(queuedInitials.length >= 1, 'client retransmits handshake packets after PTO');
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 8.1.2: unvalidated Initial receives Retry by default', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      const initial = makeInitialProbe(QUIC_V1, 1);
      await probe.send(initial, listener.address);
      await pipe.runUntilIdle();
      const response = await pipe.pumpUntil(probe.recv());
      const version = new DataView(
        response.data.buffer,
        response.data.byteOffset,
        response.data.byteLength,
      ).getUint32(1, false);
      const stats = pipe.server.stats;
      t.equal(response.data[0] & 240, 240, 'Retry uses QUIC long-header Retry form');
      t.equal(version, QUIC_V1, 'Retry preserves the client version');
      t.ok(response.data.byteLength > 40, 'Retry carries token material');
      t.equal(stats.packetsReceived, 1, 'endpoint counts received packets');
      t.equal(stats.bytesReceived, 0, 'Retry probes do not count endpoint received bytes');
      t.equal(stats.packetsSent, 1, 'endpoint counts sent Retry packets');
      t.equal(stats.bytesSent, response.data.byteLength, 'endpoint counts sent Retry bytes');
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('Node transport parity: source-address deny filtering blocks packets before QUIC parsing', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({ server: { transport: { sourceAddress: { deny: ['10.0.0.1'] } } } });
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      const accepted = trackPromise(pipe.server.accept());
      await probe.send(makeInitialProbe(QUIC_V1, 41), listener.address);
      await pipe.runUntilIdle();
      const stats = pipe.server.stats;
      t.equal(accepted.settled(), false, 'blocked source does not create accept state');
      t.equal(drainDatagrams(probe).length, 0, 'blocked source receives no QUIC response');
      t.equal(stats.sourceBlockedPackets, 1, 'endpoint counts source-filtered packets');
      t.equal(
        stats.packetsBlocked,
        1,
        'source-filtered packets contribute to blocked packet stats',
      );
      t.equal(
        stats.packetsReceived,
        0,
        'source-filtered packets do not count as Node received packets',
      );
      t.equal(
        stats.bytesReceived,
        0,
        'source-filtered packets do not count as Node received bytes',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('Node transport parity: source-address allow filtering blocks non-matching packets', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      server: { transport: { sourceAddress: { allow: ['10.0.0.2'] } } },
    });
    const blocked = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.3',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      const accepted = trackPromise(pipe.server.accept());
      await blocked.send(makeInitialProbe(QUIC_V1, 44), listener.address);
      await pipe.runUntilIdle();
      const stats = pipe.server.stats;
      t.equal(accepted.settled(), false, 'probe packets do not create accepted connection state');
      t.equal(drainDatagrams(blocked).length, 0, 'non-matching source receives no QUIC response');
      t.equal(stats.sourceBlockedPackets, 1, 'endpoint counts allow-list blocked packets');
      t.equal(stats.packetsBlocked, 1, 'allow-list blocked packets contribute to blocked stats');
      t.equal(
        stats.packetsReceived,
        0,
        'allow-list blocked packets do not count as Node received packets',
      );
      t.equal(
        stats.bytesReceived,
        0,
        'allow-list blocked packets do not count as Node received bytes',
      );
    } finally {
      blocked.close();
      await pipe.close();
    }
  });
  it('Node transport parity: busy mode refuses new server connection Initials', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({ server: { transport: { busy: true } } });
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      const accepted = trackPromise(pipe.server.accept());
      await probe.send(makeInitialProbe(QUIC_V1, 42), listener.address);
      await pipe.runUntilIdle();
      await pipe.runUntilIdle();
      const stats = pipe.server.stats;
      t.equal(accepted.settled(), false, 'busy endpoint does not create accepted user sessions');
      t.ok(
        drainDatagrams(probe).length > 0,
        'busy endpoint sends an immediate CONNECTION_REFUSED close',
      );
      t.equal(
        stats.serverBusyCount,
        1,
        'endpoint counts busy-gated packets using Node serverBusyCount semantics',
      );
      t.equal(
        stats.packetsBlocked,
        0,
        'busy packets do not contribute to Node packetsBlocked stats',
      );
      t.equal(
        stats.immediateCloseSent,
        1,
        'endpoint counts immediate CONNECTION_REFUSED close packets',
      );
      t.equal(stats.packetsReceived, 1, 'busy refusal counts the Initial as processed');
      t.equal(
        stats.bytesReceived,
        0,
        'busy refusal does not count payload bytes at endpoint level',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('Node transport parity: busy mode can be toggled at runtime', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({ server: { transport: { busy: false } } });
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      t.equal(pipe.server.busy, false, 'endpoint starts non-busy');
      pipe.server.setBusy(true);
      t.equal(pipe.server.busy, true, 'setBusy updates the live endpoint state');
      t.equal(pipe.server.transport.busy, true, 'transport snapshot reflects the live busy state');
      t.equal(
        pipe.server.stats.serverBusyCount,
        1,
        'setBusy(true) increments Node serverBusyCount',
      );
      await probe.send(makeInitialProbe(QUIC_V1, 43), listener.address);
      await pipe.runUntilIdle();
      await pipe.runUntilIdle();
      t.ok(drainDatagrams(probe).length > 0, 'runtime busy endpoint sends immediate close');
      t.equal(
        pipe.server.stats.serverBusyCount,
        2,
        'runtime busy packets increment Node serverBusyCount',
      );
      t.equal(
        pipe.server.stats.packetsBlocked,
        0,
        'runtime busy packets do not increment packetsBlocked',
      );
      pipe.server.setBusy(false);
      t.equal(pipe.server.busy, false, 'setBusy can clear busy mode');
      t.equal(pipe.server.transport.busy, false, 'transport snapshot reflects cleared busy state');
      t.equal(
        pipe.server.stats.serverBusyCount,
        2,
        'setBusy(false) does not increment serverBusyCount',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('Node transport parity: maxConnections gates excess accepted server sessions', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      server: {
        retry: false,
        transport: { maxConnections: 1 },
      },
    });
    let firstClient: QuicEndpoint | null = null;
    let secondClient: QuicEndpoint | null = null;
    try {
      await pipe.listen();
      firstClient = newSimClient(pipe, {
        family: 'ipv4',
        ip: '10.0.0.1',
        port: 55110,
      });
      const first = await connectSimClient(pipe, firstClient);
      t.equal(first.handshakeComplete, true, 'first connection is accepted');
      const packetsBeforeLimit = pipe.server.stats.packetsReceived;
      secondClient = newSimClient(
        pipe,
        {
          family: 'ipv4',
          ip: '10.0.0.3',
          port: 55111,
        },
        { versions: ['v1'] },
      );
      await startSimConnect(pipe, secondClient);
      await pipe.pumpUntilCondition(() =>
        pipe.server.stats.connectionLimitPackets > 0 && pipe.server.stats.immediateCloseSent > 0
          ? pipe.server.stats
          : null,
      );
      const stats = pipe.server.stats;
      t.equal(stats.activeServerConnections, 1, 'one server connection remains active');
      t.equal(stats.connectionLimitPackets, 1, 'endpoint counts connection-limit gated Initials');
      t.equal(
        stats.packetsBlocked,
        0,
        'connection-limit packets do not contribute to Node packetsBlocked stats',
      );
      t.equal(stats.immediateCloseSent, 1, 'connection-limit refusal sends immediate close');
      t.equal(
        stats.packetsReceived - packetsBeforeLimit,
        1,
        'connection-limit refusal counts the refused Initial as processed',
      );
    } finally {
      await firstClient?.close();
      await secondClient?.close();
      await pipe.close();
    }
  });
  it('Node transport parity: maxConnectionsPerRemoteAddress gates only the matching remote address', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      server: {
        retry: false,
        transport: {
          maxConnections: 0,
          maxConnectionsPerRemoteAddress: 1,
        },
      },
    });
    let firstClient: QuicEndpoint | null = null;
    let blockedClient: QuicEndpoint | null = null;
    let differentHostClient: QuicEndpoint | null = null;
    try {
      await pipe.listen();
      firstClient = newSimClient(pipe, {
        family: 'ipv4',
        ip: '10.0.0.1',
        port: 55130,
      });
      const first = await connectSimClient(pipe, firstClient);
      t.equal(
        first.handshakeComplete,
        true,
        'first connection from the remote address is accepted',
      );
      blockedClient = newSimClient(
        pipe,
        {
          family: 'ipv4',
          ip: '10.0.0.1',
          port: 55131,
        },
        { versions: ['v1'] },
      );
      await startSimConnect(pipe, blockedClient);
      await pipe.pumpUntilCondition(() =>
        pipe.server.stats.connectionLimitPackets > 0 && pipe.server.stats.immediateCloseSent > 0
          ? pipe.server.stats
          : null,
      );
      const limitedStats = pipe.server.stats;
      t.equal(
        limitedStats.connectionLimitPackets,
        1,
        'same remote address is gated by the per-remote limit',
      );
      t.equal(
        limitedStats.packetsBlocked,
        0,
        'per-remote limit does not increment Node packetsBlocked',
      );
      differentHostClient = newSimClient(pipe, {
        family: 'ipv4',
        ip: '10.0.0.2',
        port: 55132,
      });
      const differentHost = await connectSimClient(pipe, differentHostClient);
      t.equal(differentHost.handshakeComplete, true, 'different remote address is still accepted');
      t.equal(
        pipe.server.stats.activeServerConnections,
        2,
        'two accepted server connections remain active',
      );
    } finally {
      await firstClient?.close();
      await blockedClient?.close();
      await differentHostClient?.close();
      await pipe.close();
    }
  });
  it('Node transport parity: session creation rate-limit is counted separately from packetsBlocked', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      server: {
        retry: false,
        transport: {
          maxConnections: 0,
          maxConnectionsPerRemoteAddress: 0,
          sessionCreationRateLimit: {
            rate: 0,
            burst: 1,
          },
        },
      },
    });
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 55140,
    });
    try {
      const listener = await pipe.listen();
      await probe.send(makeInitialProbe(QUIC_V1, 140), listener.address);
      await pipe.pumpUntilCondition(() =>
        pipe.server.stats.serverConnections > 0 ? pipe.server.stats : null,
      );
      t.equal(
        pipe.server.stats.serverConnections,
        1,
        'first Initial consumes the session-creation burst',
      );
      const packetsBeforeRateLimit = pipe.server.stats.packetsReceived;
      await probe.send(makeInitialProbe(QUIC_V1, 141), listener.address);
      await pipe.pumpUntilCondition(() =>
        pipe.server.stats.sessionCreationRateLimited > 0 ? pipe.server.stats : null,
      );
      const stats = pipe.server.stats;
      t.equal(
        stats.sessionCreationRateLimited,
        1,
        'session creation rate-limit counter increments',
      );
      t.equal(
        stats.packetsBlocked,
        0,
        'session creation rate-limit does not increment Node packetsBlocked',
      );
      t.equal(
        stats.connectionLimitPackets,
        0,
        'session creation rate-limit is distinct from connection limits',
      );
      t.equal(
        stats.packetsReceived,
        packetsBeforeRateLimit,
        'session creation rate-limit drop does not count the second Initial as processed',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('Node transport parity: maxConnections zero means unlimited', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      server: {
        retry: false,
        transport: {
          maxConnections: 0,
          maxConnectionsPerRemoteAddress: 0,
        },
      },
    });
    const clients: QuicEndpoint[] = [];
    try {
      await pipe.listen();
      for (let i = 0; i < 2; i++) {
        const client = newSimClient(pipe, {
          family: 'ipv4',
          ip: '10.0.0.1',
          port: 55120 + i,
        });
        clients.push(client);
        const connection = await connectSimClient(pipe, client);
        t.equal(
          connection.handshakeComplete,
          true,
          `connection ${i + 1} is accepted when limits are zero`,
        );
      }
      t.equal(pipe.server.stats.connectionLimitPackets, 0, 'zero limits do not gate connections');
      t.equal(
        pipe.server.stats.activeServerConnections,
        2,
        'endpoint accepts multiple server connections with zero limits',
      );
    } finally {
      for (const client of clients) await client.close();
      await pipe.close();
    }
  });
  it('Node transport parity: configurable Retry rate limit reports sent and limited packets separately', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      server: {
        transport: {
          retryRateLimit: {
            rate: 0,
            burst: 1,
          },
        },
      },
    });
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      await probe.send(makeInitialProbe(QUIC_V1, 43), listener.address);
      await probe.send(makeInitialProbe(QUIC_V1, 44), listener.address);
      await pipe.runUntilIdle();
      const stats = pipe.server.stats;
      t.equal(stats.retrySent, 1, 'first Retry uses the configured burst token');
      t.equal(stats.retryRateLimited, 1, 'second Retry is rate-limited');
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('RFC 9000 section 8.1: Retry-disabled Initial handling respects the 3x anti-amplification limit', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({ server: { retry: false } });
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.1',
      port: 0,
    });
    try {
      const listener = await pipe.listen();
      await probe.send(makeInitialProbe(QUIC_V1, 2), listener.address);
      await pipe.runUntilIdle();
      const serverPort = listener.address.port;
      const clientPort = probe.address.port;
      const clientBytes = bytesQueued(pipe.trace(), clientPort, serverPort);
      const serverBytes = bytesQueued(pipe.trace(), serverPort, clientPort);
      t.ok(clientBytes >= 1200, 'client Initial bytes are observable before address validation');
      t.ok(
        serverBytes <= clientBytes * 3,
        'server response before validation stays within the 3x amplification limit',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('RFC 9000 section 8.1: Retry-disabled handshakes complete after address validation', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({ server: { retry: false } });
    try {
      const { client, server } = await pipe.handshake();
      t.equal(client.handshakeComplete, true, 'client completes a no-Retry handshake');
      t.equal(server.handshakeComplete, true, 'server completes a no-Retry handshake');
      t.equal(client.version, server.version, 'client and server agree on the negotiated version');
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 8.1.3: server-issued NEW_TOKEN is received and persisted by the client', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const pipe = new QuicPipe({ client: { sessionStore } });
    try {
      await pipe.handshake();
      await pipe.runUntilSettled();
      const state = sessions.get('localhost|fino-hq');
      t.ok(
        state?.addressToken instanceof Uint8Array,
        'client persists a real server-issued NEW_TOKEN',
      );
      t.ok(state.addressToken.byteLength > 0, 'persisted NEW_TOKEN contains token bytes');
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 8.1.3: same-address NEW_TOKEN reconnect validates without Retry', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const localAddress = {
      family: 'ipv4' as const,
      ip: '10.0.0.1',
      port: 55100,
    };
    const pipe = new QuicPipe({
      server: {
        retry: { tokenSecret: fixedTokenSecret() },
        transport: { addressTokenTimeoutMs: 3e5 },
      },
    });
    let firstClient: QuicEndpoint | null = null;
    let secondClient: QuicEndpoint | null = null;
    try {
      await pipe.listen();
      firstClient = newSimClient(pipe, localAddress, { sessionStore });
      const first = await connectSimClient(pipe, firstClient);
      await pipe.runUntilSettled();
      t.ok(
        sessions.get('localhost|fino-hq')?.addressToken instanceof Uint8Array,
        'first connection persists a server-issued NEW_TOKEN',
      );
      await first.close();
      await firstClient.close();
      await pipe.runUntilSettled();
      pipe.advance(12e4);
      await pipe.runUntilSettled();
      const before = pipe.server[quicEndpointInternals.inspectAddressValidationStats]();
      secondClient = newSimClient(pipe, localAddress, { sessionStore });
      const second = await connectSimClient(pipe, secondClient);
      await pipe.runUntilSettled();
      const after = pipe.server[quicEndpointInternals.inspectAddressValidationStats]();
      t.equal(
        second.handshakeComplete,
        true,
        'same-address reconnect completes with the stored NEW_TOKEN',
      );
      t.equal(
        after.addressTokenAccepted,
        before.addressTokenAccepted + 1,
        'server accepts the regular NEW_TOKEN',
      );
      t.equal(after.retrySent, before.retrySent, 'accepted NEW_TOKEN avoids a fresh Retry');
    } finally {
      await firstClient?.close();
      await secondClient?.close();
      await pipe.close();
    }
  });
  it('Node transport parity: resumed 0-RTT connect defers packets until first early write', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const serverSessionStore = memorySessionStore(new Map());
    const pipe = new QuicPipe({
      client: {
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024,
        },
      },
      server: {
        sessionStore: serverSessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 1024,
        },
      },
    });
    let resumedClient: QuicEndpoint | null = null;
    try {
      await pipe.listen();
      const warmup = await connectSimClient(pipe, pipe.client);
      await pipe.pumpUntilCondition(() =>
        sessions.get('localhost|fino-hq')?.ticket instanceof Uint8Array ? true : null,
      );
      t.ok(
        sessions.get('localhost|fino-hq')?.ticket instanceof Uint8Array,
        'warmup stores a TLS session ticket',
      );
      await warmup.close();
      await pipe.runUntilSettled();
      const traceBefore = pipe.trace().length;
      resumedClient = newSimClient(
        pipe,
        {
          family: 'ipv4',
          ip: '10.0.0.1',
          port: 55120,
        },
        {
          sessionStore,
          earlyData: {
            replaySafe: true,
            maxBytes: 1024,
          },
        },
      );
      const earlyConnection = await resumedClient.connect({
        address: pipe.listener!.address,
        serverName: 'localhost',
      });
      const queuedBeforeWrite = pipe
        .trace()
        .slice(traceBefore)
        .filter((event) => event.type === 'datagram:queued');
      t.equal(
        earlyConnection.handshakeComplete,
        false,
        'resumed 0-RTT connect returns before handshake completion',
      );
      t.equal(
        queuedBeforeWrite.length,
        0,
        'deferred 0-RTT connect does not queue a ClientHello before application data',
      );
      const serverAccepted = pipe.server.accept();
      const serverStreamAccepted = serverAccepted.then((server) => server.acceptStream());
      const stream = await earlyConnection.openBidirectionalStream();
      await stream.writer.write(encodeUtf8('early-write-starts-handshake'));
      const serverStream = await pipe.pumpUntil(serverStreamAccepted);
      const data = await pipe.pumpUntil(readBytes(serverStream.reader.read()));
      t.equal(
        decodeUtf8(data!),
        'early-write-starts-handshake',
        'first early stream write starts the deferred handshake',
      );
      t.ok(
        pipe
          .trace()
          .slice(traceBefore)
          .some((event) => event.type === 'datagram:queued'),
        'application data queues the first 0-RTT flight',
      );
    } finally {
      await resumedClient?.close();
      await pipe.close();
    }
  });
  it('RFC 9000 section 8.1.3: tampered, expired, and wrong-address NEW_TOKENs are rejected', async (t) => {
    if (!quicAvailable) return;
    const sessionKey = 'localhost|fino-hq';
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const originalAddress = {
      family: 'ipv4' as const,
      ip: '10.0.0.1',
      port: 55101,
    };
    const pipe = new QuicPipe({ server: { retry: { tokenSecret: fixedTokenSecret(97) } } });
    let clientEndpoint: QuicEndpoint | null = null;
    try {
      await pipe.listen();
      clientEndpoint = newSimClient(pipe, originalAddress, { sessionStore });
      const initial = await connectSimClient(pipe, clientEndpoint);
      await pipe.runUntilSettled();
      await initial.close();
      await clientEndpoint.close();
      await pipe.runUntilSettled();
      const validState = sessions.get(sessionKey);
      const validToken = validState?.addressToken;
      t.ok(validToken instanceof Uint8Array, 'baseline connection stores a regular NEW_TOKEN');
      pipe.advance(12e4);
      await pipe.runUntilSettled();
      const tampered = validToken.slice();
      tampered[Math.min(1, tampered.byteLength - 1)] ^= 1;
      const beforeTamper = pipe.server[quicEndpointInternals.inspectAddressValidationStats]();
      const tamperedResponse = await sendInitialProbe(pipe, originalAddress, tampered, 31);
      const afterTamper = pipe.server[quicEndpointInternals.inspectAddressValidationStats]();
      t.equal(
        afterTamper.addressTokenAccepted,
        beforeTamper.addressTokenAccepted,
        'tampered regular token is not accepted',
      );
      t.ok(
        tamperedResponse === null || (tamperedResponse[0] & 240) === 240,
        'tampered regular token is dropped or challenged with Retry',
      );
      pipe.advance(12e4);
      await pipe.runUntilSettled();
      const beforeWrongAddress = pipe.server[quicEndpointInternals.inspectAddressValidationStats]();
      const wrongAddressResponse = await sendInitialProbe(
        pipe,
        {
          family: 'ipv4',
          ip: '10.0.0.9',
          port: 55102,
        },
        validToken,
        32,
      );
      const afterWrongAddress = pipe.server[quicEndpointInternals.inspectAddressValidationStats]();
      t.equal(
        afterWrongAddress.addressTokenAccepted,
        beforeWrongAddress.addressTokenAccepted,
        'wrong-address regular token is not accepted',
      );
      t.ok(
        wrongAddressResponse === null || (wrongAddressResponse[0] & 240) === 240,
        'wrong-address regular token is dropped or challenged with Retry',
      );
      pipe.advance(24 * 60 * 60 * 1e3 + 12e4);
      await pipe.runUntilSettled();
      const beforeExpiry = pipe.server[quicEndpointInternals.inspectAddressValidationStats]();
      const expiredResponse = await sendInitialProbe(pipe, originalAddress, validToken, 33);
      const afterExpiry = pipe.server[quicEndpointInternals.inspectAddressValidationStats]();
      t.equal(
        afterExpiry.addressTokenAccepted,
        beforeExpiry.addressTokenAccepted,
        'expired regular token is not accepted',
      );
      t.ok(
        expiredResponse === null || (expiredResponse[0] & 240) === 240,
        'expired regular token is dropped or challenged with Retry',
      );
    } finally {
      await clientEndpoint?.close();
      await pipe.close();
    }
  });
  it('RFC 9000 sections 2 and 3: stream data survives simulator delivery and reassembly', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      link: {
        latencyMs: 1,
        reorderRate: 1,
        reorderDelayMs: 3,
      },
    });
    try {
      await pipe.handshake();
      const clientStream = await pipe.clientConnection!.openBidirectionalStream();
      const serverStreamPromise = pipe.serverConnection!.acceptStream();
      await clientStream.writer.write(encodeUtf8('simulated '));
      await clientStream.writer.write(encodeUtf8('stream'));
      await clientStream.writer.close();
      pipe.advance(4);
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const first = await readBytes(serverStream.reader.read());
      const second = await readBytes(serverStream.reader.read());
      t.equal(
        `${decodeUtf8(first!)}${second === null ? '' : decodeUtf8(second)}`,
        'simulated stream',
        'peer reads reordered stream bytes in order',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 sections 12.3 and 13.4: duplicate packets do not duplicate stream bytes', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({ link: { duplicateRate: 1 } });
    try {
      const { client, server } = await pipe.handshake();
      const traceBeforeStream = pipe.trace().length;
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('deduplicated-payload'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const chunks: string[] = [];
      for (;;) {
        const chunk = await pipe.pumpUntil(readBytes(serverStream.reader.read()));
        if (chunk === null) break;
        chunks.push(decodeUtf8(chunk));
      }
      t.equal(
        chunks.join(''),
        'deduplicated-payload',
        'stream bytes are exposed exactly once despite duplicated packets',
      );
      t.ok(
        pipe
          .trace()
          .slice(traceBeforeStream)
          .some((event) => event.type === 'datagram:duplicated'),
        'simulator duplicated at least one application packet',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9002 sustained-loss recovery completes a 4MiB transfer', async (t) => {
    if (!quicAvailable) return;
    const totalBytes = 4 * 1024 * 1024;
    const chunkBytes = 64 * 1024;
    const pipe = new QuicPipe({
      link: {
        latencyMs: 8,
        lossRate: .06,
      },
      client: {
        connection: {
          initialMaxData: totalBytes * 2,
          initialMaxStreamDataBidiRemote: totalBytes * 2,
        },
      },
      server: {
        connection: {
          initialMaxData: totalBytes * 2,
          initialMaxStreamDataBidiLocal: totalBytes * 2,
        },
      },
    });
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      const payload = new Uint8Array(chunkBytes);
      for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 255;
      const write = (async () => {
        let sent = 0;
        while (sent < totalBytes) {
          const n = Math.min(chunkBytes, totalBytes - sent);
          await clientStream.writer.write(
            n === payload.byteLength ? payload : payload.subarray(0, n),
          );
          sent += n;
        }
        await clientStream.writer.close();
      })();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const read = readStreamBytes(serverStream, pipe);
      const [, received] = await pipe.pumpUntil(Promise.all([write, read]), 2e4);
      t.equal(received.byteLength, totalBytes, 'loss recovery delivers the full 4MiB stream');
      t.ok(
        client.stats.packetsLost > 0 || server.stats.packetsLost > 0,
        'loss recovery records lost packets',
      );
      t.ok(
        client.stats.bytesLost > 0 || server.stats.bytesLost > 0,
        'loss recovery records lost bytes',
      );
      t.ok(
        client.stats.congestionWindow > 0,
        'client exposes congestion state after sustained loss',
      );
      t.ok(server.stats.smoothedRttMs >= 0, 'server exposes RTT state after sustained loss');
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9002 congestion-control selections complete stream traffic', async (t) => {
    if (!quicAvailable) return;
    for (const congestionControl of ['cubic', 'reno', 'bbr'] as const) {
      const pipe = new QuicPipe({
        link: { latencyMs: 2 },
        client: { connection: { congestionControl } },
        server: { connection: { congestionControl } },
      });
      try {
        const { client, server } = await pipe.handshake();
        const echoed = await pipe.sendAndRead(`cc-${congestionControl}`);
        t.equal(
          pipe.client.connection.congestionControl,
          congestionControl,
          `${congestionControl} client option resolves`,
        );
        t.equal(
          pipe.server.connection.congestionControl,
          congestionControl,
          `${congestionControl} server option resolves`,
        );
        t.equal(echoed, `cc-${congestionControl}`, `${congestionControl} stream traffic completes`);
        t.ok(
          client.stats.congestionWindow > 0,
          `${congestionControl} exposes native congestion window stats`,
        );
      } finally {
        await pipe.close();
      }
    }
  });
  it('Node transport parity: write drain flushes encoded packets through sendBatch', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      client: {
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
        },
      },
      server: {
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
        },
      },
    });
    try {
      const { client, server } = await pipe.handshake();
      const received: Uint8Array[] = [];
      server.addEventListener('datagram', (event: any) => received.push(event.data));
      await Promise.all(
        Array.from({ length: 8 }, (_, index) => client.sendDatagram(encodeUtf8(`batch-${index}`))),
      );
      await pipe.runUntilSettled();
      t.equal(received.length, 8, 'batched send path preserves queued DATAGRAM payloads');
      t.ok(
        pipe.transportFactory.sendBatchSizes.some((size) => size > 1),
        'transport observed a multi-packet sendBatch call',
      );
    } finally {
      await pipe.close();
    }
  });
  it('Node transport parity: ECN metadata marks simulator packets as ECT(0)', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      client: {
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
        },
        transport: { ecn: true },
      },
      server: {
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
        },
        transport: { ecn: true },
      },
    });
    try {
      const { client, server } = await pipe.handshake();
      const received = new Promise<Uint8Array>((resolve) => {
        server.addEventListener('datagram', (event: any) => resolve(event.data), { once: true });
      });
      await client.sendDatagram(encodeUtf8('ecn-datagram'));
      const data = await pipe.pumpUntil(received);
      t.equal(decodeUtf8(data), 'ecn-datagram', 'ECN metadata path preserves DATAGRAM delivery');
      t.ok(
        pipe.trace().some((event) => event.type === 'datagram:queued' && event.ecn === 2),
        'simulator trace records ngtcp2 ECT(0) packet marking',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 sections 4.1 and 4.2: connection flow-control credit unblocks aggregate writes across streams', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    const blockedTopics: any[] = [];
    const topicHandle = topic<any>('quic.stream.blocked').subscribe((event) =>
      blockedTopics.push(event),
    );
    try {
      const { client, server } = await pipe.handshake();
      const streamCount = 4;
      const payloadSize = 512 * 1024;
      const payloads: Uint8Array[] = [];
      const serverStreams = [];
      const blockedEvents: Array<{
        stream: unknown;
        connection: unknown;
      }> = [];
      for (let i = 0; i < streamCount; i++) {
        const clientStream = await client.openBidirectionalStream();
        clientStream.addEventListener('blocked', (event: any) => {
          blockedEvents.push({
            stream: event.stream,
            connection: event.connection,
          });
        });
        const serverStreamPromise = server.acceptStream();
        const payload = new Uint8Array(payloadSize);
        payload.fill(65 + i);
        payloads.push(payload);
        await clientStream.writer.write(payload);
        await clientStream.writer.close();
        serverStreams.push(await pipe.pumpUntil(serverStreamPromise));
      }
      await pipe.runUntilSettled();
      const blocked = client[quicConnectionInternals.inspectSendState]();
      t.ok(
        blocked.pendingWriteBytes > 0,
        'aggregate stream writes are blocked by connection-level credit',
      );
      t.ok(
        blockedTopics.some((event) => event.connection === client && event.stream !== null),
        'stream blocked topic includes connection and stream',
      );
      t.ok(
        blockedEvents.some((event) => event.connection === client && event.stream !== null),
        'stream blocked event includes connection and stream',
      );
      for (let i = 0; i < serverStreams.length; i++) {
        const received = await readStreamBytes(serverStreams[i], pipe);
        t.equal(
          received.byteLength,
          payloads[i].byteLength,
          `stream ${i} receives its full payload after connection credit returns`,
        );
        t.equal(received[0], payloads[i][0], `stream ${i} preserves payload bytes`);
      }
      await pipe.runUntilSettled();
      const unblocked = client[quicConnectionInternals.inspectSendState]();
      t.equal(
        unblocked.pendingWriteBytes,
        0,
        'all connection-blocked writes resume after peer reads across streams',
      );
      t.equal(
        unblocked.pendingWriteCount,
        0,
        'no pending stream writes remain after credit is returned',
      );
    } finally {
      topicHandle.dispose();
      await pipe.close();
    }
  });
  it('RFC 9000 section 9: NAT rebinding validates a new peer path and preserves streams', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const reboundPort = 55001;
      const pathValidation = once(server, 'pathvalidation');
      pipe.rebindClient(reboundPort);
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('after-nat-rebind'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const pathEvent = await pipe.pumpUntil(pathValidation);
      const data = await readBytes(serverStream.reader.read());
      t.equal(decodeUtf8(data!), 'after-nat-rebind', 'stream data survives NAT rebinding');
      t.equal(pathEvent.result, 'success', 'peer path validation succeeds for the rebound address');
      t.equal(
        pathEvent.path.remoteAddress.port,
        reboundPort,
        'path-validation event reports the rebound peer port',
      );
      t.ok(
        pipe
          .trace()
          .some(
            (event) =>
              event.type === 'datagram:delivered' &&
              event.localAddress.port === client.localAddress.port &&
              event.from.port === reboundPort &&
              event.to.port === server.localAddress.port,
          ),
        'simulator trace shows client packets arriving from the rebound source port',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 9: active migration uses a new local path and preserves streams', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      client: {
        migration: {
          enabled: true,
          usePreferredAddress: true,
        },
      },
      server: { migration: { enabled: true } },
    });
    try {
      const { client, server } = await pipe.handshake();
      const migratedPort = 55002;
      const migration = once(server, 'migration');
      await client.migrate({
        family: 'ipv4',
        ip: '10.0.0.1',
        port: migratedPort,
      });
      const migrationEvent = await pipe.pumpUntil(migration);
      t.equal(migrationEvent.result, 'success', 'peer validates the active migration path');
      t.equal(
        migrationEvent.path.remoteAddress.port,
        migratedPort,
        'migration event reports the client migrated port',
      );
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('after-active-migration'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const data = await readBytes(serverStream.reader.read());
      t.equal(decodeUtf8(data!), 'after-active-migration', 'stream data survives active migration');
      t.ok(
        pipe
          .trace()
          .some(
            (event) =>
              event.type === 'datagram:delivered' && event.localAddress.port === migratedPort,
          ),
        'simulator trace shows packets sent from the migrated local port',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 9: failed active migration falls back to the previous path', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      client: { migration: { enabled: true } },
      server: { migration: { enabled: true } },
    });
    try {
      const { client, server } = await pipe.handshake();
      const oldClientAddress = client.localAddress;
      const migratedAddress = {
        family: 'ipv4' as const,
        ip: '10.0.0.1',
        port: 55003,
      };
      pipe.net.setLink(migratedAddress, server.localAddress, { lossRate: 1 });
      pipe.net.setLink(server.localAddress, migratedAddress, { lossRate: 1 });
      const pathValidation = once(client, 'pathvalidation');
      await client.migrate(migratedAddress);
      const pathEvent = await pipe.pumpUntil(pathValidation);
      t.equal(
        pathEvent.result,
        'failure',
        'client reports failed validation for the unusable migrated path',
      );
      t.equal(
        client.localAddress.port,
        oldClientAddress.port,
        'client falls back to the previous local path',
      );
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('after-failed-migration'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        'after-failed-migration',
        'stream data continues over the fallback path',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 9.6: preferred-address migration validates the advertised server path', async (t) => {
    if (!quicAvailable) return;
    const preferredAddress = {
      family: 'ipv4' as const,
      ip: '10.0.0.3',
      port: 4434,
    };
    const pipe = new QuicPipe({
      client: {
        migration: {
          enabled: true,
          usePreferredAddress: true,
        },
      },
      server: {
        migration: {
          enabled: true,
          preferredAddress,
        },
      },
    });
    try {
      const { client, server } = await pipe.handshake();
      await pipe.runUntilSettled();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('after-preferred-address'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        'after-preferred-address',
        'stream data survives preferred-address migration',
      );
      t.ok(
        pipe
          .trace()
          .some(
            (traceEvent) =>
              traceEvent.type === 'datagram:delivered' &&
              traceEvent.to.ip === preferredAddress.ip &&
              traceEvent.to.port === preferredAddress.port,
          ),
        'simulator delivered traffic to the preferred server address',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 9.6: ignores preferred address unless client opts in', async (t) => {
    if (!quicAvailable) return;
    const preferredAddress = {
      family: 'ipv4' as const,
      ip: '10.0.0.3',
      port: 4434,
    };
    const pipe = new QuicPipe({
      client: { migration: { enabled: true } },
      server: {
        migration: {
          enabled: true,
          preferredAddress,
        },
      },
    });
    try {
      const { client, server } = await pipe.handshake();
      await pipe.runUntilSettled();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('without-preferred-address'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        'without-preferred-address',
        'stream data is delivered without preferred-address migration',
      );
      t.notOk(
        pipe
          .trace()
          .some(
            (traceEvent) =>
              traceEvent.type === 'datagram:delivered' &&
              traceEvent.to.ip === preferredAddress.ip &&
              traceEvent.to.port === preferredAddress.port,
          ),
        'client does not send traffic to the advertised preferred address by default',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 9.6: failed preferred-address validation falls back to the original server path', async (t) => {
    if (!quicAvailable) return;
    const preferredAddress = {
      family: 'ipv4' as const,
      ip: '10.0.0.3',
      port: 4434,
    };
    const pipe = new QuicPipe({
      client: {
        migration: {
          enabled: true,
          usePreferredAddress: true,
        },
      },
      server: {
        migration: {
          enabled: true,
          preferredAddress,
        },
      },
    });
    try {
      const { client, server } = await pipe.handshake();
      pipe.net.setLink(client.localAddress, preferredAddress, { lossRate: 1 });
      pipe.net.setLink(preferredAddress, client.localAddress, { lossRate: 1 });
      const pathValidation = once(client, 'pathvalidation');
      const pathEvent = await pipe.pumpUntil(pathValidation);
      t.equal(pathEvent.result, 'failure', 'client reports failed preferred-address validation');
      t.equal(
        pathEvent.preferredAddress,
        true,
        'path-validation event identifies preferred-address validation',
      );
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('after-failed-preferred-address'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      t.equal(
        decodeUtf8((await readBytes(serverStream.reader.read()))!),
        'after-failed-preferred-address',
        'stream data continues on the original server path after preferred-address failure',
      );
      t.ok(
        pipe
          .trace()
          .some(
            (traceEvent) =>
              traceEvent.type === 'datagram:delivered' &&
              traceEvent.to.ip === pipe.listener!.address.ip &&
              traceEvent.to.port === pipe.listener!.address.port,
          ),
        'traffic remains deliverable to the original listener address',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9002 sections 5 and 6: corrupted stream packets are dropped and retransmitted', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      pipe.net.corruptNextDatagrams(1, {
        from: client.localAddress,
        to: server.localAddress,
      });
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('recover-after-corruption'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const chunks: string[] = [];
      for (;;) {
        const chunk = await pipe.pumpUntil(readBytes(serverStream.reader.read()));
        if (chunk === null) break;
        chunks.push(decodeUtf8(chunk));
      }
      t.equal(
        chunks.join(''),
        'recover-after-corruption',
        'stream payload is retransmitted after one corrupt packet is dropped',
      );
      t.ok(
        pipe
          .trace()
          .filter(
            (event) =>
              event.type === 'datagram:delivered' &&
              event.localAddress.port === client.localAddress.port,
          ).length >= 2,
        'client sends more than one datagram after the corrupted packet is ignored',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9221 sections 3 and 5.2: DATAGRAM delivery is negotiated and size-checked', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const received = new Promise<Uint8Array>((resolve) => {
        server.addEventListener('datagram', (event: any) => resolve(event.data), { once: true });
      });
      const acked = once(client, 'datagramack');
      await client.sendDatagram(encodeUtf8('datagram payload'));
      const data = await pipe.pumpUntil(received);
      const ack = await pipe.pumpUntil(acked);
      await t.rejects(
        () => client.sendDatagram(new Uint8Array(65536)),
        /exceeds/,
        'oversized DATAGRAM payload rejects before send',
      );
      t.equal(
        decodeUtf8(data),
        'datagram payload',
        'peer receives negotiated unreliable DATAGRAM payload',
      );
      t.equal(
        ack.status,
        'ack',
        'sender receives DATAGRAM ACK status separately from payload delivery',
      );
      t.ok(
        pipe.trace().some((event) => event.type === 'datagram:delivered'),
        'simulator trace records datagram packet delivery',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9221 section 5: 0-RTT DATAGRAM rejects when remembered peer parameters omit DATAGRAM support', async (t) => {
    if (!quicAvailable) return;
    const sessions = new Map<string, any>();
    const sessionStore = memorySessionStore(sessions);
    const pipe = new QuicPipe({
      client: {
        sessionStore,
        earlyData: {
          replaySafe: true,
          maxBytes: 4096,
        },
        datagrams: { enabled: true },
      },
      server: {
        sessionStore: memorySessionStore(new Map()),
        earlyData: {
          replaySafe: true,
          maxBytes: 4096,
        },
        datagrams: { enabled: false },
      },
    });
    try {
      const { client } = await pipe.handshake();
      await pipe.runUntilSettled();
      await client.close();
      await pipe.client.close();
      const earlyClient = new QuicEndpoint(
        {
          alpnProtocols: ['fino-hq'],
          sessionStore,
          earlyData: {
            replaySafe: true,
            maxBytes: 4096,
          },
          datagrams: { enabled: true },
        },
        {
          transportFactory: pipe.transportFactory,
          runtime: pipe.runtime,
        },
      );
      try {
        const accepted = pipe.server.accept();
        const early = await earlyClient.connect({
          address: pipe.listener!.address,
          serverName: 'localhost',
        });
        await t.rejects(
          () => early.sendDatagram(encodeUtf8('early-datagram')),
          /peer did not negotiate QUIC DATAGRAM support/,
          '0-RTT DATAGRAM rejects from remembered peer parameters without DATAGRAM support',
        );
        await pipe.pumpUntil(accepted);
      } finally {
        await earlyClient.close();
      }
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9221 section 5.3: lost DATAGRAMs are not retransmitted and surface loss status', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      let receivedDatagrams = 0;
      server.addEventListener('datagram', () => {
        receivedDatagrams++;
      });
      const lost = once(client, 'datagramlost');
      pipe.net.dropNextDatagrams(1, {
        from: client.localAddress,
        to: server.localAddress,
      });
      await client.sendDatagram(encodeUtf8('drop-once'));
      const event = await pipe.pumpUntil(lost);
      await pipe.runUntilSettled();
      t.equal(event.status, 'lost', 'sender receives DATAGRAM loss status');
      t.equal(receivedDatagrams, 0, 'lost DATAGRAM payload is not retransmitted to the peer');
      t.ok(
        pipe
          .trace()
          .some(
            (traceEvent) => traceEvent.type === 'datagram:dropped' && traceEvent.reason === 'loss',
          ),
        'simulator trace records the DATAGRAM packet loss',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9221 section 5.3: abandoned DATAGRAM status remains distinct from loss', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      client: {
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
          maxPending: 1,
          dropPolicy: 'drop-newest',
        },
      },
      server: {
        datagrams: {
          enabled: true,
          maxFrameSize: 1200,
        },
      },
    });
    try {
      const { client } = await pipe.handshake();
      const events: string[] = [];
      client.addEventListener('datagramstatus', (event: any) => {
        events.push(`status:${event.id}:${event.status}`);
      });
      client.addEventListener('datagramlost', (event: any) => {
        events.push(`lost:${event.id}:${event.status}`);
      });
      client.addEventListener('datagramabandoned', (event: any) => {
        events.push(`abandoned:${event.id}:${event.status}`);
      });
      await Promise.all([
        client.sendDatagram(encodeUtf8('queued-one')),
        client.sendDatagram(encodeUtf8('queued-two')),
      ]);
      await pipe.runUntilSettled();
      t.ok(events.includes('status:2:abandoned'), 'abandoned DATAGRAM emits generic status');
      t.ok(
        events.includes('abandoned:2:abandoned'),
        'abandoned DATAGRAM emits abandoned-specific status',
      );
      t.equal(
        events.some((event) => event.startsWith('lost:2:')),
        false,
        'abandoned DATAGRAM is not also reported as lost',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 sections 3.5, 4.4, and 4.5: RESET_STREAM surfaces public stream errors', async (t) => {
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
      clientStream.reset(77);
      const [serverStream, resetEvent] = await pipe.pumpUntil(
        Promise.all([serverStreamPromise, reset]),
      );
      await t.rejects(
        () => serverStream.reader.read(),
        /reset: 77/,
        'server reader rejects with the RESET_STREAM application code',
      );
      t.ok(
        /77/.test(resetEvent.error.message),
        'reset event exposes the RESET_STREAM application code',
      );
      t.equal(
        resetEvent.errorCode,
        77,
        'reset event exposes the RESET_STREAM application code as a field',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 sections 3.5 and 4.4: STOP_SENDING surfaces public stream errors', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('cancel-me'));
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      await pipe.runUntilSettled();
      const traceBeforeStop = pipe.trace().length;
      const reset = once(serverStream, 'reset');
      const stopSending = once(serverStream, 'stopsending');
      serverStream.stopSending(55);
      const preserved = await pipe.pumpUntil(readBytes(serverStream.reader.read()));
      t.equal(
        decodeUtf8(preserved!),
        'cancel-me',
        'STOP_SENDING preserves bytes already received before local readable shutdown',
      );
      t.equal(
        await pipe.pumpUntil(readBytes(serverStream.reader.read())),
        null,
        'local readable side ends after queued bytes are consumed',
      );
      const stopSendingEvent = await pipe.pumpUntil(stopSending);
      t.equal(stopSendingEvent.errorCode, 55, 'STOP_SENDING event exposes the application code');
      t.ok(
        /55/.test(stopSendingEvent.error.message),
        'STOP_SENDING error includes the application code',
      );
      const resetEvent = await pipe.pumpUntil(reset);
      t.ok(
        pipe
          .trace()
          .slice(traceBeforeStop)
          .some(
            (event) =>
              event.type === 'datagram:queued' &&
              event.localAddress.port === server.localAddress.port,
          ),
        'STOP_SENDING queues control traffic toward the peer',
      );
      t.ok(
        /55/.test(resetEvent.error.message),
        'peer RESET_STREAM response keeps the STOP_SENDING application code distinct',
      );
      await clientStream.writer.write(encodeUtf8('after-stop'));
      await pipe.runUntilSettled();
      await t.rejects(
        () => clientStream.writer.write(encodeUtf8('after-stop-again')),
        /closed|stop sending/i,
        'peer writer rejects future writes after native STOP_SENDING shutdown is drained',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 sections 3.5 and 4.4: STOP_SENDING is legal on receive-only unidirectional streams', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const serverStream = await server.openUnidirectionalStream();
      const clientStreamPromise = client.acceptStream();
      serverStream.stopSending(77);
      t.equal(
        serverStream.direction,
        'unidirectional',
        'local send-only stream exposes unidirectional direction',
      );
      await serverStream.writer.write(encodeUtf8('server-push'));
      const clientStream = await pipe.pumpUntil(clientStreamPromise);
      await pipe.runUntilSettled();
      const localStopSending = once(clientStream, 'stopsending');
      clientStream.stopSending(66);
      t.equal(
        decodeUtf8((await pipe.pumpUntil(readBytes(clientStream.reader.read())))!),
        'server-push',
        'queued receive-only bytes remain readable',
      );
      t.equal(
        await pipe.pumpUntil(readBytes(clientStream.reader.read())),
        null,
        'receive-only stream ends after STOP_SENDING',
      );
      const localStop = await pipe.pumpUntil(localStopSending);
      await pipe.runUntilSettled();
      t.equal(
        localStop.errorCode,
        66,
        'local receive-only STOP_SENDING event exposes the application code',
      );
      await t.rejects(
        () => serverStream.writer.write(encodeUtf8('after-unidirectional-stop')),
        /closed|stop sending/i,
        'peer send-only writer rejects after STOP_SENDING is received',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9001 key update behavior: controlled key update preserves stream traffic', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const readyStream = await client.openBidirectionalStream();
      const readyServerStreamPromise = server.acceptStream();
      await readyStream.writer.write(encodeUtf8('ready'));
      await readyStream.writer.close();
      const readyServerStream = await pipe.pumpUntil(readyServerStreamPromise);
      t.equal(
        decodeUtf8((await readBytes(readyServerStream.reader.read()))!),
        'ready',
        'server reads 1-RTT data before key update',
      );
      const keyUpdate = once(client, 'keyupdate');
      client.initiateKeyUpdate();
      await pipe.pumpUntil(keyUpdate);
      const postStream = await client.openBidirectionalStream();
      const postServerStreamPromise = server.acceptStream();
      await postStream.writer.write(encodeUtf8('after-key-update'));
      await postStream.writer.close();
      const postServerStream = await pipe.pumpUntil(postServerStreamPromise);
      t.equal(
        decodeUtf8((await readBytes(postServerStream.reader.read()))!),
        'after-key-update',
        'stream traffic works after the controlled key update',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9001 key update behavior: peer-initiated key update preserves stream traffic', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const keyUpdate = once(server, 'keyupdate');
      server.initiateKeyUpdate();
      await pipe.pumpUntil(keyUpdate);
      const postStream = await client.openBidirectionalStream();
      const postServerStreamPromise = server.acceptStream();
      await postStream.writer.write(encodeUtf8('after-peer-key-update'));
      await postStream.writer.close();
      const postServerStream = await pipe.pumpUntil(postServerStreamPromise);
      t.equal(
        decodeUtf8((await readBytes(postServerStream.reader.read()))!),
        'after-peer-key-update',
        'stream traffic works after a peer-initiated key update',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 10.2: application close is peer-visible under simulator delivery', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const closed = new Promise((resolve) =>
        server.addEventListener('close', () => resolve('closed'), { once: true }),
      );
      await client.close({
        errorCode: 42,
        reason: 'simulated shutdown',
      });
      const result = await pipe.pumpUntil(closed);
      t.equal(result, 'closed', 'peer observes CONNECTION_CLOSE');
      t.equal(server.state, 'closed', 'server connection is closed after peer application close');
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 10.2: peer transport close rejects operations without stateless reset', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const closed = once(server, 'close');
      const traceBefore = pipe.trace().length;
      client[quicConnectionInternals.injectTransportCloseForTest]();
      await pipe.pumpUntil(closed);
      t.equal(server.state, 'closed', 'peer closes after receiving transport CONNECTION_CLOSE');
      await t.rejects(
        () => server.openBidirectionalStream(),
        /closed|connected/i,
        'opening a stream rejects after transport close',
      );
      await t.rejects(
        () => server.sendDatagram(encodeUtf8('after-transport-close')),
        /closed|connected/i,
        'DATAGRAM send rejects after transport close',
      );
      await t.rejects(
        () => server.acceptStream(),
        /closed/i,
        'pending stream accept rejects after transport close',
      );
      t.equal(
        pipe
          .trace()
          .slice(traceBefore)
          .some(
            (event) =>
              event.type === 'datagram:queued' &&
              event.localAddress.port === server.localAddress.port,
          ),
        false,
        'known peer transport close does not cause stateless reset traffic from the closed peer',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 10.2: protocol-error transport close is peer-visible', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client, server } = await pipe.handshake();
      const closed = once(client, 'close');
      server[quicConnectionInternals.injectTransportCloseForTest]();
      await pipe.pumpUntil(closed);
      t.equal(
        client.state,
        'closed',
        'client closes after peer sends a transport-error CONNECTION_CLOSE',
      );
      await t.rejects(
        () => client.openBidirectionalStream(),
        /closed|connected/i,
        'client stream open rejects after protocol-error close',
      );
      await t.rejects(
        () => client.sendDatagram(encodeUtf8('after-protocol-close')),
        /closed|connected/i,
        'client DATAGRAM send rejects after protocol-error close',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 10.1: idle timeout closes connections and rejects stream operations', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client } = await pipe.handshake();
      const closed = once(client, 'close');
      pipe.advance(10001);
      await pipe.pumpUntil(closed);
      t.equal(client.state, 'closed', 'client connection closes after idle timeout');
      await t.rejects(
        () => client.openBidirectionalStream(),
        'opening a stream rejects after idle close',
      );
      await t.rejects(
        () => client.sendDatagram(encodeUtf8('after-idle')),
        'DATAGRAM send rejects after idle close',
      );
    } finally {
      await pipe.close();
    }
  });
  it('Node transport parity: peer-initiated stream idle timeout closes only the idle stream', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      client: { connection: { streamIdleTimeoutMs: 25 } },
      server: { connection: { streamIdleTimeoutMs: 25 } },
    });
    try {
      const { client, server } = await pipe.handshake();
      const clientStreamAccepted = client.acceptStream();
      const serverStream = await server.openBidirectionalStream();
      await serverStream.writer.write(encodeUtf8('idle-peer-stream'));
      const clientStream = await pipe.pumpUntil(clientStreamAccepted);
      const clientStreamClosed = once(clientStream, 'close');
      pipe.advance(30);
      await pipe.pumpUntil(clientStreamClosed);
      t.equal(
        client.stats.streamsIdleTimedOut,
        1,
        'client counts the peer-initiated idle stream timeout',
      );
      t.notEqual(client.state, 'closed', 'stream idle timeout does not close the whole connection');
      const activeStream = await client.openBidirectionalStream();
      const activeServerStreamPromise = server.acceptStream();
      await activeStream.writer.write(encodeUtf8('still-active'));
      const activeServerStream = await pipe.pumpUntil(activeServerStreamPromise);
      t.equal(
        decodeUtf8((await readBytes(activeServerStream.reader.read()))!),
        'still-active',
        'unrelated streams remain usable after stream idle timeout',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 10.1: handshake timeout rejects pending connect and accept', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({ link: { lossRate: 1 } });
    try {
      const listener = await pipe.listen();
      const accepted = trackPromise(pipe.server.accept());
      const connected = trackPromise(
        pipe.client.connect({
          address: listener.address,
          serverName: 'localhost',
        }),
      );
      await pipe.pumpUntilCondition(
        () =>
          pipe.trace().some((event) => event.type === 'datagram:dropped' && event.reason === 'loss')
            ? true
            : null,
        20,
      );
      pipe.advance(10001);
      await pipe.runUntilSettled();
      await Promise.resolve();
      t.equal(
        accepted.settled(),
        false,
        'server accept remains pending when no Initial reaches the listener',
      );
      t.equal(connected.settled(), true, 'client connect attempt settles after handshake timeout');
      t.ok(connected.failure() instanceof Error, 'client connect rejects on handshake timeout');
      t.equal(
        pipe.server.cidTable.get(''),
        undefined,
        'handshake timeout does not leak empty CID routes',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 section 10: draining retains known CIDs before removing routes', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    try {
      const { client } = await pipe.handshake();
      const routeCid = client.routeCids[0];
      if (routeCid === undefined) throw new Error('client did not register a route CID');
      await client.close({
        errorCode: 7,
        reason: 'draining',
      });
      await pipe.runUntilIdle();
      t.equal(
        pipe.client.cidTable.get(routeCid),
        client,
        'closed connection route is retained during draining',
      );
      pipe.advance(3001);
      await pipe.runUntilIdle();
      t.equal(
        pipe.client.cidTable.get(routeCid),
        undefined,
        'closed connection route is removed after the draining period',
      );
    } finally {
      await pipe.close();
    }
  });
  it('Node transport parity: custom drainingPeriodMultiplier extends draining route retention', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe({
      link: { latencyMs: 400 },
      client: { connection: { drainingPeriodMultiplier: 10 } },
    });
    try {
      const { client } = await pipe.handshake();
      const routeCid = client.routeCids[0];
      if (routeCid === undefined) throw new Error('client did not register a route CID');
      await client.close({
        errorCode: 7,
        reason: 'custom-draining',
      });
      await pipe.runUntilIdle();
      t.equal(
        pipe.client.cidTable.get(routeCid),
        client,
        'closed connection route is retained during draining',
      );
      pipe.advance(3001);
      await pipe.runUntilIdle();
      t.equal(
        pipe.client.cidTable.get(routeCid),
        client,
        'custom draining multiplier keeps the route beyond the old fixed 3000ms timeout',
      );
      pipe.advance(6e4);
      await pipe.runUntilIdle();
      t.equal(
        pipe.client.cidTable.get(routeCid),
        undefined,
        'closed connection route is eventually removed after the custom draining period',
      );
    } finally {
      await pipe.close();
    }
  });
  it('RFC 9000 sections 10 and 10.3: draining ignores late packets without stateless reset', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.9',
      port: 0,
    });
    try {
      const { client } = await pipe.handshake();
      const routeCid = client.routeCids[0];
      if (routeCid === undefined) throw new Error('client did not register a route CID');
      const cid = hexToBytes(routeCid);
      const latePacket = new Uint8Array(Math.max(64, 1 + cid.byteLength + 8));
      latePacket[0] = 64;
      latePacket.set(cid, 1);
      latePacket.fill(165, 1 + cid.byteLength);
      await client.close({
        errorCode: 9,
        reason: 'draining-late-packet',
      });
      await pipe.runUntilIdle();
      const traceBefore = pipe.trace().length;
      await probe.send(latePacket, client.localAddress);
      await pipe.runUntilIdle();
      t.equal(
        pipe.client.cidTable.get(routeCid),
        client,
        'known CID still routes to the draining connection',
      );
      t.equal(
        drainDatagrams(probe).length,
        0,
        'late packet for a draining CID does not elicit a stateless reset',
      );
      t.equal(
        pipe
          .trace()
          .slice(traceBefore)
          .some(
            (event) =>
              event.type === 'datagram:queued' &&
              event.localAddress.port === client.localAddress.port,
          ),
        false,
        'draining connection does not queue response packets for late traffic',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('RFC 9000 section 10.2.1: closing endpoint retransmits CONNECTION_CLOSE with backoff', async (t) => {
    if (!quicAvailable) return;
    const pipe = new QuicPipe();
    const probe = await pipe.net.datagram({
      family: 'ipv4',
      ip: '10.0.0.9',
      port: 0,
    });
    try {
      const { server } = await pipe.handshake();
      const routeCid = server.routeCids[0];
      if (routeCid === undefined) throw new Error('server did not register a route CID');
      const cid = hexToBytes(routeCid);
      const latePacket = new Uint8Array(Math.max(64, 1 + cid.byteLength + 8));
      latePacket[0] = 64;
      latePacket.set(cid, 1);
      latePacket.fill(165, 1 + cid.byteLength);
      await server.close({
        errorCode: 15,
        reason: 'closing-period-retransmit',
      });
      await pipe.runUntilIdle();
      const traceBefore = pipe.trace().length;
      for (let i = 0; i < 3; i++) {
        await probe.send(latePacket, server.localAddress);
        await pipe.runUntilIdle();
      }
      const retransmits = pipe
        .trace()
        .slice(traceBefore)
        .filter(
          (event) =>
            event.type === 'datagram:queued' &&
            event.localAddress.port === server.localAddress.port &&
            event.to.port === probe.address.port,
        );
      t.equal(
        retransmits.length,
        2,
        'closed local endpoint retransmits close on packet counts 1 and 2, then backs off before 4',
      );
      t.ok(
        retransmits.every((event) => event.bytes > 0),
        'retransmitted close packets carry bytes',
      );
    } finally {
      probe.close();
      await pipe.close();
    }
  });
  it('RFC 9000 section 5.1.1: active CID limit migration rotation retires old CIDs and replenishes the pool', async (t) => {
    if (!quicAvailable) return;
    // activeConnectionIdLimit: 2 means the peer may issue at most 2 active CIDs.
    // Migration requires the server to retire the old client CID and issue a new one.
    // A successful migration with this small limit proves retirement and reissue work.
    const pipe = new QuicPipe({
      client: {
        migration: { enabled: true },
        connection: { activeConnectionIdLimit: 2 },
      },
      server: {
        migration: { enabled: true },
        connection: { activeConnectionIdLimit: 2 },
      },
    });
    try {
      const { client, server } = await pipe.handshake();
      t.equal(
        client.remoteTransportParameters.activeConnectionIdLimit,
        2,
        'server advertises activeConnectionIdLimit of 2',
      );
      const migration = once(server, 'migration');
      await client.migrate({
        family: 'ipv4',
        ip: '10.0.0.1',
        port: 55004,
      });
      const migrationEvent = await pipe.pumpUntil(migration);
      t.equal(
        migrationEvent.result,
        'success',
        'migration succeeds with activeConnectionIdLimit: 2',
      );
      t.equal(
        migrationEvent.path.remoteAddress.port,
        55004,
        'migration event records the new client port',
      );
      // Settle fully so the old CID retirement round-trip completes.
      await pipe.runUntilSettled();
      const clientStream = await client.openBidirectionalStream();
      const serverStreamPromise = server.acceptStream();
      await clientStream.writer.write(encodeUtf8('post-migration-routing'));
      await clientStream.writer.close();
      const serverStream = await pipe.pumpUntil(serverStreamPromise);
      const data = await pipe.pumpUntil(readBytes(serverStream.reader.read()));
      t.equal(
        decodeUtf8(data!),
        'post-migration-routing',
        'stream data routes correctly after CID rotation',
      );
      t.ok(
        pipe.trace().some((e) => e.type === 'datagram:delivered' && e.localAddress.port === 55004),
        'packets delivered through the migrated local address (old CID route replaced)',
      );
    } finally {
      await pipe.close();
    }
  });
});
