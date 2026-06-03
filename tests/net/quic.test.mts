import { describe, it } from 'fino:test/test';
import {
  CidRoutingTable,
  QuicConnectionEvent,
  QuicEndpoint,
  QuicErrorEvent,
  QuicStreamEvent,
  cryptoBackend,
  quicAvailable,
  quicVersion,
  requireQuic,
} from 'fino:net/quic';

const encodeUtf8 = (value: string) => new TextEncoder().encode(value);
const decodeUtf8 = (value: Uint8Array) => new TextDecoder().decode(value);

describe('QUIC bindings', () => {
  it('exports availability and version metadata', (t) => {
    t.ok(typeof quicAvailable === 'boolean', 'quicAvailable is boolean');
    t.equal(cryptoBackend, quicAvailable ? 'ossl' : null, 'crypto backend reflects availability');
    if (quicAvailable) {
      t.ok(typeof quicVersion === 'string', 'quicVersion is a string when available');
      t.ok((quicVersion as string).length > 0, 'quicVersion is non-empty');
    } else {
      t.equal(quicVersion, null, 'quicVersion is null when unavailable');
      t.throws(() => requireQuic(), /libngtcp2/, 'requireQuic reports missing libraries');
    }
  });
});

describe('QUIC event classes', () => {
  it('carry typed connection, stream, and error payloads', (t) => {
    const endpoint = new QuicEndpoint();
    const connEvent = new QuicConnectionEvent('connection', { connection: null as any });
    const streamEvent = new QuicStreamEvent('stream', { stream: null as any });
    const err = new Error('quic-test');
    const errorEvent = new QuicErrorEvent('error', { error: err });

    t.equal(connEvent.connection, null, 'connection payload exposed');
    t.equal(streamEvent.stream, null, 'stream payload exposed');
    t.equal(errorEvent.error, err, 'error payload exposed');
    t.ok(endpoint instanceof EventTarget, 'endpoint extends EventTarget');
  });
});

describe('QUIC endpoint lifecycle', () => {
  it('listen and connect require native ngtcp2 support', async (t) => {
    if (quicAvailable) return;

    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    await t.rejects(
      () => endpoint.listen({ address: { family: 'ipv4', ip: '127.0.0.1', port: 0 } }),
      /libngtcp2/,
      'listen rejects when native QUIC is unavailable',
    );
    await t.rejects(
      () => endpoint.connect({ address: { family: 'ipv4', ip: '127.0.0.1', port: 4433 } }),
      /libngtcp2/,
      'connect rejects when native QUIC is unavailable',
    );
    await endpoint.close();
  });

  it('listener close does not close the endpoint', async (t) => {
    if (!quicAvailable) return;

    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await endpoint.listen({
      address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
    });

    t.equal(endpoint.listeners.length, 1, 'listener registered');
    await listener.close();
    t.equal(endpoint.listeners.length, 0, 'listener removed');

    const second = await endpoint.listen({
      address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
    });
    t.ok(second.address.port > 0, 'endpoint can listen again after listener close');
    await endpoint.close();
  });

  it('pending endpoint accept rejects on close', async (t) => {
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const pending = endpoint.accept();

    await endpoint.close();
    await t.rejects(
      () => pending,
      /endpoint is closed/,
      'pending accept rejects after endpoint close',
    );
  });
});

describe('QUIC loopback object model', () => {
  it('connect dispatches connection event and accept resolves once', async (t) => {
    if (!quicAvailable) return;

    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen({
      address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
    });
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });

    let eventConnection: unknown = null;
    server.addEventListener('connection', (event: any) => {
      eventConnection = event.connection;
    });

    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();

    t.ok(clientConnection.handshakeComplete, 'client handshake is complete');
    t.equal(serverConnection.alpnProtocol, 'fino-hq', 'server negotiated ALPN');
    t.equal(eventConnection, serverConnection, 'connection event carries accepted connection');

    await client.close();
    await server.close();
  });

  it('ALPN mismatch fails clearly', async (t) => {
    if (!quicAvailable) return;

    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen({
      address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
    });
    const client = new QuicEndpoint({ alpnProtocols: ['other-proto'] });

    await t.rejects(
      () => client.connect({ address: listener.address }),
      /ALPN mismatch/,
      'mismatched ALPN rejects',
    );

    await client.close();
    await server.close();
  });

  it('bidirectional stream echo works through reader and writer', async (t) => {
    if (!quicAvailable) return;

    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen({
      address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
    });
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();

    const clientStream = await clientConnection.openBidirectionalStream();

    await clientStream.writer.write(encodeUtf8('/echo'));
    await clientStream.writer.close();

    const serverStream = await serverConnection.acceptStream();
    const request = await serverStream.reader.read();
    t.equal(decodeUtf8(request!), '/echo', 'server reads stream data');

    await serverStream.writer.write(encodeUtf8('echo:/echo'));
    await serverStream.writer.close();

    const response = await clientStream.reader.read();
    t.equal(decodeUtf8(response!), 'echo:/echo', 'client reads echo response');

    await client.close();
    await server.close();
  });

  it('Web Streams readable and writable transfer byte chunks', async (t) => {
    if (!quicAvailable) return;

    const server = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const listener = await server.listen({
      address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
    });
    const client = new QuicEndpoint({ alpnProtocols: ['fino-hq'] });
    const clientConnection = await client.connect({ address: listener.address });
    const serverConnection = await server.accept();

    const clientStream = await clientConnection.openBidirectionalStream();
    const webWriter = clientStream.writable.getWriter();
    await webWriter.write(encodeUtf8('web-stream'));
    await webWriter.close();

    const serverStream = await serverConnection.acceptStream();
    const webReader = serverStream.readable.getReader();
    const first = await webReader.read();
    const eof = await webReader.read();

    t.equal(decodeUtf8(first.value), 'web-stream', 'readable stream receives bytes');
    t.ok(eof.done, 'readable stream reaches EOF');

    await client.close();
    await server.close();
  });
});

describe('QUIC CID routing table', () => {
  it('adds, looks up, removes, and clears connection IDs', (t) => {
    const table = new CidRoutingTable<string>();
    const cid = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    table.add(cid, 'conn-a');
    t.equal(table.get(cid), 'conn-a', 'lookup by bytes');
    t.equal(table.get('deadbeef'), 'conn-a', 'lookup by normalized string');
    t.ok(table.delete(cid), 'delete returns true');
    t.equal(table.get(cid), undefined, 'deleted CID is absent');

    table.add('aa', 'conn-b');
    table.clear();
    t.equal(table.get('aa'), undefined, 'clear removes entries');
  });
});
