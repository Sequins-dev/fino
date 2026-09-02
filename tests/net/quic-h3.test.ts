import { describe, it } from 'fino:test/test';
import { quicAvailable, QuicStreamEvent } from 'fino:net/quic';
import type { QuicConnection, QuicStream } from 'fino:net/quic';
import { fetch as h3Fetch, h3Available, requireH3, serve as h3Serve } from 'internal:net/http/h3';
import { resolveH3ConnectAddress } from 'internal:net/http/h3/resolve';
import { serve as httpServe } from 'fino:net/http/server';
import { App } from 'fino:net/http/app';
import { HttpClient } from 'fino:net/http/client';
import { DiskFileSystem } from 'fino:file';
import { H3ServerDriver } from 'internal:net/http/h3/server';
import { H3ClientSession } from 'internal:net/http/h3/client';
import { Nghttp3Session } from 'internal:net/http/h3/session';
import { WebTransport } from 'fino:net/http/webtransport';
import {
  SETTINGS_ENABLE_CONNECT_PROTOCOL,
  SETTINGS_H3_DATAGRAM,
  SETTINGS_WT_ENABLED,
  WEBTRANSPORT_BIDI_STREAM_TYPE,
  WEBTRANSPORT_UNI_STREAM_TYPE,
  decodeHttpDatagram,
  decodeH3SettingsFrame,
  decodeQuicVarint,
  decodeWebTransportStreamPrefix,
  encodeHttpDatagram,
  encodeH3SettingsFrame,
  encodeQuicVarint,
  encodeWebTransportStreamPrefix,
  injectWebTransportSettings,
  readWebTransportSettings,
  webTransportSettings,
  webTransportSettingsEnabled,
} from 'internal:net/http/h3/webtransport';
import { QuicPipe } from './fixtures/quic/sim-harness.ts';
const available = quicAvailable && h3Available;
const TEST_CERT = 'tests/net/fixtures/test.crt';
const TEST_KEY = 'tests/net/fixtures/test.key';
const fs = new DiskFileSystem('/');
const decodeUtf8 = (value: Uint8Array) => new TextDecoder().decode(value);
type UnifiedHttpServer = ReturnType<typeof httpServe>;
async function startUnifiedH3(create: () => UnifiedHttpServer): Promise<UnifiedHttpServer> {
  for (let attempt = 0; ; attempt++) {
    const server = create();
    try {
      await server.ready;
      return server;
    } catch (error) {
      await server.close();
      if (attempt >= 4 || !/address already in use/i.test(String(error))) throw error;
    }
  }
}
async function readPemCertificateDer(path: string): Promise<Uint8Array> {
  const pem = decodeUtf8(await fs.readFile(path));
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}
function h3Pipe(): QuicPipe {
  return new QuicPipe({
    server: {
      alpnProtocols: ['h3'],
      connection: {
        maxIdleTimeoutMs: 0,
        streamIdleTimeoutMs: 0,
        initialMaxStreamsUni: 16,
      },
    },
    client: {
      alpnProtocols: ['h3'],
      connection: {
        maxIdleTimeoutMs: 0,
        streamIdleTimeoutMs: 0,
        initialMaxStreamsUni: 16,
      },
    },
  });
}
async function h3Handshake(pipe: QuicPipe) {
  const { client, server } = await pipe.handshake();
  return {
    client,
    server,
  };
}
async function h3WebTransportPair(pipe: QuicPipe): Promise<{
  client: QuicConnection;
  server: QuicConnection;
  serverRun: Promise<void>;
  clientSession: H3ClientSession;
  clientTransport: WebTransport;
  serverTransport: WebTransport;
}> {
  let resolveAccepted!: (wt: WebTransport) => void;
  const acceptedPromise = new Promise<WebTransport>((resolve) => {
    resolveAccepted = resolve;
  });
  const { client, server } = await h3Handshake(pipe);
  const driver = new H3ServerDriver();
  const serverRun = driver.run(server, () => new Response('unexpected'), {
    onWebTransport(_request, session) {
      resolveAccepted(session);
      return session;
    },
  });
  const clientSession = await H3ClientSession.create(client);
  const clientTransport = await pipe.pumpUntil(
    clientSession.webtransport('https://example.test/wt'),
  );
  const serverTransport = await pipe.pumpUntil(acceptedPromise);
  await clientTransport.ready;
  await serverTransport.ready;
  return {
    client,
    server,
    serverRun,
    clientSession,
    clientTransport,
    serverTransport,
  };
}
async function readIncomingUnidirectionalBytes(
  pipe: QuicPipe,
  transport: WebTransport,
): Promise<Uint8Array> {
  const incoming = transport.incomingUnidirectionalStreams.getReader();
  try {
    const next = await pipe.pumpUntil(incoming.read());
    if (next.done || next.value === undefined)
      throw new Error('WebTransport unidirectional stream was not delivered');
    const reader = next.value.getReader();
    try {
      const bytes = await pipe.pumpUntil(reader.read());
      if (bytes.done || bytes.value === undefined)
        throw new Error('WebTransport unidirectional stream had no payload');
      return bytes.value;
    } finally {
      reader.releaseLock();
    }
  } finally {
    incoming.releaseLock();
  }
}
async function readIncomingBidirectionalBytes(
  pipe: QuicPipe,
  transport: WebTransport,
): Promise<Uint8Array> {
  const incoming = transport.incomingBidirectionalStreams.getReader();
  try {
    const next = await pipe.pumpUntil(incoming.read());
    if (next.done || next.value === undefined)
      throw new Error('WebTransport bidirectional stream was not delivered');
    const reader = next.value.readable.getReader();
    try {
      const bytes = await pipe.pumpUntil(reader.read());
      if (bytes.done || bytes.value === undefined)
        throw new Error('WebTransport bidirectional stream had no payload');
      return bytes.value;
    } finally {
      reader.releaseLock();
    }
  } finally {
    incoming.releaseLock();
  }
}
async function rawH3RequestOutcome(
  pipe: QuicPipe,
  clientConn: QuicConnection,
  headers: Array<[string, string]>,
  maxTurns = 1e3,
): Promise<string> {
  let outcome = '';
  let resolveOutcome!: () => void;
  const responsePromise = new Promise<void>((resolve) => {
    resolveOutcome = resolve;
  });
  const finish = (value: string): void => {
    if (outcome !== '') return;
    outcome = value;
    resolveOutcome();
  };
  const clientSession = Nghttp3Session.createClient({
    onBeginHeaders() {},
    onRecvHeader(_sid, _token, name, value) {
      if (name === ':status') finish(`status:${value}`);
    },
    onEndHeaders() {},
    onBeginTrailers() {},
    onRecvTrailer() {},
    onEndTrailers() {},
    onRecvData() {},
    onEndStream() {},
    onStreamClose(_sid, appErrorCode) {
      if (appErrorCode !== 0n) finish(`stream-error:${appErrorCode}`);
    },
    onResetStream(_sid, appErrorCode) {
      finish(`stream-error:${appErrorCode}`);
    },
    onAckedStreamData() {},
  });
  clientConn.addEventListener('stream', (event) => {
    const stream = (event as QuicStreamEvent).stream;
    const sid = BigInt(stream.id);
    void (async () => {
      try {
        while (true) {
          const result = await stream.reader.read();
          if (result.done) {
            clientSession.endStream(sid);
            break;
          }
          clientSession.receiveStreamData(sid, result.value);
        }
      } catch {}
    })();
  });
  const [ctrl, qenc, qdec] = (await pipe.pumpUntil(
    Promise.all([
      clientConn.openUnidirectionalStream(),
      clientConn.openUnidirectionalStream(),
      clientConn.openUnidirectionalStream(),
    ]),
  )) as QuicStream[];
  for (const s of [ctrl, qenc, qdec]) clientSession.addQuicStream(BigInt(s.id), s.writer);
  clientSession.bindControlStream(BigInt(ctrl.id));
  clientSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
  clientSession.drainWrites();
  await pipe.runUntilSettled();
  const requestStream = (await pipe.pumpUntil(clientConn.openBidirectionalStream())) as QuicStream;
  const requestSid = BigInt(requestStream.id);
  clientSession.addQuicStream(requestSid, requestStream.writer);
  void (async () => {
    try {
      while (true) {
        const result = await requestStream.reader.read();
        if (result.done) {
          clientSession.endStream(requestSid);
          break;
        }
        clientSession.receiveStreamData(requestSid, result.value);
      }
    } catch {}
  })();
  clientSession.submitRequest(requestSid, headers);
  clientSession.drainWrites();
  await pipe.runUntilSettled();
  try {
    await pipe.pumpUntil(responsePromise, maxTurns);
  } catch (error) {
    if (outcome !== '') throw error;
    await pipe.runUntilSettled();
    outcome = 'no-response';
  }
  clientSession.close();
  return outcome;
}
describe('HTTP/3 (h3 ALPN)', { exclusive: true }, () => {
  it('WebTransport H3 constants and framing helpers match draft-15', (t) => {
    t.equal(SETTINGS_WT_ENABLED, 746385408, 'WT setting id');
    t.equal(SETTINGS_ENABLE_CONNECT_PROTOCOL, 8, 'extended CONNECT setting id');
    t.equal(SETTINGS_H3_DATAGRAM, 51, 'H3 DATAGRAM setting id');
    t.equal(WEBTRANSPORT_BIDI_STREAM_TYPE, 65, 'bidi stream type');
    t.equal(WEBTRANSPORT_UNI_STREAM_TYPE, 84, 'uni stream type');
    const settings = webTransportSettings();
    t.equal(settings.get(SETTINGS_WT_ENABLED), 1, 'WT enabled setting');
    t.equal(settings.get(SETTINGS_ENABLE_CONNECT_PROTOCOL), 1, 'extended CONNECT setting');
    t.equal(settings.get(SETTINGS_H3_DATAGRAM), 1, 'H3 DATAGRAM setting');
    t.equal(
      webTransportSettingsEnabled(settings),
      true,
      'settings advertise all required features',
    );
    t.equal(
      webTransportSettingsEnabled(new Map([[SETTINGS_WT_ENABLED, 1]])),
      false,
      'partial settings are not enough',
    );
    const oneByte = encodeQuicVarint(63n);
    t.deepEqual([...oneByte], [63], 'one-byte QUIC varint');
    t.deepEqual(
      decodeQuicVarint(oneByte),
      {
        value: 63n,
        nextOffset: 1,
      },
      'decode one-byte varint',
    );
    const twoByte = encodeQuicVarint(64n);
    t.deepEqual([...twoByte], [64, 64], 'two-byte QUIC varint');
    t.deepEqual(
      decodeQuicVarint(twoByte),
      {
        value: 64n,
        nextOffset: 2,
      },
      'decode two-byte varint',
    );
    const fourByte = encodeQuicVarint(16384n);
    t.deepEqual([...fourByte], [128, 0, 64, 0], 'four-byte QUIC varint');
    t.deepEqual(
      decodeQuicVarint(fourByte),
      {
        value: 16384n,
        nextOffset: 4,
      },
      'decode four-byte varint',
    );
    const datagram = encodeHttpDatagram(8n, new Uint8Array([170, 187]));
    t.deepEqual([...datagram], [2, 170, 187], 'HTTP Datagram uses Quarter Stream ID');
    const decodedDatagram = decodeHttpDatagram(datagram);
    t.equal(decodedDatagram.streamId, 8n, 'decoded session stream id');
    t.deepEqual([...decodedDatagram.payload], [170, 187], 'decoded application datagram payload');
    const bidiPrefix = encodeWebTransportStreamPrefix('bidirectional', 12n);
    t.deepEqual([...bidiPrefix], [64, 65, 3], 'bidi WT stream prefix is type plus session id');
    t.deepEqual(
      decodeWebTransportStreamPrefix(bidiPrefix),
      {
        kind: 'bidirectional',
        sessionId: 12n,
        headerLength: 3,
      },
      'decode bidi WT stream prefix',
    );
    const uniPrefix = encodeWebTransportStreamPrefix('unidirectional', 16n);
    t.deepEqual([...uniPrefix], [64, 84, 4], 'uni WT stream prefix is type plus session id');
    t.deepEqual(
      decodeWebTransportStreamPrefix(uniPrefix),
      {
        kind: 'unidirectional',
        sessionId: 16n,
        headerLength: 3,
      },
      'decode uni WT stream prefix',
    );
    t.throws(
      () => encodeHttpDatagram(2n, new Uint8Array()),
      /client-initiated bidirectional/,
      'datagram session stream ids are validated',
    );
  });
  it('Nghttp3Session enables supported WebTransport H3 settings and tracks peers', (t) => {
    if (!h3Available) return;
    const callbacks = {
      onBeginHeaders() {},
      onRecvHeader() {},
      onEndHeaders() {},
      onBeginTrailers() {},
      onRecvTrailer() {},
      onEndTrailers() {},
      onRecvData() {},
      onEndStream() {},
      onStreamClose() {},
      onResetStream() {},
      onAckedStreamData() {},
    };
    const session = Nghttp3Session.createServer(callbacks, { webTransport: true });
    try {
      const local = session.localSettings;
      t.equal(
        local.get(SETTINGS_ENABLE_CONNECT_PROTOCOL),
        1,
        'local nghttp3 settings enable Extended CONNECT',
      );
      t.equal(local.get(SETTINGS_H3_DATAGRAM), 1, 'local nghttp3 settings enable H3 DATAGRAM');
      t.equal(
        local.get(SETTINGS_WT_ENABLED),
        1,
        'local H3 control stream patch advertises WebTransport',
      );
      t.equal(session.peerSettingsReceived, false, 'peer SETTINGS start unresolved');
      t.equal(
        session.peerWebTransportReady,
        false,
        'peer is not ready until all WT settings are known',
      );
      session._recordPeerSettingsForTest(
        new Map([
          [SETTINGS_ENABLE_CONNECT_PROTOCOL, 1],
          [SETTINGS_H3_DATAGRAM, 1],
        ]),
      );
      t.equal(session.peerSettingsReceived, true, 'peer SETTINGS are recorded');
      t.equal(
        session.peerWebTransportReady,
        false,
        'recognized nghttp3 settings alone do not imply WT support',
      );
      session._recordPeerSettingsForTest(webTransportSettings());
      t.equal(session.peerWebTransportReady, true, 'complete peer SETTINGS enable WebTransport');
    } finally {
      session.close();
    }
    const bounded = Nghttp3Session.createServer(callbacks, {
      maxFieldSectionSize: 8192,
      qpackMaxTableCapacity: 1024,
      qpackEncoderMaxTableCapacity: 512,
      qpackBlockedStreams: 8,
    });
    try {
      t.equal(bounded.localSettings.get(0x06), 8192, 'field-section limit is advertised');
      t.equal(bounded.localSettings.get(0x01), 1024, 'QPACK decoder capacity is configured');
      t.equal(bounded.localSettings.get(0x07), 8, 'QPACK blocked-stream limit is configured');
    } finally {
      bounded.close();
    }
    t.throws(
      () => Nghttp3Session.createServer(callbacks, { maxFieldSectionSize: -1 }),
      /non-negative safe integer/,
      'invalid resource limits fail before session creation',
    );
  });
  it('patches custom WebTransport SETTINGS into H3 control streams', (t) => {
    const baseSettings = new Map([
      [SETTINGS_ENABLE_CONNECT_PROTOCOL, 1],
      [SETTINGS_H3_DATAGRAM, 1],
    ]);
    const settingsFrame = encodeH3SettingsFrame(baseSettings);
    const controlBytes = new Uint8Array(1 + settingsFrame.byteLength);
    controlBytes[0] = 0;
    controlBytes.set(settingsFrame, 1);
    const patched = injectWebTransportSettings(controlBytes);
    const parsed = readWebTransportSettings(patched);
    t.equal(parsed.get(SETTINGS_ENABLE_CONNECT_PROTOCOL), 1, 'preserves CONNECT setting');
    t.equal(parsed.get(SETTINGS_H3_DATAGRAM), 1, 'preserves H3 DATAGRAM setting');
    t.equal(parsed.get(SETTINGS_WT_ENABLED), 1, 'injects draft-15 WebTransport setting');
    t.equal(webTransportSettingsEnabled(parsed), true, 'patched SETTINGS satisfy WT negotiation');
    t.deepEqual(
      decodeH3SettingsFrame(encodeH3SettingsFrame(parsed)),
      parsed,
      'SETTINGS frame round trips',
    );
  });
  it('H3 server recognizes WebTransport extended CONNECT and fails fast', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client, server } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverRun = driver.run(server, () => new Response('unexpected'));
      const session = await H3ClientSession.create(client);
      const response = await pipe.pumpUntil(
        session.request('https://example.test/wt', {
          method: 'CONNECT',
          headers: { ':protocol': 'webtransport-h3' },
        } as any),
      );
      t.equal(
        response.status,
        501,
        'WebTransport extended CONNECT is detected but not accepted yet',
      );
      t.match(await response.text(), /WebTransport over HTTP\/3 is not available/);
      client.destroy();
      server.destroy();
      await pipe.pumpUntil(serverRun.catch(() => {}));
    } finally {
      await pipe.close();
    }
  });
  it('H3 client rejects WebTransport when server SETTINGS are incomplete', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedWebTransportConnect = false;
      let serverSession!: Nghttp3Session;
      serverSession = Nghttp3Session.createServer({
        onBeginHeaders() {},
        onRecvHeader(_sid, _token, name, value) {
          if (name === ':protocol' && value === 'webtransport-h3')
            receivedWebTransportConnect = true;
        },
        onEndHeaders(sid) {
          void (async () => {
            try {
              serverSession.submitResponse(sid, [[':status', '200']]);
              serverSession.drainWrites();
            } catch {}
          })();
        },
        onBeginTrailers() {},
        onRecvTrailer() {},
        onEndTrailers() {},
        onRecvData() {},
        onEndStream() {},
        onStreamClose() {},
        onResetStream() {},
        onAckedStreamData() {},
      });
      serverConn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          try {
            if (stream.direction === 'bidirectional')
              serverSession.addQuicStream(sid, stream.writer);
            while (true) {
              const result = await stream.reader.read();
              if (result.done) {
                serverSession.endStream(sid);
                break;
              }
              serverSession.receiveStreamData(sid, result.value);
            }
          } catch {}
        })();
      });
      const [ctrl, qenc, qdec] = (await pipe.pumpUntil(
        Promise.all([
          serverConn.openUnidirectionalStream(),
          serverConn.openUnidirectionalStream(),
          serverConn.openUnidirectionalStream(),
        ]),
      )) as QuicStream[];
      for (const s of [ctrl, qenc, qdec]) serverSession.addQuicStream(BigInt(s.id), s.writer);
      serverSession.bindControlStream(BigInt(ctrl.id));
      serverSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
      const clientSessionPromise = H3ClientSession.create(clientConn);
      serverSession.drainWrites();
      await pipe.runUntilSettled();
      const clientSession = await pipe.pumpUntil(clientSessionPromise);
      await t.rejects(
        () => pipe.pumpUntil(clientSession.webtransport('https://example.test/wt')),
        /SETTINGS|WebTransport readiness/,
        'client rejects before sending extended CONNECT',
      );
      t.equal(receivedWebTransportConnect, false, 'server does not receive WebTransport CONNECT');
      serverSession.close();
      clientConn.destroy();
      serverConn.destroy();
    } finally {
      await pipe.close();
    }
  });
  it('H3 server rejects WebTransport CONNECT when client SETTINGS are incomplete', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let webTransportCalled = false;
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Response('unexpected'), {
        onWebTransport(_request, session) {
          webTransportCalled = true;
          return session;
        },
      });
      const outcome = await rawH3RequestOutcome(pipe, clientConn, [
        [':method', 'CONNECT'],
        [':scheme', 'https'],
        [':path', '/wt'],
        [':authority', 'localhost'],
        [':protocol', 'webtransport-h3'],
      ]);
      t.equal(outcome, 'status:400', 'server rejects WebTransport without complete peer SETTINGS');
      t.equal(webTransportCalled, false, 'onWebTransport is not invoked');
      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });
  it('H3 client and server complete WebTransport extended CONNECT takeover', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      let accepted: WebTransport | null = null;
      const { client, server } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverRun = driver.run(server, () => new Response('unexpected'), {
        onWebTransport(_request, session) {
          accepted = session;
          return session;
        },
      });
      const clientSession = await H3ClientSession.create(client);
      const wt = await pipe.pumpUntil(clientSession.webtransport('https://example.test/wt'));
      t.ok(wt instanceof WebTransport, 'client receives connected WebTransport');
      t.equal(await wt.ready, undefined);
      t.ok(accepted instanceof WebTransport, 'server receives connected WebTransport');
      t.equal(await accepted!.ready, undefined);
      const clientExport = new Uint8Array(
        await wt.exportKeyingMaterial('fino-webtransport-test', new Uint8Array([1, 2]), 32),
      );
      const serverExport = new Uint8Array(
        await accepted!.exportKeyingMaterial('fino-webtransport-test', new Uint8Array([1, 2]), 32),
      );
      t.deepEqual(
        [...clientExport],
        [...serverExport],
        'client and server export matching TLS keying material',
      );
      const receivedReader = accepted!.datagrams.readable.getReader();
      const writer = wt.datagrams.createWritable().getWriter();
      await writer.write(new Uint8Array([69]));
      writer.releaseLock();
      const next = await pipe.pumpUntil(receivedReader.read());
      receivedReader.releaseLock();
      t.equal(next.done, false);
      t.deepEqual(
        [...(next.value ?? new Uint8Array())],
        [69],
        'server receives WT datagram for accepted session',
      );
      client.destroy();
      server.destroy();
      await pipe.pumpUntil(serverRun.catch(() => {}));
    } finally {
      await pipe.close();
    }
  });
  it('routes client-created WebTransport unidirectional streams to the server session', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client, server, serverRun, clientTransport, serverTransport } =
        await h3WebTransportPair(pipe);
      const prefix = encodeWebTransportStreamPrefix('unidirectional', 0n);
      const stream = (await pipe.pumpUntil(client.openUnidirectionalStream())) as QuicStream;
      await stream.writer.write(prefix.subarray(0, 1));
      await stream.writer.write(prefix.subarray(1));
      await stream.writer.write(new Uint8Array([17, 18]));
      t.deepEqual(
        [...(await readIncomingUnidirectionalBytes(pipe, serverTransport))],
        [17, 18],
        'server receives client WT unidirectional payload after a split prefix',
      );
      client.destroy();
      server.destroy();
      await pipe.pumpUntil(serverRun.catch(() => {}));
    } finally {
      await pipe.close();
    }
  });
  it('routes server-created WebTransport unidirectional streams to the client session', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client, server, serverRun, clientTransport, serverTransport } =
        await h3WebTransportPair(pipe);
      const send = await pipe.pumpUntil(serverTransport.createUnidirectionalStream());
      const writer = send.getWriter();
      await writer.write(new Uint8Array([33, 34]));
      writer.releaseLock();
      t.deepEqual(
        [...(await readIncomingUnidirectionalBytes(pipe, clientTransport))],
        [33, 34],
        'client receives server WT unidirectional payload',
      );
      client.destroy();
      server.destroy();
      await pipe.pumpUntil(serverRun.catch(() => {}));
    } finally {
      await pipe.close();
    }
  });
  it('routes client-created WebTransport bidirectional streams to the server session', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client, server, serverRun, clientTransport, serverTransport } =
        await h3WebTransportPair(pipe);
      const stream = await pipe.pumpUntil(clientTransport.createBidirectionalStream());
      const writer = stream.writable.getWriter();
      await writer.write(new Uint8Array([49, 50]));
      writer.releaseLock();
      t.deepEqual(
        [...(await readIncomingBidirectionalBytes(pipe, serverTransport))],
        [49, 50],
        'server receives client WT bidirectional payload',
      );
      client.destroy();
      server.destroy();
      await pipe.pumpUntil(serverRun.catch(() => {}));
    } finally {
      await pipe.close();
    }
  });
  it('routes server-created WebTransport bidirectional streams to the client session', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client, server, serverRun, clientTransport, serverTransport } =
        await h3WebTransportPair(pipe);
      const stream = await pipe.pumpUntil(serverTransport.createBidirectionalStream());
      const writer = stream.writable.getWriter();
      await writer.write(new Uint8Array([65, 66]));
      writer.releaseLock();
      t.deepEqual(
        [...(await readIncomingBidirectionalBytes(pipe, clientTransport))],
        [65, 66],
        'client receives server WT bidirectional payload',
      );
      client.destroy();
      server.destroy();
      await pipe.pumpUntil(serverRun.catch(() => {}));
    } finally {
      await pipe.close();
    }
  });
  it('HttpClient webtransport uses the reusable H3 session', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client, server } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverRun = driver.run(server, () => new Response('unexpected'), {
        onWebTransport(_request, session) {
          return session;
        },
      });
      const http = new HttpClient({
        baseUrl: 'https://example.test',
        protocols: ['h3'],
      });
      const session = await http.session('https://example.test', { protocol: 'h3' });
      await (session as any)._attachH3TransportForTest(client);
      const wt = await pipe.pumpUntil(session.webtransport('/wt'));
      t.ok(wt instanceof WebTransport, 'public session returns connected WebTransport');
      t.equal(await wt.ready, undefined);
      client.destroy();
      server.destroy();
      await http.close();
      await pipe.pumpUntil(serverRun.catch(() => {}));
    } finally {
      await pipe.close();
    }
  });
  it('public fetch resolves URL hostnames before QUIC connect and preserves SNI host', async (t) => {
    const seen: Array<{
      hostname: string;
      family?: 4 | 6;
    }> = [];
    const resolved = await resolveH3ConnectAddress(
      new URL('https://example.test:9443/smoke'),
      async (hostname, opts) => {
        seen.push({
          hostname,
          family: opts.family,
        });
        return {
          address: '192.0.2.55',
          family: 4,
        };
      },
    );
    t.deepEqual(
      seen,
      [
        {
          hostname: 'example.test',
          family: 4,
        },
      ],
      'hostname is resolved as IPv4',
    );
    t.deepEqual(
      resolved.address,
      {
        family: 'ipv4',
        ip: '192.0.2.55',
        port: 9443,
      },
      'QUIC connect uses resolved IP',
    );
    t.equal(resolved.serverName, 'example.test', 'SNI stays on the URL hostname');
  });
  it('public module exports availability, guard, client, and server helpers', (t) => {
    t.equal(typeof h3Available, 'boolean', 'h3Available is a boolean');
    t.equal(typeof requireH3, 'function', 'requireH3 is exported');
    t.equal(typeof h3Fetch, 'function', 'fetch is exported');
    t.equal(typeof h3Serve, 'function', 'serve is exported');
  });
  it('public helpers fail fast when libnghttp3 is unavailable', async (t) => {
    if (h3Available) {
      t.ok(requireH3(), 'requireH3 returns bindings when libnghttp3 is installed');
      return;
    }
    t.throws(() => requireH3(), /libnghttp3 not found/, 'requireH3 reports missing libnghttp3');
    await t.rejects(
      () => h3Fetch('https://127.0.0.1/'),
      /libnghttp3 not found/,
      'fetch rejects before opening a connection',
    );
    await t.rejects(
      () =>
        h3Serve(
          {
            port: 0,
            certificateFile: TEST_CERT,
            privateKeyFile: TEST_KEY,
          },
          () => new Response('unused'),
        ),
      /libnghttp3 not found/,
      'serve rejects before opening a listener',
    );
  });
  it('h3Available is truthy when libnghttp3 is installed', async (t) => {
    if (!quicAvailable) return;
    t.ok(h3Available !== undefined, 'h3Available is exported');
    if (!h3Available) {
      t.ok(true, 'libnghttp3 not installed, skipping remaining H3 tests');
    }
  });
  it('public serve() and fetch() complete a real UDP GET round-trip', async (t) => {
    if (!available) return;
    const server = await h3Serve(
      {
        port: 0,
        hostname: '127.0.0.1',
        certificateFile: TEST_CERT,
        privateKeyFile: TEST_KEY,
      },
      (request) => {
        return new Response(`h3:${new URL(request.url).pathname}`, {
          headers: { 'x-h3-smoke': 'get' },
        });
      },
    );
    try {
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/smoke`, {
        quic: { verifyPeer: false },
      });
      t.equal(response.status, 200, 'GET response status');
      t.equal(response.headers.get('x-h3-smoke'), 'get', 'response header received');
      t.equal(
        new TextDecoder().decode(await response.arrayBuffer()),
        'h3:/smoke',
        'response body received',
      );
    } finally {
      await server.close();
    }
  });
  it('public serve() and fetch() complete a real UDP POST round-trip', async (t) => {
    if (!available) return;
    let method = '';
    let body = '';
    const server = await h3Serve(
      {
        port: 0,
        hostname: '127.0.0.1',
        certificateFile: TEST_CERT,
        privateKeyFile: TEST_KEY,
      },
      async (request) => {
        method = request.method;
        body = await request.text();
        return new Response(`echo:${body}`);
      },
    );
    try {
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/upload`, {
        method: 'POST',
        body: new TextEncoder().encode('real-h3-body'),
        quic: { verifyPeer: false },
      });
      t.equal(response.status, 200, 'POST response status');
      t.equal(method, 'POST', 'server received POST method');
      t.equal(body, 'real-h3-body', 'server received POST body');
      t.equal(
        new TextDecoder().decode(await response.arrayBuffer()),
        'echo:real-h3-body',
        'client received echo response',
      );
    } finally {
      await server.close();
    }
  });
  it('unified HTTP serve() can enable H3 accept mode', async (t) => {
    if (!available) return;
    const server = await startUnifiedH3(() =>
      httpServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          tls: {
            cert: TEST_CERT,
            key: TEST_KEY,
          },
          h3: true,
        } as any,
        async (incoming: any) => {
          const accepted = await incoming.accept();
          await accepted.respond(new Response(`protocol:${accepted.protocol}`));
        },
      ),
    );
    try {
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/proto`, {
        quic: { verifyPeer: false },
      });
      t.equal(await response.text(), 'protocol:h3', 'unified accept mode handles H3 requests');
    } finally {
      await server.close();
    }
  });
  it('unified HTTP serve() allows H3 clientAuth request mode without a client certificate', async (t) => {
    if (!available) return;
    const server = await startUnifiedH3(() =>
      httpServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          tls: {
            cert: TEST_CERT,
            key: TEST_KEY,
            ca: TEST_CERT,
            clientAuth: 'request',
          },
          h3: true,
        } as any,
        async (incoming: any) => {
          const accepted = await incoming.accept();
          await accepted.respond(new Response(`protocol:${accepted.protocol}`));
        },
      ),
    );
    try {
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/optional-client-auth`, {
        quic: { verifyPeer: false },
      });
      t.equal(
        await response.text(),
        'protocol:h3',
        'H3 request-mode client auth accepts anonymous clients',
      );
    } finally {
      await server.close();
    }
  });
  it('App.listen() exposes H3 protocol and session context', async (t) => {
    if (!available) return;
    const app = new App();
    app
      .get('/proto')
      .handle((ctx) => new Response(`${ctx.protocol}:${ctx.session?.protocol ?? 'none'}`));
    const server = await startUnifiedH3(() =>
      app.listen({
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: TEST_CERT,
          key: TEST_KEY,
        },
        h3: true,
      } as any),
    );
    try {
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/proto`, {
        quic: { verifyPeer: false },
      });
      t.equal(await response.text(), 'h3:h3', 'app context sees H3 protocol and session');
    } finally {
      await server.close();
    }
  });
  it('App.listen() accepts WebTransport routes over H3', async (t) => {
    if (!available) return;
    const app = new App();
    let accepted = false;
    app
      .value('tenant', () => 'acme')
      .route('/wt/:room')
      .webtransport(async (session, ctx) => {
        accepted =
          session instanceof WebTransport &&
          ctx.incoming.kind === 'webtransport' &&
          ctx.protocol === 'h3' &&
          ctx.session?.transport === 'quic' &&
          ctx.params?.room === 'lobby' &&
          ctx.tenant === 'acme';
      });
    const server = await startUnifiedH3(() =>
      app.listen({
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: TEST_CERT,
          key: TEST_KEY,
        },
        h3: true,
      } as any),
    );
    const client = new HttpClient({
      baseUrl: `https://127.0.0.1:${server.port}`,
      protocols: ['h3'],
      tls: { rejectUnauthorized: false },
    });
    try {
      const wt = await client.webtransport('/wt/lobby');
      t.equal(await wt.ready, undefined, 'client receives a connected WebTransport');
      t.equal(accepted, true, 'app route accepted the H3 WebTransport session');
      wt.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('HttpClient WebTransport enforces serverCertificateHashes over real H3', async (t) => {
    if (!available) return;
    const app = new App();
    app.route('/wt').webtransport(() => {});
    const server = await startUnifiedH3(() =>
      app.listen({
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: TEST_CERT,
          key: TEST_KEY,
        },
        h3: true,
      } as any),
    );
    const client = new HttpClient({
      baseUrl: `https://127.0.0.1:${server.port}`,
      protocols: ['h3'],
      tls: { rejectUnauthorized: false },
    });
    try {
      const certDer = await readPemCertificateDer(TEST_CERT);
      const matchingHash = await crypto.subtle.digest('SHA-256', certDer);
      const wt = await client.webtransport('/wt', {
        serverCertificateHashes: [
          {
            algorithm: 'sha-256',
            value: matchingHash,
          },
        ],
      });
      t.equal(await wt.ready, undefined, 'matching certificate hash accepts WebTransport');
      wt.close();
      await t.rejects(
        () =>
          client.webtransport('/wt', {
            serverCertificateHashes: [
              {
                algorithm: 'sha-256',
                value: new Uint8Array(32),
              },
            ],
          }),
        /serverCertificateHashes/i,
        'mismatched certificate hash rejects WebTransport setup',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('GET request/response round-trip', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        (_req) => new Response('hello h3', { headers: { 'content-type': 'text/plain' } }),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));
      t.equal(response.status, 200, 'response status is 200');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'hello h3', 'response body matches');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('POST with request body', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedBody = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedBody = await req.text();
        return new Response(`echo:${receivedBody}`);
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/upload', {
          method: 'POST',
          body: new TextEncoder().encode('request-body-data'),
        }),
      );
      t.equal(response.status, 200, 'response status is 200');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(receivedBody, 'request-body-data', 'server received request body');
      t.equal(text, 'echo:request-body-data', 'response body echoes request');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('streams request bodies to the server before EOF', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let releaseSecondChunk!: () => void;
      const secondChunkReady = new Promise<void>((resolve) => {
        releaseSecondChunk = resolve;
      });
      let handlerEntered = false;
      let firstChunk = '';
      let responseText = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        handlerEntered = true;
        const reader = req.body!.getReader();
        const first = await reader.read();
        firstChunk = first.done ? '' : new TextDecoder().decode(first.value);
        const chunks = [firstChunk];
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(new TextDecoder().decode(next.value));
        }
        return new Response(`echo:${chunks.join('')}`);
      });
      async function* requestBody() {
        yield new TextEncoder().encode('first-');
        await secondChunkReady;
        yield new TextEncoder().encode('second');
      }
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const requestPromise = session.request('https://localhost/upload', {
        method: 'POST',
        body: requestBody() as any,
      });
      await pipe.pumpUntilCondition(() => (firstChunk !== '' ? true : null));
      t.equal(handlerEntered, true, 'handler is entered before request EOF');
      t.equal(firstChunk, 'first-', 'handler can read the first chunk before request EOF');
      releaseSecondChunk();
      const response = await pipe.pumpUntil(requestPromise);
      responseText = await response.text();
      t.equal(responseText, 'echo:first-second', 'server receives the complete streamed body');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('streams response bodies to the client before EOF', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let releaseSecondChunk!: () => void;
      const secondChunkReady = new Promise<void>((resolve) => {
        releaseSecondChunk = resolve;
      });
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => {
        async function* body() {
          yield new TextEncoder().encode('first-');
          await secondChunkReady;
          yield new TextEncoder().encode('second');
        }
        return new Response(body() as any, { headers: { 'content-type': 'text/plain' } });
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/stream'));
      t.equal(response.status, 200, 'response resolves once headers arrive');
      const reader = response.body!.getReader();
      const first = await pipe.pumpUntil(reader.read());
      t.equal(first.done, false, 'first body read yields data');
      t.equal(
        new TextDecoder().decode(first.value),
        'first-',
        'client sees first chunk before response EOF',
      );
      releaseSecondChunk();
      const second = await pipe.pumpUntil(reader.read());
      t.equal(second.done, false, 'second body read yields data');
      t.equal(
        new TextDecoder().decode(second.value),
        'second',
        'client sees second chunk after producer resumes',
      );
      const done = await pipe.pumpUntil(reader.read());
      t.equal(done.done, true, 'stream closes after response EOF');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('custom request and response headers round-trip', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedHeader = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        receivedHeader = req.headers.get('x-custom') ?? '';
        return new Response('ok', { headers: { 'x-reply': 'from-server' } });
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/', { headers: { 'x-custom': 'my-value' } }),
      );
      t.equal(receivedHeader, 'my-value', 'server received custom request header');
      t.equal(
        response.headers.get('x-reply'),
        'from-server',
        'client received custom response header',
      );
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('server rejects oversized request field sections without dispatching', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let dispatched = false;
      const serverDone = new H3ServerDriver().run(
        serverConn,
        () => {
          dispatched = true;
          return new Response('unexpected');
        },
        { maxFieldSectionSize: 256 },
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/', {
          headers: { 'x-oversized': 'x'.repeat(256) },
        }),
      );
      t.equal(response.status, 431, 'oversized request receives 431');
      t.equal(dispatched, false, 'application handler is not invoked');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('client rejects oversized response field sections', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const serverDone = new H3ServerDriver().run(
        serverConn,
        () => new Response('body', { headers: { 'x-oversized': 'x'.repeat(256) } }),
      );
      const session = await pipe.pumpUntil(
        H3ClientSession.create(clientConn, { maxFieldSectionSize: 256 }),
      );
      await t.rejects(
        () => pipe.pumpUntil(session.request('https://localhost/')),
        /field section/i,
        'oversized response is rejected on its request stream',
      );
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('client applies the field-section limit independently to response trailers', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const serverDone = new H3ServerDriver().run(
        serverConn,
        () =>
          new Response('body', {
            trailers: new Headers({ 'x-oversized': 'x'.repeat(256) }),
          } as any),
      );
      const session = await pipe.pumpUntil(
        H3ClientSession.create(clientConn, { maxFieldSectionSize: 256 }),
      );
      const response = await pipe.pumpUntil(session.request('https://localhost/'));
      const trailers = response.trailers.then(
        () => null,
        (error: unknown) => error,
      );
      await t.rejects(
        () => pipe.pumpUntil(response.arrayBuffer()),
        /field section/i,
        'oversized trailers cancel the response stream',
      );
      const trailerError = await pipe.pumpUntil(trailers);
      t.ok(
        trailerError instanceof Error && /field section/i.test(trailerError.message),
        `oversized response trailers are rejected: ${String(trailerError)}`,
      );
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('multiple concurrent requests on the same connection', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        const id = new URL(req.url).pathname.slice(1);
        return new Response(`response-${id}`);
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const [r1, r2, r3] = await pipe.pumpUntil(
        Promise.all([
          session.request('https://localhost/1'),
          session.request('https://localhost/2'),
          session.request('https://localhost/3'),
        ]),
      );
      t.equal(r1.status, 200, 'response 1 status');
      t.equal(r2.status, 200, 'response 2 status');
      t.equal(r3.status, 200, 'response 3 status');
      const [b1, b2, b3] = await Promise.all([
        r1.arrayBuffer().then((b) => new TextDecoder().decode(b)),
        r2.arrayBuffer().then((b) => new TextDecoder().decode(b)),
        r3.arrayBuffer().then((b) => new TextDecoder().decode(b)),
      ]);
      const bodies = [b1, b2, b3].sort();
      t.deepEqual(
        bodies,
        ['response-1', 'response-2', 'response-3'],
        'all concurrent responses received',
      );
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('404 response for unknown route', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        (_req) => new Response('not found', { status: 404 }),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/missing'));
      t.equal(response.status, 404, 'server returned 404');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('empty body GET request', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) => new Response(null, { status: 204 }));
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/empty'));
      t.equal(response.status, 204, 'server returned 204 with no body');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('binary response body preserved', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const original = new Uint8Array(256);
      for (let i = 0; i < 256; i++) original[i] = i;
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        (_req) =>
          new Response(original, { headers: { 'content-type': 'application/octet-stream' } }),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/binary'));
      t.equal(response.status, 200, 'status 200');
      const received = new Uint8Array(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(received.byteLength, 256, 'received 256 bytes');
      t.ok(
        received.every((b, i) => b === original[i]),
        'binary bytes match',
      );
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('server exception returns 500', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) => {
        throw new Error('handler error');
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/crash'));
      t.equal(response.status, 500, 'uncaught handler error yields 500');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('request with trailers is dispatched by server', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedBody = '';
      let receivedTrailers: Array<[string, string]> = [];
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedBody = await req.text();
        receivedTrailers = (req as any).trailerHeaders ?? [];
        return new Response(`echo:${receivedBody}`);
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/upload', {
          method: 'POST',
          body: new TextEncoder().encode('trailer-body'),
          trailers: [['x-checksum', '42']],
        }),
      );
      t.equal(response.status, 200, 'server dispatched request with trailers');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'echo:trailer-body', 'server received body before trailers');
      t.deepEqual(receivedTrailers, [['x-checksum', '42']], 'server received request trailers');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('response with trailers is received by client', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        (_req) =>
          new Response('body-with-trailers', {
            trailers: new Headers([['x-digest', 'sha256-abc']]),
          }),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));
      t.equal(response.status, 200, 'response with trailers resolves correctly');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'body-with-trailers', 'response body is complete');
      const trailers = await response.trailers;
      t.equal(trailers.get('x-digest'), 'sha256-abc', 'response trailer received by client');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('connection close rejects in-flight requests', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      // Handler returns a promise that never resolves — simulates a slow handler.
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Promise<Response>(() => {}));
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      // Submit the request and pump until the pipe settles (request headers
      // delivered to server, handler entered, no more QUIC traffic pending).
      const requestPromise = session.request('https://localhost/hang');
      await pipe.runUntilSettled();
      // Now destroy the server — it sends CONNECTION_CLOSE to the client.
      serverConn.destroy();
      await t.rejects(
        () => pipe.pumpUntil(requestPromise),
        /H3 stream (closed|reset)/,
        'in-flight request rejected when connection closes',
      );
      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });
  it('HEAD request is dispatched and returns headers', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        (req) =>
          new Response(null, {
            status: 200,
            headers: { 'x-method': req.method },
          }),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/', { method: 'HEAD' }),
      );
      t.equal(response.status, 200, 'HEAD response status is 200');
      t.equal(response.headers.get('x-method'), 'HEAD', 'server received HEAD method');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('POST with no body is dispatched correctly', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedBody = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedBody = await req.text();
        return new Response(`echo:${receivedBody}`);
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/', { method: 'POST' }),
      );
      t.equal(response.status, 200, 'bodyless POST returns 200');
      t.equal(receivedBody, '', 'server received empty body');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('response trailers on empty body are received by client', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        (_req) =>
          new Response(new Uint8Array(0), { trailers: new Headers([['x-empty', 'yes']]) } as any),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));
      t.equal(response.status, 200, 'empty-body response with trailers resolves');
      const trailers = await response.trailers;
      t.equal(trailers.get('x-empty'), 'yes', 'trailer received on empty body response');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('connection close rejects multiple concurrent in-flight requests', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Promise<Response>(() => {}));
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const p1 = session.request('https://localhost/hang1');
      const p2 = session.request('https://localhost/hang2');
      const p3 = session.request('https://localhost/hang3');
      await pipe.runUntilSettled();
      serverConn.destroy();
      const results = await pipe.pumpUntil(Promise.allSettled([p1, p2, p3]));
      const rejected = results.filter((r) => r.status === 'rejected');
      t.equal(rejected.length, 3, 'all 3 in-flight requests rejected when connection closes');
      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });
  it('handler can explicitly return 400 Bad Request', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        (_req) =>
          new Response('Bad Request', {
            status: 400,
            headers: { 'x-reason': 'invalid-input' },
          }),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));
      t.equal(response.status, 400, 'client receives 400 from handler');
      t.equal(response.headers.get('x-reason'), 'invalid-input', '400 response headers forwarded');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('stream-level error on one stream does not kill concurrent requests', async (t) => {
    if (!available) return;
    // Sending a `connection` header triggers NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING (-107) on the
    // server. Without the Bug 1 fix, the server calls this.close() which destroys the entire
    // nghttp3 session — killing all concurrent requests. With the fix, only the bad stream is
    // reset and the concurrent normal request completes normally.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Response('alive'));
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const [, goodResult] = await pipe.pumpUntil(
        Promise.allSettled([
          session.request('https://localhost/bad', {
            headers: new Headers([['connection', 'close']]),
          }),
          session.request('https://localhost/ok'),
        ]),
      );
      t.equal(
        goodResult.status,
        'fulfilled',
        'normal request succeeds when bad stream triggers stream-level error',
      );
      if (goodResult.status === 'fulfilled') {
        t.equal(
          (goodResult as PromiseFulfilledResult<Response>).value.status,
          200,
          'normal request returns 200',
        );
      }
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('te header with non-trailers value is rejected; te: trailers is allowed (RFC 9114 §4.2)', async (t) => {
    if (!available) return;
    // nghttp3 enforces the te: trailers-only rule at the protocol layer (stream error),
    // so the bad request is rejected before JS can send a 400. The good request must
    // complete normally — this also verifies stream isolation.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let teHeaderInHandler: string | null = 'not-called';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        teHeaderInHandler = req.headers.get('te');
        return new Response('ok');
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const [badResult, goodResult] = await pipe.pumpUntil(
        Promise.allSettled([
          session.request('https://localhost/bad-te', { headers: new Headers([['te', 'gzip']]) }),
          session.request('https://localhost/good-te', {
            headers: new Headers([['te', 'trailers']]),
          }),
        ]),
      );
      t.equal(badResult.status, 'rejected', 'te: gzip is rejected');
      t.equal(goodResult.status, 'fulfilled', 'te: trailers is allowed through');
      if (goodResult.status === 'fulfilled') {
        t.equal(
          (goodResult as PromiseFulfilledResult<Response>).value.status,
          200,
          'te: trailers returns 200',
        );
      }
      t.equal(teHeaderInHandler, null, 'te: trailers is not forwarded to handler (RFC 9114 §4.2)');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('session.close() while request is in-flight rejects cleanly without crash', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Response('ok'));
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const requestPromise = session.request('https://localhost/');
      session.close();
      const [result] = await pipe.pumpUntil(Promise.allSettled([requestPromise]));
      t.ok(
        result.status === 'rejected' || result.status === 'fulfilled',
        'request settles without crashing',
      );
      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });
  it('submit methods throw "session closed" after close(), not use-after-free', async (t) => {
    if (!available) return;
    const session = Nghttp3Session.createServer({
      onBeginHeaders() {},
      onRecvHeader() {},
      onEndHeaders() {},
      onBeginTrailers() {},
      onRecvTrailer() {},
      onEndTrailers() {},
      onRecvData() {},
      onEndStream() {},
      onStreamClose() {},
      onResetStream() {},
      onAckedStreamData() {},
    });
    session.close();
    t.throws(
      () => session.submitResponse(0n, [[':status', '200']]),
      /session closed/,
      'submitResponse throws after close',
    );
    t.throws(
      () =>
        session.submitRequest(0n, [
          [':method', 'GET'],
          [':path', '/'],
          [':scheme', 'https'],
          [':authority', 'localhost'],
        ]),
      /session closed/,
      'submitRequest throws after close',
    );
    t.throws(
      () => session.submitTrailers(0n, [['x-done', '1']]),
      /session closed/,
      'submitTrailers throws after close',
    );
    t.throws(
      () => session.receiveStreamData(0n, new Uint8Array([1])),
      /session closed/,
      'receiveStreamData throws synchronously after close',
    );
    t.throws(
      () => session.endStream(0n),
      /session closed/,
      'endStream throws synchronously after close',
    );
    t.throws(
      () => session.drainWrites(),
      /session closed/,
      'drainWrites throws synchronously after close',
    );
  });
  it('keeps empty data distinct from stream completion', async (t) => {
    if (!available) return;
    const session = Nghttp3Session.createServer({
      onBeginHeaders() {},
      onRecvHeader() {},
      onEndHeaders() {},
      onBeginTrailers() {},
      onRecvTrailer() {},
      onEndTrailers() {},
      onRecvData() {},
      onEndStream() {},
      onStreamClose() {},
      onResetStream() {},
      onAckedStreamData() {},
    });
    try {
      t.throws(
        () => session.receiveStreamData(0n, new Uint8Array(0)),
        /stream data must not be empty/,
      );
    } finally {
      session.close();
    }
  });
  it('QUIC stream writers expose explicit synchronous capabilities', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client } = await h3Handshake(pipe);
      const stream = (await pipe.pumpUntil(client.openBidirectionalStream())) as QuicStream;
      t.equal(
        typeof stream.writer.writeSync,
        'function',
        'writer exposes writeSync as an explicit capability',
      );
      t.equal(
        typeof stream.writer.closeSync,
        'function',
        'writer exposes closeSync as an explicit capability',
      );
      client.destroy();
    } finally {
      await pipe.close();
    }
  });
  it('run() releases nghttp3 session when connection closes during setup', async (t) => {
    if (!available) return;
    // Destroy the server connection before H3ServerDriver.run() can open the mandatory
    // unidirectional streams, triggering the setup-failure path. With the Bug 2 fix,
    // the nghttp3 session is closed in the finally block. Without it, the session leaks.
    // Both cases complete without hanging — the test guards against future hangs.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      clientConn.destroy();
      serverConn.destroy();
      const driver = new H3ServerDriver();
      await pipe.pumpUntil(driver.run(serverConn, () => new Response('ok')).catch(() => {}));
      t.ok(true, 'run() completes without hanging when connection closes during setup');
    } finally {
      await pipe.close();
    }
  });
  it('OPTIONS request with body is received by handler', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedBody = '';
      let receivedMethod = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedMethod = req.method;
        receivedBody = await req.text();
        return new Response(null, {
          status: 204,
          headers: { allow: 'GET, HEAD, POST, OPTIONS' },
        });
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/', {
          method: 'OPTIONS',
          body: new TextEncoder().encode('xml-options-document'),
        }),
      );
      t.equal(response.status, 204, 'OPTIONS response is 204');
      t.equal(receivedMethod, 'OPTIONS', 'handler sees OPTIONS method');
      t.equal(receivedBody, 'xml-options-document', 'server received OPTIONS body');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('GET request DATA remains readable until the request stream ends', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let received = '';
      const serverDone = new H3ServerDriver().run(serverConn, async (request) => {
        received = new TextDecoder().decode(await request.arrayBuffer());
        return new Response('ok');
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/get-with-body', {
          method: 'GET',
          body: new TextEncoder().encode('request payload'),
        }),
      );
      t.equal(await pipe.pumpUntil(response.text()), 'ok', 'request completes normally');
      t.equal(received, 'request payload', 'handler receives GET request DATA');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('request() after close() rejects immediately without unhandled rejection', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Response('ok'));
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      session.close();
      await t.rejects(
        () => session.request('https://localhost/'),
        /H3 session is closed/,
        'request() after close() rejects with closed error',
      );
      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });
  it('forbidden HTTP/1.1 response headers are stripped before sending to client (RFC 9114 §4.2)', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async () => {
        return new Response('ok', {
          headers: {
            'transfer-encoding': 'chunked',
            connection: 'keep-alive',
            'x-custom': 'pass',
          },
        });
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));
      t.equal(response.status, 200, 'response status is 200');
      t.ok(!response.headers.has('transfer-encoding'), 'transfer-encoding is stripped');
      t.ok(!response.headers.has('connection'), 'connection is stripped');
      t.equal(response.headers.get('x-custom'), 'pass', 'non-forbidden headers pass through');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('sequential requests on the same session complete in order with correct bodies', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        const path = new URL(req.url).pathname;
        return new Response(`response:${path}`);
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const r1 = await pipe.pumpUntil(session.request('https://localhost/first'));
      t.equal(r1.status, 200, 'first request status');
      const body1 = await r1.text();
      t.equal(body1, 'response:/first', 'first response body');
      const r2 = await pipe.pumpUntil(session.request('https://localhost/second'));
      t.equal(r2.status, 200, 'second request status');
      const body2 = await r2.text();
      t.equal(body2, 'response:/second', 'second response body');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('POST with content-type header delivers both header and body to handler', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedContentType: string | null = null;
      let receivedBody = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedContentType = req.headers.get('content-type');
        receivedBody = await req.text();
        return new Response('ok');
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/upload', {
          method: 'POST',
          body: new TextEncoder().encode('hello world'),
          headers: { 'content-type': 'text/plain' },
        }),
      );
      t.equal(response.status, 200, 'POST with content-type returns 200');
      t.equal(receivedContentType, 'text/plain', 'server received content-type header');
      t.equal(receivedBody, 'hello world', 'server received body');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('query string round-trips through :path', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedSearch = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        receivedSearch = new URL(req.url).search;
        return new Response('ok');
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/search?q=hello&page=2'),
      );
      t.equal(response.status, 200, 'request with query string returns 200');
      t.equal(receivedSearch, '?q=hello&page=2', 'query string round-trips through :path');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('DELETE request without body is dispatched immediately', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        (req) =>
          new Response(null, {
            status: 200,
            headers: { 'x-method': req.method },
          }),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/resource', { method: 'DELETE' }),
      );
      t.equal(response.status, 200, 'DELETE returns 200');
      t.equal(response.headers.get('x-method'), 'DELETE', 'server received DELETE method');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('explicit content-length response header is forwarded to client', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        (_req) =>
          new Response('hello', {
            headers: {
              'content-length': '5',
              'content-type': 'text/plain',
            },
          }),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));
      t.equal(response.status, 200, 'response status is 200');
      t.equal(response.headers.get('content-length'), '5', 'content-length is forwarded to client');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'hello', 'response body is correct');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('PUT request with body is dispatched correctly', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedMethod = '';
      let receivedBody = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedMethod = req.method;
        receivedBody = await req.text();
        return new Response(`echo:${receivedBody}`);
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/resource', {
          method: 'PUT',
          body: new TextEncoder().encode('put-data'),
        }),
      );
      t.equal(response.status, 200, 'PUT returns 200');
      t.equal(receivedMethod, 'PUT', 'server received PUT method');
      t.equal(receivedBody, 'put-data', 'server received PUT body');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'echo:put-data', 'response body echoes PUT request');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('concurrent requests with mixed body and no-body complete correctly', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        const body = await req.text();
        return new Response(body || 'empty', { headers: { 'x-method': req.method } });
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const postBody = new Uint8Array(512).fill(65);
      const [rGet, rPost, rDelete] = await pipe.pumpUntil(
        Promise.all([
          session.request('https://localhost/a'),
          session.request('https://localhost/b', {
            method: 'POST',
            body: postBody,
          }),
          session.request('https://localhost/c', { method: 'DELETE' }),
        ]),
      );
      t.equal(rGet.status, 200, 'GET returns 200');
      t.equal(rGet.headers.get('x-method'), 'GET', 'GET method echoed');
      t.equal(rPost.status, 200, 'POST returns 200');
      t.equal(rPost.headers.get('x-method'), 'POST', 'POST method echoed');
      const postText = new TextDecoder().decode(await rPost.arrayBuffer());
      t.equal(postText, 'A'.repeat(512), 'POST body echoed correctly');
      t.equal(rDelete.status, 200, 'DELETE returns 200');
      t.equal(rDelete.headers.get('x-method'), 'DELETE', 'DELETE method echoed');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('large body (100 KB) round-trip', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedByteCount = 0;
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        const ab = await req.arrayBuffer();
        receivedByteCount = ab.byteLength;
        return new Response(new Uint8Array(ab));
      });
      const bodySize = 100 * 1024;
      const payload = new Uint8Array(bodySize);
      for (let i = 0; i < bodySize; i++) payload[i] = i & 255;
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/large', {
          method: 'POST',
          body: payload,
        }),
      );
      t.equal(response.status, 200, 'large body response status');
      t.equal(receivedByteCount, bodySize, 'server received all bytes');
      const received = new Uint8Array(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(received.byteLength, bodySize, 'client received all echoed bytes');
      t.ok(
        received.every((b, i) => b === (i & 255)),
        'echoed bytes match original',
      );
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('HEAD response body is suppressed even when handler returns one', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        () => new Response('should-not-arrive', { headers: { 'content-length': '17' } }),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/', { method: 'HEAD' }),
      );
      t.equal(response.status, 200, 'HEAD returns 200');
      t.equal(response.headers.get('content-length'), '17', 'content-length header forwarded');
      const body = new Uint8Array(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(body.byteLength, 0, 'body is empty for HEAD response');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('PATCH request with body is dispatched correctly', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedMethod = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedMethod = req.method;
        const body = await req.text();
        return new Response(`echo:${body}`, { headers: { 'x-method': req.method } });
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/item', {
          method: 'PATCH',
          body: new TextEncoder().encode('patch-payload'),
        }),
      );
      t.equal(response.status, 200, 'PATCH returns 200');
      t.equal(response.headers.get('x-method'), 'PATCH', 'server received PATCH method');
      t.equal(receivedMethod, 'PATCH', 'server method matches');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'echo:patch-payload', 'response body echoes PATCH request');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('request trailers from client are received by the server handler', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let receivedTrailers: Array<[string, string]> = [];
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        await req.arrayBuffer();
        receivedTrailers = (req as any).trailerHeaders as Array<[string, string]>;
        return new Response('ok');
      });
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(
        session.request('https://localhost/', {
          method: 'POST',
          body: new TextEncoder().encode('body-data'),
          trailers: [
            ['x-req-trailer', 'trailer-value'],
            ['x-seq', '42'],
          ],
        }),
      );
      t.equal(response.status, 200, 'request with trailers returns 200');
      t.equal(receivedTrailers.length, 2, 'server received 2 trailer entries');
      const trailerMap = Object.fromEntries(receivedTrailers);
      t.equal(trailerMap['x-req-trailer'], 'trailer-value', 'x-req-trailer received');
      t.equal(trailerMap['x-seq'], '42', 'x-seq received');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('handler returning non-Response value sends 500 to client', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => undefined as any);
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));
      t.equal(response.status, 500, 'non-Response handler yields 500');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('forbidden headers in response trailers are stripped (RFC 9114 §4.2)', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(
        serverConn,
        () =>
          new Response('body', {
            trailers: new Headers([
              ['transfer-encoding', 'chunked'],
              ['x-safe', 'yes'],
            ]),
          } as any),
      );
      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));
      t.equal(response.status, 200, 'response with filtered trailers is 200');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'body', 'response body is correct');
      const trailers = await response.trailers;
      t.equal(trailers.get('x-safe'), 'yes', 'safe trailer is received');
      t.equal(trailers.get('transfer-encoding'), null, 'forbidden trailer is stripped');
      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
  it('server closeWhenIdle sends GOAWAY and onShutdown rejects higher stream IDs', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      // Raw server session — gives us direct access to closeWhenIdle().
      let serverSession!: Nghttp3Session;
      serverSession = Nghttp3Session.createServer({
        onBeginHeaders() {},
        onRecvHeader() {},
        onEndHeaders(sid) {
          // Dispatch response immediately on header completion — no body for GET requests.
          void (async () => {
            try {
              serverSession.submitResponse(sid, [[':status', '200']]);
              serverSession.drainWrites();
            } catch {}
          })();
        },
        onBeginTrailers() {},
        onRecvTrailer() {},
        onEndTrailers() {},
        onRecvData() {},
        onEndStream() {},
        onStreamClose() {},
        onResetStream() {},
        onAckedStreamData() {},
      });
      serverConn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          try {
            if (stream.direction === 'bidirectional') {
              serverSession.addQuicStream(sid, stream.writer);
            }
            while (true) {
              const result = await stream.reader.read();
              if (result.done) {
                serverSession.endStream(sid);
                break;
              }
              serverSession.receiveStreamData(sid, result.value);
            }
          } catch {}
        })();
      });
      const [ctrl, qenc, qdec] = (await pipe.pumpUntil(
        Promise.all([
          serverConn.openUnidirectionalStream(),
          serverConn.openUnidirectionalStream(),
          serverConn.openUnidirectionalStream(),
        ]),
      )) as QuicStream[];
      for (const s of [ctrl, qenc, qdec]) serverSession.addQuicStream(BigInt(s.id), s.writer);
      serverSession.bindControlStream(BigInt(ctrl.id));
      serverSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
      // Create the client session before pumping server drainWrites so its 'stream'
      // listener is attached before the server's SETTINGS arrive on stream 3.
      const clientSessionPromise = H3ClientSession.create(clientConn);
      serverSession.drainWrites();
      await pipe.runUntilSettled();
      const clientSession = await pipe.pumpUntil(clientSessionPromise);
      // Complete request 1 (stream 0) — server's onEndHeaders responds with 200.
      const req1 = await pipe.pumpUntil(clientSession.request('https://localhost/'));
      t.equal(req1.status, 200, 'request 1 succeeds before GOAWAY');
      await pipe.pumpUntil(req1.arrayBuffer());
      // Pump the GOAWAY through to the client. After this returns, onShutdown has
      // fired and #goawayStreamId is set — so request() throws before opening
      // a new stream, regardless of the conservative GOAWAY identifier nghttp3 sent.
      await serverSession.closeWhenIdle();
      await pipe.pumpUntil(clientSession._waitForGoawayForTest());
      await t.rejects(
        () => clientSession.request('https://localhost/'),
        /GOAWAY/,
        'request after GOAWAY is rejected',
      );
      serverConn.destroy();
      clientConn.destroy();
    } finally {
      await pipe.close();
    }
  });
  it('server per-stream RESET_STREAM rejects only that request, not concurrent ones', async (t) => {
    if (!available) return;
    // Verifies that a QUIC RESET_STREAM sent by the server for one specific stream
    // rejects only that pending request — the other concurrent request on a different
    // stream completes normally, confirming stream isolation.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      // Raw server session: stream 0 gets reset at the QUIC level, stream 4 responds normally.
      let serverSession!: Nghttp3Session;
      serverSession = Nghttp3Session.createServer({
        onBeginHeaders() {},
        onRecvHeader() {},
        onEndHeaders(sid) {
          void (async () => {
            try {
              serverSession.submitResponse(sid, [[':status', '200']]);
              serverSession.drainWrites();
            } catch {}
          })();
        },
        onBeginTrailers() {},
        onRecvTrailer() {},
        onEndTrailers() {},
        onRecvData() {},
        onEndStream() {},
        onStreamClose() {},
        onResetStream() {},
        onAckedStreamData() {},
      });
      serverConn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          try {
            if (stream.direction === 'bidirectional' && sid === 0n) {
              // Reset stream 0 without processing it through nghttp3.
              // H3_REQUEST_CANCELLED = 0x010c signals an intentional server-side rejection.
              stream.reset(268);
              return;
            }
            if (stream.direction === 'bidirectional') {
              serverSession.addQuicStream(sid, stream.writer);
            }
            while (true) {
              const result = await stream.reader.read();
              if (result.done) {
                serverSession.endStream(sid);
                break;
              }
              serverSession.receiveStreamData(sid, result.value);
            }
          } catch {}
        })();
      });
      const [ctrl, qenc, qdec] = (await pipe.pumpUntil(
        Promise.all([
          serverConn.openUnidirectionalStream(),
          serverConn.openUnidirectionalStream(),
          serverConn.openUnidirectionalStream(),
        ]),
      )) as QuicStream[];
      for (const s of [ctrl, qenc, qdec]) serverSession.addQuicStream(BigInt(s.id), s.writer);
      serverSession.bindControlStream(BigInt(ctrl.id));
      serverSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
      const clientSessionPromise = H3ClientSession.create(clientConn);
      serverSession.drainWrites();
      await pipe.runUntilSettled();
      const clientSession = await pipe.pumpUntil(clientSessionPromise);
      const [resetResult, okResult] = await pipe.pumpUntil(
        Promise.allSettled([
          clientSession.request('https://localhost/reset'),
          clientSession.request('https://localhost/ok'),
        ]),
      );
      t.equal(resetResult.status, 'rejected', 'stream 0 reset by server rejects that request');
      t.equal(okResult.status, 'fulfilled', 'concurrent request on stream 4 completes normally');
      if (okResult.status === 'fulfilled') {
        t.equal(
          (okResult as PromiseFulfilledResult<Response>).value.status,
          200,
          'stream 4 request returns 200',
        );
      }
      serverConn.destroy();
      clientConn.destroy();
    } finally {
      await pipe.close();
    }
  });
  it('CONNECT request is rejected with 405', async (t) => {
    if (!available) return;
    // Per RFC 9114 §4.4, CONNECT requests send HEADERS without FIN and omit :path/:scheme.
    // Without the noBody fix, startDispatch never fires for CONNECT and the client hangs.
    // We use a raw Nghttp3Session client because H3ClientSession.request() always includes
    // :path/:scheme, which nghttp3 rejects as malformed before our dispatch fix applies.
    //
    // Critical ordering: register the clientConn stream listener BEFORE any pumpUntil so
    // the server's unidirectional control/QPACK streams are captured as they arrive.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) => new Response('ok'));
      let connectStatus = '';
      let resolveConnect!: () => void;
      const connectResponsePromise = new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });
      const clientSession = Nghttp3Session.createClient({
        onBeginHeaders() {},
        onRecvHeader(_sid, _token, name, value) {
          if (name === ':status') {
            connectStatus = value;
            resolveConnect();
          }
        },
        onEndHeaders() {},
        onBeginTrailers() {},
        onRecvTrailer() {},
        onEndTrailers() {},
        onRecvData() {},
        onEndStream() {},
        onStreamClose() {},
        onResetStream() {},
        onAckedStreamData() {},
      });
      // Register BEFORE pumpUntil — same ordering discipline as H3ClientSession.create().
      clientConn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          try {
            while (true) {
              const result = await stream.reader.read();
              if (result.done) {
                clientSession.endStream(sid);
                break;
              }
              clientSession.receiveStreamData(sid, result.value);
            }
          } catch {}
        })();
      });
      // Open and bind client's mandatory unidirectional streams, drain client SETTINGS.
      const [ctrl, qenc, qdec] = (await pipe.pumpUntil(
        Promise.all([
          clientConn.openUnidirectionalStream(),
          clientConn.openUnidirectionalStream(),
          clientConn.openUnidirectionalStream(),
        ]),
      )) as QuicStream[];
      for (const s of [ctrl, qenc, qdec]) clientSession.addQuicStream(BigInt(s.id), s.writer);
      clientSession.bindControlStream(BigInt(ctrl.id));
      clientSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
      clientSession.drainWrites();
      await pipe.runUntilSettled();
      // Open the CONNECT stream and read the server's 405 response.
      const connectStream = (await pipe.pumpUntil(
        clientConn.openBidirectionalStream(),
      )) as QuicStream;
      const connectSid = BigInt(connectStream.id);
      clientSession.addQuicStream(connectSid, connectStream.writer);
      void (async () => {
        try {
          while (true) {
            const result = await connectStream.reader.read();
            if (result.done) {
              clientSession.endStream(connectSid);
              break;
            }
            clientSession.receiveStreamData(connectSid, result.value);
          }
        } catch {}
      })();
      // Submit CONNECT with only :method and :authority (RFC 9114 §4.4).
      clientSession.submitRequest(connectSid, [
        [':method', 'CONNECT'],
        [':authority', 'localhost:443'],
      ]);
      clientSession.drainWrites();
      await pipe.runUntilSettled();
      await pipe.pumpUntil(connectResponsePromise);
      t.equal(connectStatus, '405', 'server rejects CONNECT with 405');
      t.ok(!clientSession.isClosed, 'nghttp3 client session remains open after 405');
      clientSession.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });
  it('rejects non-CONNECT requests missing :scheme before handler dispatch', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let handlerCalled = false;
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => {
        handlerCalled = true;
        return new Response('unexpected');
      });
      const outcome = await rawH3RequestOutcome(
        pipe,
        clientConn,
        [
          [':method', 'GET'],
          [':path', '/missing-scheme'],
          [':authority', 'localhost'],
        ],
        80,
      );
      t.equal(outcome, 'no-response', 'server rejects missing :scheme without an HTTP response');
      t.equal(handlerCalled, false, 'handler is not invoked for malformed request control data');
      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });
  it('rejects :protocol on non-CONNECT requests before handler dispatch', async (t) => {
    if (!available) return;
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let handlerCalled = false;
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => {
        handlerCalled = true;
        return new Response('unexpected');
      });
      const outcome = await rawH3RequestOutcome(
        pipe,
        clientConn,
        [
          [':method', 'GET'],
          [':scheme', 'https'],
          [':path', '/invalid-protocol'],
          [':authority', 'localhost'],
          [':protocol', 'webtransport-h3'],
        ],
        80,
      );
      t.equal(
        outcome,
        'no-response',
        'server rejects :protocol outside CONNECT without an HTTP response',
      );
      t.equal(
        handlerCalled,
        false,
        'handler is not invoked for invalid extended CONNECT pseudo-header use',
      );
      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });
  it('GOAWAY rejects in-flight requests with sid equal to its identifier', async (t) => {
    if (!available) return;
    // Timeline:
    //   1. reqA (stream 0) completes — server's last received bidi = 0.
    //   2. reqB (stream 4) and reqC (stream 8) submitted before any pump.
    //   3. closeWhenIdle() queued on server. Server has received only stream 0, so
    //      nghttp3_conn_shutdown sets the first rejected stream ID to 4.
    //   4. Pump: GOAWAY(4) reaches client → onShutdown(4) →
    //        reqB sid=4 and reqC sid=8 are both rejected. RFC 9114 §5.2
    //        defines the GOAWAY identifier as the first rejected stream ID.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      let serverSession!: Nghttp3Session;
      serverSession = Nghttp3Session.createServer({
        onBeginHeaders() {},
        onRecvHeader() {},
        onEndHeaders(sid) {
          void (async () => {
            try {
              serverSession.submitResponse(sid, [[':status', '200']]);
              serverSession.drainWrites();
            } catch {}
          })();
        },
        onBeginTrailers() {},
        onRecvTrailer() {},
        onEndTrailers() {},
        onRecvData() {},
        onEndStream() {},
        onStreamClose() {},
        onResetStream() {},
        onAckedStreamData() {},
      });
      serverConn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          try {
            if (stream.direction === 'bidirectional') {
              serverSession.addQuicStream(sid, stream.writer);
            }
            while (true) {
              const result = await stream.reader.read();
              if (result.done) {
                serverSession.endStream(sid);
                break;
              }
              serverSession.receiveStreamData(sid, result.value);
            }
          } catch {}
        })();
      });
      const [ctrl, qenc, qdec] = (await pipe.pumpUntil(
        Promise.all([
          serverConn.openUnidirectionalStream(),
          serverConn.openUnidirectionalStream(),
          serverConn.openUnidirectionalStream(),
        ]),
      )) as QuicStream[];
      for (const s of [ctrl, qenc, qdec]) serverSession.addQuicStream(BigInt(s.id), s.writer);
      serverSession.bindControlStream(BigInt(ctrl.id));
      serverSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
      const clientSessionPromise = H3ClientSession.create(clientConn);
      serverSession.drainWrites();
      await pipe.runUntilSettled();
      const clientSession = await pipe.pumpUntil(clientSessionPromise);
      // Step 1: reqA (stream 0) completes.
      const reqA = clientSession.request('https://localhost/a');
      const respA = await pipe.pumpUntil(reqA);
      t.equal(respA.status, 200, 'reqA (stream 0) completes with 200 before GOAWAY');
      // Steps 2–3: submit reqB (stream 4) and reqC (stream 8), then queue GOAWAY —
      // all before pumping. Server has only received stream 0, so lastStreamId = 4.
      const reqB = clientSession.request('https://localhost/b');
      const reqC = clientSession.request('https://localhost/c');
      const goawayDone = serverSession.closeWhenIdle();
      let reqBError: unknown;
      const reqBSettled = reqB.then(
        () => {
          reqBError = new Error('reqB resolved instead of rejecting');
        },
        (e: unknown) => {
          reqBError = e;
        },
      );
      let reqCError: unknown;
      const reqCSettled = reqC.then(
        () => {
          reqCError = new Error('reqC resolved instead of rejecting');
        },
        (e: unknown) => {
          reqCError = e;
        },
      );
      // Step 4: pump until GOAWAY is sent and both rejected requests settle.
      await pipe.pumpUntil(Promise.all([goawayDone, reqBSettled, reqCSettled]));
      t.ok(reqBError instanceof Error, 'reqB at the GOAWAY identifier was rejected');
      t.ok(
        reqBError instanceof Error && /GOAWAY/.test(reqBError.message),
        `reqB rejected with GOAWAY: ${String(reqBError)}`,
      );
      t.ok(reqCError instanceof Error, 'reqC was rejected');
      t.ok(
        reqCError instanceof Error && /GOAWAY/.test(reqCError.message),
        `reqC rejected with GOAWAY: ${String(reqCError)}`,
      );
      // Future requests also rejected via #goawayStreamId guard.
      await t.rejects(
        () => clientSession.request('https://localhost/d'),
        /GOAWAY/,
        'new request after GOAWAY is rejected immediately',
      );
      serverConn.destroy();
      clientConn.destroy();
    } finally {
      await pipe.close();
    }
  });
});
