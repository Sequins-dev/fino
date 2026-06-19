import { describe, it } from 'fino:test/test';
import { SimulatedNetworkProvider } from '../../js/internal/net/simulated-provider.mts';
import type { Connection, DatagramSocket, Listener, SocketAddress } from '../../js/internal/net/provider.mts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (value: string) => enc.encode(value);
const text = (value: Uint8Array | null) => value === null ? null : dec.decode(value);

const loopback = (port: number): SocketAddress => ({ family: 'ipv4', ip: '10.10.0.1', port });

async function connectedPair(): Promise<{ net: SimulatedNetworkProvider; listener: Listener; client: Connection; server: Connection }> {
  const net = new SimulatedNetworkProvider();
  const listener = net.listen(loopback(8080));
  const client = await net.connect(listener.address);
  const server = await listener.accept();
  if (server === null) throw new Error('expected accepted connection');
  return { net, listener, client, server };
}

describe('internal:net/provider conformance — simulated implementation', () => {
  it('streams expose stable addresses and bidirectional IO', async (t) => {
    const { listener, client, server } = await connectedPair();
    try {
      t.deepEqual(client.remoteAddress, listener.address, 'client remote address is the listener');
      t.deepEqual(server.localAddress, listener.address, 'server local address is the listener');
      t.deepEqual(server.remoteAddress, client.localAddress, 'server remote address is the client local endpoint');

      const [clientReader, clientWriter] = client.split();
      const [serverReader, serverWriter] = server.split();
      await clientWriter.write(bytes('ping'));
      t.equal(text(await serverReader.read()), 'ping');
      await serverWriter.write(bytes('pong'));
      t.equal(text(await clientReader.read()), 'pong');

      await clientWriter.close();
      t.equal(await serverReader.read(), null, 'closing writer produces EOF for peer reader');
      client.close();
      client.close();
      t.equal(client.closed, true, 'connection close is idempotent');

      await serverReader.close();
      await serverWriter.close();
    } finally {
      server.close();
      listener.close();
    }
  });

  it('listener close releases pending accepts and duplicate binds are rejected', async (t) => {
    const net = new SimulatedNetworkProvider();
    const listener = net.listen(loopback(8081));
    t.throws(() => net.listen(loopback(8081)), /already bound/, 'duplicate listener bind rejects');

    const pending = listener.accept();
    listener.close();
    listener.close();
    t.equal(await pending, null, 'pending accept resolves null on close');

    const rebound = net.listen(loopback(8081));
    rebound.close();
  });

  it('split halves are single-use and closed connection split rejects', async (t) => {
    const { listener, client, server } = await connectedPair();
    try {
      client.split();
      t.throws(() => client.split(), /already been split/, 'connection split is single-use');
      server.close();
      t.throws(() => server.split(), /closed/, 'closed connection cannot be split');
    } finally {
      client.close();
      listener.close();
    }
  });

  it('datagrams bind, deliver sender addresses, truncate reads, and close pending receives', async (t) => {
    const net = new SimulatedNetworkProvider();
    const client = await net.datagram({ family: 'ipv4', ip: '10.10.0.2', port: 0 });
    const server = await net.datagram({ family: 'ipv4', ip: '10.10.0.3', port: 5353 });
    try {
      t.ok(client.address.family === 'ipv4' && client.address.port !== 0, 'ephemeral datagram bind chooses a port');
      await t.rejects(() => net.datagram(server.address), /already bound/, 'duplicate datagram bind rejects');

      t.equal(await client.send(bytes('abcdef'), server.address), 6, 'send resolves accepted byte count');
      t.equal(net.runUntilIdle(), 1, 'datagram is delivered');
      const packet = await server.recv(3);
      t.equal(dec.decode(packet.data), 'abc', 'recv honors maxBytes');
      t.deepEqual(packet.addr, client.address, 'recv reports sender address');

      const pending = server.recv();
      server.close();
      await t.rejects(() => pending, /closed/, 'pending recv rejects on close');
      await t.rejects(() => server.recv(), /closed/, 'recv after close rejects');
      await t.rejects(() => server.send(bytes('x'), client.address), /closed/, 'send after close rejects');

      client.close();
      client.close();
    } finally {
      client.close();
      server.close();
    }
  });

  it('unsupported datagram address families reject explicitly', async (t) => {
    const net = new SimulatedNetworkProvider();
    await t.rejects(
      () => net.datagram({ family: 'unix', path: '/tmp/fino-provider.sock' }),
      /IPv4 or IPv6/,
      'unix datagrams are provider-specific and rejected by the simulated provider',
    );
  });

  it('connect rejects unbound addresses', async (t) => {
    const net = new SimulatedNetworkProvider();
    await t.rejects(() => net.connect(loopback(6553)), /No simulated listener bound/);
  });
});
