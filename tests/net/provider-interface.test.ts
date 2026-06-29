import { describe, it } from 'fino:test/test';
import * as loop from 'internal:runtime/loop';
import { SimulatedNetworkProvider } from '../../js/internal/net/simulated-provider.ts';
import { NetworkProvider } from '../../js/internal/net/provider.ts';
import type { Connection, DatagramSocket, Listener, SocketAddress } from '../../js/internal/net/provider.ts';
import * as sock from 'fino:net/socket';
import { Socket } from 'fino:net/socket';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (value: string) => enc.encode(value);
const text = (value: Uint8Array | null) => value === null ? null : dec.decode(value);

const loopback = (port: number): SocketAddress => ({ family: 'ipv4', ip: '10.10.0.1', port });
const osLoopback = (port: number): SocketAddress => ({ family: 'ipv4', ip: '127.0.0.1', port });

function knownAddress(addr: sock.Address | sock.UnknownAddress | null): SocketAddress | null {
  if (addr === null) return null;
  if (addr.family === 'ipv4' || addr.family === 'ipv6' || addr.family === 'unix') return addr;
  return null;
}

class OsConnection implements Connection {
  #socket: Socket;
  #split = false;

  constructor(socket: Socket) {
    this.#socket = socket;
  }

  get remoteAddress() { return knownAddress(this.#socket.remoteAddress); }

  get localAddress() {
    if (this.#socket.closed) return knownAddress(this.#socket.localAddress);
    return knownAddress(sock.getsockname(this.#socket.fd));
  }

  get closed() { return this.#socket.closed; }

  split() {
    if (this.#socket.closed) throw new Error('connection is closed');
    if (this.#split) throw new Error('connection has already been split');
    this.#split = true;
    return this.#socket.split();
  }

  close() {
    this.#socket.close();
  }
}

class OsDatagramSocket implements DatagramSocket {
  #fd: number;
  #address: SocketAddress;
  #closed = false;

  constructor(fd: number, address: SocketAddress) {
    this.#fd = fd;
    this.#address = address;
  }

  get address() { return this.#address; }

  async send(data: Uint8Array, dest: SocketAddress): Promise<number> {
    if (this.#closed) throw new Error('datagram socket is closed');
    const sent = sock.sendto(this.#fd, data, dest);
    if (sent < 0) throw new Error('sendto() failed: errno=' + -sent);
    return sent;
  }

  async recv(maxBytes = 65536): Promise<{ data: Uint8Array; addr: SocketAddress }> {
    while (true) {
      if (this.#closed) throw new Error('datagram socket is closed');
      const packet = sock.recvfrom(this.#fd, maxBytes);
      if (typeof packet !== 'number') {
        const addr = knownAddress(packet.addr);
        if (addr === null) throw new Error('recvfrom() returned unsupported address family');
        return { data: packet.data, addr };
      }
      await loop.readable(this.#fd);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    loop.removeRead(this.#fd);
    sock.close(this.#fd);
  }
}

class OsNetworkProvider extends NetworkProvider {
  async connect(addr: SocketAddress): Promise<Connection> {
    return new OsConnection(await Socket.connect(addr));
  }

  listen(addr: SocketAddress, opts = {}): Listener {
    const server = Socket.listen(addr, opts);
    let closed = false;
    const closeWaiters: Array<() => void> = [];
    const closedPromise = () => new Promise<null>((resolve) => {
      if (closed) {
        resolve(null);
      } else {
        closeWaiters.push(() => resolve(null));
      }
    });
    return {
      get address() { return server.address; },
      async accept() {
        const accepted = await Promise.race([server.accept(), closedPromise()]);
        return accepted === null ? null : new OsConnection(accepted);
      },
      close() {
        if (closed) return;
        closed = true;
        server.close();
        for (const resolve of closeWaiters.splice(0)) resolve();
      },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const accepted = await Promise.race([server.accept(), closedPromise()]);
            if (accepted === null) return { done: true, value: undefined };
            return { done: false, value: new OsConnection(accepted) };
          },
        };
      },
    };
  }

  async datagram(addr: SocketAddress): Promise<DatagramSocket> {
    const family = addr.family === 'ipv6' ? sock.AF_INET6
                 : addr.family === 'ipv4' ? sock.AF_INET
                 : null;
    if (family === null) throw new Error('OS datagram provider supports IPv4 or IPv6 only');
    const fd = sock.socket(family, sock.SOCK_DGRAM, 0);
    try {
      sock.bind(fd, addr);
      sock.setNonblocking(fd);
      const bound = knownAddress(sock.getsockname(fd));
      if (bound === null) throw new Error('getsockname() returned unsupported address family');
      return new OsDatagramSocket(fd, bound);
    } catch (err) {
      sock.close(fd);
      throw err;
    }
  }
}

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

describe('internal:net/provider conformance — OS socket adapter', () => {
  it('streams listen/connect, expose stable addresses, split, and close', async (t) => {
    const net = new OsNetworkProvider();
    const listener = net.listen(osLoopback(0));
    const clientPromise = net.connect(listener.address);
    const server = await listener.accept();
    if (server === null) throw new Error('expected accepted connection');
    const client = await clientPromise;

    try {
      t.deepEqual(client.remoteAddress, listener.address, 'client remote address is the listener');
      t.deepEqual(server.localAddress, listener.address, 'server local address is the listener');
      t.deepEqual(server.remoteAddress, client.localAddress, 'server remote address is the client local endpoint');

      const [clientReader, clientWriter] = client.split();
      const [serverReader, serverWriter] = server.split();
      t.throws(() => client.split(), /already been split/, 'connection split is single-use');

      await clientWriter.write(bytes('ping'));
      await clientWriter.flush();
      t.equal(text(await serverReader.read()), 'ping');
      await serverWriter.write(bytes('pong'));
      await serverWriter.flush();
      t.equal(text(await clientReader.read()), 'pong');

      await clientWriter.close();
      t.equal(await serverReader.read(), null, 'closing writer produces EOF for peer reader');
      client.close();
      client.close();
      t.equal(client.closed, true, 'connection close is idempotent');

      await serverReader.close();
      await serverWriter.close();
    } finally {
      client.close();
      server.close();
      listener.close();
    }
  });

  it('listener close releases pending accepts and duplicate binds are rejected', async (t) => {
    const net = new OsNetworkProvider();
    const listener = net.listen(osLoopback(0));
    t.throws(() => net.listen(listener.address), /address already in use|errno=/, 'duplicate listener bind rejects');

    const pending = listener.accept();
    listener.close();
    listener.close();
    t.equal(await pending, null, 'pending accept resolves null on close');

    const rebound = net.listen(listener.address);
    rebound.close();
  });

  it('datagrams bind, deliver sender addresses, truncate reads, and reject after close', async (t) => {
    const net = new OsNetworkProvider();
    const client = await net.datagram(osLoopback(0));
    const server = await net.datagram(osLoopback(0));
    try {
      t.ok(client.address.family === 'ipv4' && client.address.port !== 0, 'ephemeral datagram bind chooses a port');
      await t.rejects(() => net.datagram(server.address), /address already in use|errno=/, 'duplicate datagram bind rejects');

      t.equal(await client.send(bytes('abcdef'), server.address), 6, 'send resolves accepted byte count');
      const packet = await server.recv(3);
      t.equal(dec.decode(packet.data), 'abc', 'recv honors maxBytes');
      t.deepEqual(packet.addr, client.address, 'recv reports sender address');

      server.close();
      server.close();
      await t.rejects(() => server.recv(), /closed/, 'recv after close rejects');
      await t.rejects(() => server.send(bytes('x'), client.address), /closed/, 'send after close rejects');
    } finally {
      client.close();
      server.close();
    }
  });

  it('unsupported datagram address families reject explicitly', async (t) => {
    const net = new OsNetworkProvider();
    await t.rejects(
      () => net.datagram({ family: 'unix', path: '/tmp/fino-provider.sock' }),
      /IPv4 or IPv6/,
      'unix datagrams are provider-specific and rejected by the OS adapter',
    );
  });
});
