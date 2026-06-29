import { SimulatedNetworkProvider, type SimulatedLinkOptions } from 'internal:net/simulated-provider';
import { QuicEndpoint, type QuicAddress, type QuicConnection, type QuicEndpointOptions, type QuicListener, type QuicStream } from 'fino:net/quic';
import { parseQuicHeader } from './packet-parse.ts';
const TEST_CERT = 'tests/net/fixtures/test.crt';
const TEST_KEY = 'tests/net/fixtures/test.key';
export const encodeUtf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
export const decodeUtf8 = (value: Uint8Array): string => new TextDecoder().decode(value);
type SimTimer = {
  dueAt: number;
  canceled: boolean;
  callback: () => void;
};
export class SimulatedQuicRuntime {
  #net: SimulatedNetworkProvider;
  #timers: SimTimer[] = [];
  constructor(net: SimulatedNetworkProvider) {
    this.#net = net;
  }
  nowNs(): bigint {
    return BigInt(Math.floor(this.#net.now * 1e6));
  }
  defer(callback: () => void): void {
    Promise.resolve().then(callback);
  }
  setTimer(delayMs: number, callback: () => void): {
    cancel(): void;
  } {
    const timer: SimTimer = {
      dueAt: this.#net.now + Math.max(0, delayMs),
      canceled: false,
      callback
    };
    this.#timers.push(timer);
    return { cancel() {
      timer.canceled = true;
    } };
  }
  runDueTimers(): number {
    let fired = 0;
    for (;;) {
      this.#timers.sort((a, b) => a.dueAt - b.dueAt);
      const timer = this.#timers.find((candidate) => !candidate.canceled && candidate.dueAt <= this.#net.now);
      if (timer === undefined) {
        this.#timers = this.#timers.filter((candidate) => !candidate.canceled);
        return fired;
      }
      timer.canceled = true;
      fired++;
      timer.callback();
    }
  }
  nextDueAt(): number | null {
    let nextDueAt: number | null = null;
    for (const timer of this.#timers) {
      if (timer.canceled) continue;
      if (nextDueAt === null || timer.dueAt < nextDueAt) nextDueAt = timer.dueAt;
    }
    return nextDueAt;
  }
}
export class SimulatedQuicDatagramTransportFactory {
  #net: SimulatedNetworkProvider;
  #nextId = 1;
  readonly sendBatchSizes: number[] = [];
  readonly recvBatchSizes: number[] = [];
  constructor(net: SimulatedNetworkProvider) {
    this.#net = net;
  }
  async bind(address: QuicAddress) {
    const socket = await this.#net.datagram(address);
    return {
      id: this.#nextId++,
      get address() {
        return socket.address as QuicAddress;
      },
      get closed() {
        return socket.closed === true;
      },
      recvNow(maxBytes: number) {
        return socket.recvNow(maxBytes);
      },
      recvBatch: (maxPackets: number, maxBytes: number) => {
        const packets = [];
        for (let i = 0; i < maxPackets; i++) {
          const packet = socket.recvNow(maxBytes);
          if (packet === null) break;
          packets.push(packet);
        }
        this.recvBatchSizes.push(packets.length);
        return packets;
      },
      waitReadable() {
        return socket.waitReadable();
      },
      sendNow(data: Uint8Array, dest: QuicAddress) {
        return socket.sendNow(data, dest);
      },
      sendBatch: (packets: Array<{
        data: Uint8Array;
        dest: QuicAddress;
        ecn?: number;
      }>) => {
        let sent = 0;
        this.sendBatchSizes.push(packets.length);
        for (const packet of packets) {
          const rc = socket.sendNow(packet.data, packet.dest, packet.ecn);
          if (rc < 0) return {
            sent,
            errno: rc
          };
          sent++;
        }
        return {
          sent,
          errno: null
        };
      },
      waitWritable() {
        return socket.waitWritable();
      },
      close() {
        socket.close();
      }
    };
  }
}
export class QuicPipe {
  readonly net: SimulatedNetworkProvider;
  readonly runtime: SimulatedQuicRuntime;
  readonly transportFactory: SimulatedQuicDatagramTransportFactory;
  readonly server: QuicEndpoint;
  readonly client: QuicEndpoint;
  listener: QuicListener | null = null;
  clientConnection: QuicConnection | null = null;
  serverConnection: QuicConnection | null = null;
  constructor(options: {
    link?: SimulatedLinkOptions;
    client?: QuicEndpointOptions;
    server?: QuicEndpointOptions;
  } = {}) {
    this.net = new SimulatedNetworkProvider({ defaultLink: options.link });
    this.runtime = new SimulatedQuicRuntime(this.net);
    this.transportFactory = new SimulatedQuicDatagramTransportFactory(this.net);
    const internals = {
      transportFactory: this.transportFactory,
      runtime: this.runtime
    };
    this.server = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      ...options.server
    }, internals);
    this.client = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      ...options.client
    }, internals);
  }
  async listen(address: QuicAddress = {
    family: 'ipv4',
    ip: '10.0.0.2',
    port: 4433
  }): Promise<QuicListener> {
    this.listener = await this.server.listen({
      address,
      certificateFile: TEST_CERT,
      privateKeyFile: TEST_KEY
    });
    return this.listener;
  }
  async handshake(): Promise<{
    client: QuicConnection;
    server: QuicConnection;
  }> {
    const listener = this.listener ?? await this.listen();
    const accepted = this.server.accept();
    const connected = this.client.connect({
      address: listener.address,
      serverName: 'localhost'
    });
    const [client, server] = await this.pumpUntil(Promise.all([connected, accepted]));
    this.clientConnection = client;
    this.serverConnection = server;
    return {
      client: this.clientConnection,
      server: this.serverConnection
    };
  }
  async openBidi(initialData: Uint8Array | string = new Uint8Array()): Promise<{
    clientStream: QuicStream;
    serverStream: QuicStream;
  }> {
    if (this.clientConnection === null || this.serverConnection === null) await this.handshake();
    const clientStream = await this.clientConnection!.openBidirectionalStream();
    const serverStreamPromise = this.serverConnection!.acceptStream();
    const data = typeof initialData === 'string' ? encodeUtf8(initialData) : initialData;
    if (data.byteLength > 0) await clientStream.writer.write(data);
    else await clientStream.writer.close();
    const serverStream = await this.pumpUntil(serverStreamPromise);
    return {
      clientStream,
      serverStream
    };
  }
  async sendAndRead(message: string): Promise<string> {
    if (this.clientConnection === null || this.serverConnection === null) await this.handshake();
    const clientStream = await this.clientConnection!.openBidirectionalStream();
    const serverStreamPromise = this.serverConnection!.acceptStream();
    await clientStream.writer.write(encodeUtf8(message));
    await clientStream.writer.close();
    const serverStream = await this.pumpUntil(serverStreamPromise);
    const data = await serverStream.reader.read();
    if (data === null) throw new Error('server stream closed before data arrived');
    return decodeUtf8(data);
  }
  setLink(from: QuicAddress, to: QuicAddress, options: SimulatedLinkOptions): void {
    this.net.setLink(from, to, options);
  }
  setMtu(bytes: number): void {
    if (this.listener === null || this.clientConnection === null) return;
    this.net.setLink(this.clientConnection.localAddress, this.listener.address, { mtu: bytes });
    this.net.setLink(this.listener.address, this.clientConnection.localAddress, { mtu: bytes });
  }
  dropClientToServer(): void {
    if (this.listener === null || this.clientConnection === null) return;
    this.net.setLink(this.clientConnection.localAddress, this.listener.address, { lossRate: 1 });
  }
  dropServerToClient(): void {
    if (this.listener === null || this.clientConnection === null) return;
    this.net.setLink(this.listener.address, this.clientConnection.localAddress, { lossRate: 1 });
  }
  reorder(delayMs = 10): void {
    if (this.listener === null || this.clientConnection === null) return;
    this.net.setLink(this.clientConnection.localAddress, this.listener.address, {
      reorderRate: 1,
      reorderDelayMs: delayMs
    });
  }
  rebindClient(port: number): void {
    if (this.clientConnection === null) throw new Error('client connection is not established');
    this.net.rewriteSource(this.clientConnection.localAddress, {
      ...this.clientConnection.localAddress,
      port
    });
  }
  advance(ms: number): void {
    this.net.advance(ms);
  }
  async runUntilIdle(): Promise<number> {
    await Promise.resolve();
    const timers = this.runtime.runDueTimers();
    const delivered = this.net.runUntilIdle();
    await Promise.resolve();
    return timers + delivered;
  }
  async runUntilSettled(maxTurns = 200): Promise<void> {
    for (let i = 0; i < maxTurns; i++) {
      const work = await this.runUntilIdle();
      if (work === 0) return;
    }
    throw new Error('simulated QUIC pipe did not settle');
  }
  async pumpUntil<T>(promise: Promise<T>, maxTurns = 1e3): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let failure: unknown;
    promise.then((result) => {
      settled = true;
      value = result;
    }, (error) => {
      settled = true;
      failure = error;
    });
    for (let i = 0; i < maxTurns; i++) {
      await this.runUntilIdle();
      if (settled) {
        if (failure !== undefined) {
          if (failure instanceof Error) {
            failure.message = `${failure.message}; trace=${this.#traceSummary()}`;
          }
          throw failure;
        }
        return value as T;
      }
      const dueAt = this.#nextDueAt();
      if (dueAt !== null && dueAt > this.net.now) {
        this.net.advance(dueAt - this.net.now);
      }
    }
    throw new Error(`simulated QUIC operation did not complete; trace=${this.#traceSummary()}`);
  }
  #traceSummary(): string {
    const datagrams = this.trace().filter((event) => event.type === 'datagram:queued' || event.type === 'datagram:delivered').slice(-80);
    return JSON.stringify(datagrams.map((event) => {
      let version: number | null | string = null;
      try {
        version = parseQuicHeader(event.data).version;
      } catch {
        version = 'unparsed';
      }
      return {
        type: event.type,
        at: event.at,
        from: event.from.port,
        to: event.to.port,
        bytes: event.bytes,
        version
      };
    }));
  }
  async pumpUntilCondition<T>(condition: () => T | null | undefined, maxTurns = 1e3): Promise<T> {
    for (let i = 0; i < maxTurns; i++) {
      const value = condition();
      if (value !== null && value !== undefined) return value;
      await this.runUntilIdle();
      const dueAt = this.#nextDueAt();
      if (dueAt !== null && dueAt > this.net.now) {
        this.net.advance(dueAt - this.net.now);
      }
    }
    throw new Error(`simulated QUIC condition did not become true; trace=${JSON.stringify(this.trace())}`);
  }
  #nextDueAt(): number | null {
    const datagramDueAt = this.net.nextDueAt();
    const timerDueAt = this.runtime.nextDueAt();
    if (datagramDueAt === null) return timerDueAt;
    if (timerDueAt === null) return datagramDueAt;
    return Math.min(datagramDueAt, timerDueAt);
  }
  trace() {
    return this.net.trace.slice();
  }
  rawDatagram(data: Uint8Array, from: QuicAddress, to: QuicAddress): void {
    this.net._injectDatagram(from, data, to);
  }
  rawDatagramSocket(from: QuicAddress, to: QuicAddress): {
    send(data: Uint8Array): void;
  } {
    return { send: (data) => this.rawDatagram(data, from, to) };
  }
  tracePacketCount(predicate?: (event: ReturnType<QuicPipe['trace']>[number]) => boolean): number {
    return this.trace().filter((event) => (event.type === 'datagram:queued' || event.type === 'datagram:delivered') && (predicate === undefined || predicate(event))).length;
  }
  queuedDatagrams(from: QuicAddress, to: QuicAddress): Uint8Array[] {
    return this.trace().filter((event) => event.type === 'datagram:queued' && event.from.port === from.port && event.to.port === to.port && event.from.ip === from.ip && event.to.ip === to.ip).map((event) => event.data.slice());
  }
  async close(): Promise<void> {
    await this.client.close();
    await this.server.close();
  }
}
