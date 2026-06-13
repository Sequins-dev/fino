import { describe, it } from 'fino:test/test';
import {
  SimulatedNetworkProvider,
  type SimulatedNetworkTraceEvent,
} from '../../js/internal/net/simulated-provider.mts';

const encodeUtf8 = (s: string) => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView) => new TextDecoder().decode(b);

async function readAll(reader: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of reader) {
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

describe('SimulatedNetworkProvider datagrams', () => {
  it('delivers datagrams only after manual clock advancement', async (t) => {
    const net = new SimulatedNetworkProvider({
      defaultLink: { latencyMs: 25 },
    });
    const client = await net.datagram({ family: 'ipv4', ip: '10.0.0.1', port: 0 });
    const server = await net.datagram({ family: 'ipv4', ip: '10.0.0.2', port: 4433 });

    const received = server.recv();
    await client.send(encodeUtf8('initial'), server.address);

    t.equal(net.runUntilIdle(), 0, 'nothing is delivered before the due time');
    net.advance(24);
    t.equal(net.runUntilIdle(), 0, 'partial time advancement does not deliver');
    net.advance(1);
    t.equal(net.runUntilIdle(), 1, 'the due datagram is delivered');

    const packet = await received;
    t.equal(decodeUtf8(packet.data), 'initial', 'payload is delivered intact');
    t.deepEqual(packet.addr, client.address, 'source address is preserved');

    client.close();
    server.close();
  });

  it('applies queue overflow, MTU drops, duplication, corruption, and tracing deterministically', async (t) => {
    const net = new SimulatedNetworkProvider({
      defaultLink: {
        latencyMs: 10,
        mtu: 8,
        queueLimit: 1,
        duplicateRate: 1,
        corruptionRate: 1,
        corruptByte: 0xff,
      },
    });
    const a = await net.datagram({ family: 'ipv4', ip: '10.0.0.1', port: 1000 });
    const b = await net.datagram({ family: 'ipv4', ip: '10.0.0.2', port: 2000 });

    await a.send(new Uint8Array([1, 2, 3]), b.address);
    await a.send(new Uint8Array([4, 5, 6]), b.address);
    await a.send(new Uint8Array(9), b.address);

    net.advance(10);
    t.equal(net.runUntilIdle(), 2, 'one accepted datagram is duplicated');
    const first = await b.recv();
    const second = await b.recv();

    t.deepEqual(Array.from(first.data), [0xff, 2, 3], 'first copy is corrupted predictably');
    t.deepEqual(Array.from(second.data), [0xff, 2, 3], 'duplicate copy carries the same payload');
    t.deepEqual(
      net.trace.map((event: SimulatedNetworkTraceEvent) => event.type),
      ['datagram:queued', 'datagram:duplicated', 'datagram:dropped', 'datagram:dropped', 'datagram:delivered', 'datagram:delivered'],
      'trace records scheduling, duplication, queue overflow, MTU drop, and delivery',
    );

    a.close();
    b.close();
  });

  it('rewrites source addresses for NAT rebinding', async (t) => {
    const net = new SimulatedNetworkProvider();
    const client = await net.datagram({ family: 'ipv4', ip: '10.0.0.10', port: 5000 });
    const server = await net.datagram({ family: 'ipv4', ip: '10.0.0.20', port: 4433 });

    net.rewriteSource(client.address, { family: 'ipv4', ip: '203.0.113.4', port: 62000 });
    await client.send(encodeUtf8('path-a'), server.address);
    t.equal(net.runUntilIdle(), 1, 'first rewritten packet is delivered');
    t.deepEqual((await server.recv()).addr, { family: 'ipv4', ip: '203.0.113.4', port: 62000 });

    net.rewriteSource(client.address, { family: 'ipv4', ip: '203.0.113.4', port: 62001 });
    await client.send(encodeUtf8('path-b'), server.address);
    t.equal(net.runUntilIdle(), 1, 'second rewritten packet is delivered');
    t.deepEqual((await server.recv()).addr, { family: 'ipv4', ip: '203.0.113.4', port: 62001 });

    client.close();
    server.close();
  });

  it('routes replies to rewritten NAT addresses back to the original socket', async (t) => {
    const net = new SimulatedNetworkProvider();
    const client = await net.datagram({ family: 'ipv4', ip: '10.0.0.10', port: 5000 });
    const server = await net.datagram({ family: 'ipv4', ip: '10.0.0.20', port: 4433 });
    const rewritten = { family: 'ipv4', ip: '203.0.113.4', port: 62000 } as const;

    net.rewriteSource(client.address, rewritten);
    await server.send(encodeUtf8('reply'), rewritten);
    t.equal(net.runUntilIdle(), 1, 'reply to rewritten address is delivered to the original client socket');

    const response = await client.recv();
    t.equal(decodeUtf8(response.data), 'reply', 'client receives reverse-routed NAT reply');
    t.deepEqual(response.addr, server.address, 'reply source remains the server address');

    client.close();
    server.close();
  });

  it('drops scripted datagrams before normal delivery', async (t) => {
    const net = new SimulatedNetworkProvider();
    const client = await net.datagram({ family: 'ipv4', ip: '10.0.0.10', port: 5000 });
    const server = await net.datagram({ family: 'ipv4', ip: '10.0.0.20', port: 4433 });

    net.dropNextDatagrams(1, { from: client.address, to: server.address });
    await client.send(encodeUtf8('drop-me'), server.address);
    await client.send(encodeUtf8('deliver-me'), server.address);
    t.equal(net.runUntilIdle(), 1, 'only the non-dropped datagram is delivered');

    const packet = await server.recv();
    t.equal(decodeUtf8(packet.data), 'deliver-me', 'scripted loss consumes exactly one matching datagram');
    t.ok(
      net.trace.some((event) => event.type === 'datagram:dropped' && event.reason === 'loss' && event.bytes === 'drop-me'.length),
      'scripted loss is visible in the trace',
    );

    client.close();
    server.close();
  });

  it('corrupts scripted datagrams before normal delivery', async (t) => {
    const net = new SimulatedNetworkProvider();
    const client = await net.datagram({ family: 'ipv4', ip: '10.0.0.10', port: 5000 });
    const server = await net.datagram({ family: 'ipv4', ip: '10.0.0.20', port: 4433 });

    net.corruptNextDatagrams(1, { from: client.address, to: server.address, corruptByte: 0x7f });
    await client.send(new Uint8Array([1, 2, 3]), server.address);
    await client.send(new Uint8Array([4, 5, 6]), server.address);
    t.equal(net.runUntilIdle(), 2, 'both scripted-corruption and normal datagrams are delivered');

    const corrupted = await server.recv();
    const intact = await server.recv();
    t.deepEqual(Array.from(corrupted.data), [0x7f, 2, 3], 'first matching datagram is corrupted predictably');
    t.deepEqual(Array.from(intact.data), [4, 5, 6], 'second matching datagram is delivered intact');

    client.close();
    server.close();
  });
});

describe('SimulatedNetworkProvider streams', () => {
  it('connects stream clients to listeners with stable local and remote addresses', async (t) => {
    const net = new SimulatedNetworkProvider();
    const listener = net.listen({ family: 'ipv4', ip: '10.0.0.2', port: 8080 });
    const client = await net.connect(listener.address);
    const server = await listener.accept();
    if (server === null) throw new Error('expected accepted connection');

    t.deepEqual(client.remoteAddress, listener.address, 'client sees listener as remote');
    t.deepEqual(server.remoteAddress, client.localAddress, 'server sees client local address as remote');

    const [serverReader, serverWriter] = server.split();
    const [clientReader, clientWriter] = client.split();
    await clientWriter.write(encodeUtf8('ping'));
    await clientWriter.close();
    t.equal(decodeUtf8(await readAll(serverReader)), 'ping', 'server receives stream payload');

    await serverWriter.write(encodeUtf8('pong'));
    await serverWriter.close();
    t.equal(decodeUtf8(await readAll(clientReader)), 'pong', 'client receives stream payload');

    await serverReader.close();
    await clientReader.close();
    server.close();
    client.close();
    listener.close();
  });
});
