import { describe, it } from 'fino:test/test';
import { WebTransport } from 'fino:net/http/webtransport';
import { encodeHttpDatagram } from 'internal:net/http/h3/webtransport';

class FakeH3Connection extends EventTarget {
  sent: Uint8Array[] = [];
  bidi: FakeQuicStream[] = [];
  uni: FakeQuicStream[] = [];
  peerCertificate: Uint8Array | null = null;
  exporterCalls: Array<{ label: string; context: Uint8Array; length: number }> = [];
  stats = {
    datagramsSent: 0,
    datagramsReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
  };

  async sendDatagram(data: Uint8Array): Promise<number> {
    this.sent.push(data);
    this.stats.datagramsSent++;
    this.stats.bytesSent += data.byteLength;
    return this.sent.length;
  }

  exportKeyingMaterial(label: string, context: Uint8Array, length: number): ArrayBuffer {
    this.exporterCalls.push({ label, context, length });
    const out = new Uint8Array(length);
    for (let i = 0; i < out.byteLength; i++) out[i] = i + 1;
    return out.buffer;
  }

  getStats() {
    return this.stats;
  }

  emitDatagram(data: Uint8Array): void {
    const event = new Event('datagram') as Event & { data: Uint8Array };
    event.data = data;
    this.dispatchEvent(event);
  }

  async openBidirectionalStream(): Promise<FakeQuicStream> {
    const stream = new FakeQuicStream('bidirectional');
    this.bidi.push(stream);
    return stream;
  }

  async openUnidirectionalStream(): Promise<FakeQuicStream> {
    const stream = new FakeQuicStream('unidirectional');
    this.uni.push(stream);
    return stream;
  }

  emitStream(stream: FakeQuicStream): void {
    const event = new Event('stream') as Event & { stream: FakeQuicStream };
    event.stream = stream;
    this.dispatchEvent(event);
  }

  emitClose(closeInfo = { errorCode: 42, reason: 'transport closed', type: 'application', remote: true }): void {
    (this as unknown as { closeInfo: unknown }).closeInfo = closeInfo;
    this.dispatchEvent(new Event('close'));
  }

  emitError(error: Error): void {
    const event = new Event('error') as Event & { error: Error };
    event.error = error;
    this.dispatchEvent(event);
  }
}

class FakeQuicStream {
  readonly written: Uint8Array[] = [];
  readonly reader = {
    read: async () => null as Uint8Array | null,
  };
  readonly writer = {
    write: async (chunk: Uint8Array) => { this.written.push(chunk); },
    close: async () => {},
  };

  constructor(readonly direction: 'bidirectional' | 'unidirectional') {}
}

async function readOne<T>(stream: ReadableStream<T>): Promise<ReadableStreamReadResult<T>> {
  const reader = stream.getReader();
  try {
    return await reader.read();
  } finally {
    reader.releaseLock();
  }
}

describe('WebTransport over HTTP/3 public API', () => {
  it('exports the standard constructor and omits the legacy session export', async (t) => {
    const mod = await import('fino:net/http/webtransport');
    t.equal(typeof WebTransport, 'function');
    t.equal((globalThis as any).WebTransport, WebTransport);
    t.equal('WebTransportSession' in mod, false);

    const wt = WebTransport.unavailable('https://example.test/wt', 'test unavailable');
    t.equal(wt.url, 'https://example.test/wt');
    t.equal('readyState' in wt, false);
    t.equal('sendDatagram' in wt, false);
    t.equal(wt.responseHeaders, null);
    t.equal(wt.protocol, '');
    t.equal(wt.reliability, 'supports-unreliable');
    t.equal(wt.congestionControl, 'default');
    t.equal(wt.supportsReliableOnly, false);
    await t.rejects(() => wt.ready, /test unavailable/);
    await t.rejects(() => wt.closed, /test unavailable/);
    await t.rejects(() => wt.createBidirectionalStream(), /closed|unavailable|failed/i);
  });

  it('exposes standards-shaped datagram streams for connected H3 sessions', async (t) => {
    const connection = new FakeH3Connection();
    const wt = WebTransport._fromHttp3('https://example.test/wt', {
      connection,
      sessionStreamId: 8n,
      responseHeaders: new Headers({ 'sec-webtransport-http3-draft': 'draft-15' }),
      protocol: 'chat',
    });

    t.ok(wt instanceof WebTransport);
    t.equal(await wt.ready, undefined);
    t.equal(wt.responseHeaders?.get('sec-webtransport-http3-draft'), 'draft-15');
    t.equal(wt.protocol, 'chat');
    t.equal(wt.datagrams.maxDatagramSize > 0, true);
    t.ok(wt.datagrams.readable instanceof ReadableStream);

    const writer = wt.datagrams.createWritable().getWriter();
    await writer.write(new Uint8Array([0xaa, 0xbb]));
    writer.releaseLock();
    t.deepEqual([...connection.sent[0]!], [...encodeHttpDatagram(8n, new Uint8Array([0xaa, 0xbb]))]);

    const received = readOne(wt.datagrams.readable);
    connection.emitDatagram(encodeHttpDatagram(12n, new Uint8Array([0x00])));
    connection.emitDatagram(encodeHttpDatagram(8n, new Uint8Array([0xcc])));

    const next = await received;
    t.equal(next.done, false);
    t.deepEqual([...(next.value ?? new Uint8Array())], [0xcc], 'receives only datagrams for this session');
  });

  it('uses ReadableStream incoming stream queues and standard stream wrappers', async (t) => {
    const connection = new FakeH3Connection();
    const wt = WebTransport._fromHttp3('https://example.test/wt', {
      connection,
      sessionStreamId: 8n,
    });
    await wt.ready;

    const bidi = await wt.createBidirectionalStream();
    t.ok(bidi.readable instanceof ReadableStream);
    t.ok(bidi.writable instanceof WritableStream);
    t.deepEqual([...connection.bidi[0]!.written[0]!], [0x40, 0x41, 0x02], 'outgoing bidi stream starts with WT prefix');

    const uni = await wt.createUnidirectionalStream();
    t.ok(uni instanceof WritableStream);
    t.deepEqual([...connection.uni[0]!.written[0]!], [0x40, 0x54, 0x02], 'outgoing uni stream starts with WT prefix');

    const incoming = readOne(wt.incomingBidirectionalStreams);
    const wrong = new FakeQuicStream('bidirectional');
    wrong.reader.read = async () => new Uint8Array([0x40, 0x41, 0x03]);
    connection.emitStream(wrong);
    const right = new FakeQuicStream('bidirectional');
    right.reader.read = async () => new Uint8Array([0x40, 0x41, 0x02]);
    connection.emitStream(right);

    const next = await incoming;
    t.equal(next.done, false);
    t.ok(next.value?.readable instanceof ReadableStream);
    t.ok(next.value?.writable instanceof WritableStream);
  });

  it('resolves closed on clean close and rejects it on transport error', async (t) => {
    const connection = new FakeH3Connection();
    const wt = WebTransport._fromHttp3('https://example.test/wt', {
      connection,
      sessionStreamId: 8n,
    });

    const datagramNext = readOne(wt.datagrams.readable);
    const bidiNext = readOne(wt.incomingBidirectionalStreams);
    connection.emitClose({ errorCode: 99, reason: 'peer went away', type: 'application', remote: true });
    const closed = await wt.closed;

    t.deepEqual(closed, { closeCode: 99, reason: 'peer went away' });
    t.deepEqual(await datagramNext, { value: undefined, done: true }, 'datagram readable closes');
    t.deepEqual(await bidiNext, { value: undefined, done: true }, 'incoming stream readable closes');

    const erroredConnection = new FakeH3Connection();
    const errored = WebTransport._fromHttp3('https://example.test/wt2', {
      connection: erroredConnection,
      sessionStreamId: 12n,
    });

    const error = new Error('transport failure');
    erroredConnection.emitError(error);
    await t.rejects(() => errored.closed, /transport failure/);
  });

  it('validates server certificate hashes and exports keying material through QUIC TLS', async (t) => {
    const matchingConnection = new FakeH3Connection();
    matchingConnection.peerCertificate = new Uint8Array([1, 2, 3]);
    const hash = await crypto.subtle.digest('SHA-256', matchingConnection.peerCertificate);
    const wt = WebTransport._fromHttp3('https://example.test/wt', {
      connection: matchingConnection,
      sessionStreamId: 8n,
      options: {
        serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
      },
    });

    await wt.ready;
    const exported = new Uint8Array(await wt.exportKeyingMaterial('fino-test', new Uint8Array([9]), 4));
    t.deepEqual([...exported], [1, 2, 3, 4]);
    t.deepEqual(matchingConnection.exporterCalls.map((call) => ({
      label: call.label,
      context: [...call.context],
      length: call.length,
    })), [{ label: 'fino-test', context: [9], length: 4 }]);
    t.deepEqual(await wt.getStats(), {
      datagramsSent: 0,
      datagramsReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
    });

    const mismatchedConnection = new FakeH3Connection();
    mismatchedConnection.peerCertificate = new Uint8Array([4, 5, 6]);
    const failed = WebTransport._fromHttp3('https://example.test/wt', {
      connection: mismatchedConnection,
      sessionStreamId: 12n,
      options: {
        serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
      },
    });

    await t.rejects(() => failed.ready, /serverCertificateHashes/i);
    await t.rejects(() => failed.closed, /serverCertificateHashes/i);
  });
});
