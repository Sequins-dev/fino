/**
 * Tests for Socket, Reader, and Writer classes in fino:socket,
 * and serializeRequest / serializeResponse in fino:http.
 */

import { describe, it } from 'fino:test/test';
import { Socket } from 'fino:net/socket';
const encodeUtf8 = (s: string) => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView) => new TextDecoder().decode(b);
import {
  parseRequest,
  parseResponse,
  Request,
  Response,
  serializeRequest,
  serializeResponse,
} from 'fino:net/http';

async function readAll(reader: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of reader) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
  return out;
}

describe('Connect / Listen', () => {
  it('ephemeral IPv4 bind reports the assigned port', async (t) => {
    const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    try {
      t.ok(server.address.family === 'ipv4' && server.address.port > 0, 'server address includes assigned ephemeral port');

      const clientSock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: (server.address as Extract<typeof server.address, { family: 'ipv4' }>).port });
      const serverConn = await server.accept();

      t.ok(clientSock !== null, 'client connected using assigned port');
      t.ok(serverConn !== null, 'server accepted connection');

      clientSock.close();
      serverConn?.close();
    } finally {
      server.close();
    }
  });

  it('IPv4 TCP — split echo', async (t) => {
    const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const PORT = (server.address as Extract<typeof server.address, { family: 'ipv4' }>).port;
    const clientSock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: PORT });
    const serverConn = await server.accept();
    if (serverConn === null) throw new Error('expected server connection');

    t.ok(clientSock !== null, 'client connected');
    t.ok(serverConn !== null, 'server accepted connection');

    const [serverReader, serverWriter] = serverConn.split();
    const [clientReader, clientWriter] = clientSock.split();

    await clientWriter.write(encodeUtf8('ping'));
    clientWriter.close();

    const received = await readAll(serverReader);
    t.equal(decodeUtf8(received), 'ping', 'server received data');
    serverReader.close();

    await serverWriter.write(encodeUtf8('pong'));
    serverWriter.close();

    const echoed = await readAll(clientReader);
    t.equal(decodeUtf8(echoed), 'pong', 'client received echo');
    clientReader.close();

    server.close();
  });

  it('IPv6 TCP — split echo', async (t) => {
    const server = Socket.listen({ family: 'ipv6', ip: '::1', port: 0 });
    const PORT = (server.address as Extract<typeof server.address, { family: 'ipv6' }>).port;
    const clientSock = await Socket.connect({ family: 'ipv6', ip: '::1', port: PORT });
    const serverConn = await server.accept();
    if (serverConn === null) throw new Error('expected server connection');

    const [serverReader, serverWriter] = serverConn.split();
    const [clientReader, clientWriter] = clientSock.split();

    await clientWriter.write(encodeUtf8('hello-v6'));
    clientWriter.close();

    const received = await readAll(serverReader);
    t.equal(decodeUtf8(received), 'hello-v6', 'IPv6 data received');
    serverReader.close();

    serverWriter.close();
    clientReader.close();
    server.close();
  });

  it('Unix domain socket — split echo', async (t) => {
    const PATH = '/tmp/fino_socket_class_test.sock';

    const server = Socket.listen({ family: 'unix', path: PATH });
    const clientSock = await Socket.connect({ family: 'unix', path: PATH });
    const serverConn = await server.accept();
    if (serverConn === null) throw new Error('expected server connection');

    const [serverReader, serverWriter] = serverConn.split();
    const [clientReader, clientWriter] = clientSock.split();

    await clientWriter.write(encodeUtf8('unix-hello'));
    clientWriter.close();

    const received = await readAll(serverReader);
    t.equal(decodeUtf8(received), 'unix-hello', 'Unix socket data received');
    serverReader.close();

    serverWriter.close();
    clientReader.close();
    server.close();
  });
});

describe('Writer', () => {
  it('Writer.pipe sends all chunks', async (t) => {
    const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const PORT = (server.address as Extract<typeof server.address, { family: 'ipv4' }>).port;
    const clientSock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: PORT });
    const serverConn = await server.accept();
    if (serverConn === null) throw new Error('expected server connection');

    const [serverReader, serverWriter] = serverConn.split();
    const [clientReader, clientWriter] = clientSock.split();

    const chunks = ['chunk-a', 'chunk-b', 'chunk-c'];
    async function* makeIterable() {
      for (const c of chunks) yield encodeUtf8(c);
    }

    await clientWriter.pipe(makeIterable());
    clientWriter.close();

    const received = await readAll(serverReader);
    t.equal(decodeUtf8(received), chunks.join(''), 'pipe sent all chunks');
    serverReader.close();

    serverWriter.close();
    clientReader.close();
    server.close();
  });
});

describe('Server', () => {
  it('[Symbol.asyncIterator] yields connections', async (t) => {
    const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const PORT = (server.address as Extract<typeof server.address, { family: 'ipv4' }>).port;

    const NUM = 3;
    const clientSocks = [];
    for (let i = 0; i < NUM; i++) {
      clientSocks.push(await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: PORT }));
    }

    let accepted = 0;
    const iter = server[Symbol.asyncIterator]();
    for (let i = 0; i < NUM; i++) {
      const { value: conn } = await iter.next();
      t.ok(conn instanceof Socket, 'accepted connection is a Socket');
      conn.close();
      accepted++;
    }
    t.equal(accepted, NUM, 'accepted all connections');

    for (const c of clientSocks) c.close();
    server.close();
  });
});

describe('HTTP integration', () => {
  it('serializeResponse + parseResponse roundtrip via Socket', async (t) => {
    const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const PORT = (server.address as Extract<typeof server.address, { family: 'ipv4' }>).port;
    const clientSock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: PORT });
    const serverConn = await server.accept();
    if (serverConn === null) throw new Error('expected server connection');

    const [serverReader, serverWriter] = serverConn.split();
    const [clientReader, clientWriter] = clientSock.split();

    const res = new Response('hello, http!', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': '12' },
    });
    await serverWriter.pipe(serializeResponse(res));
    serverWriter.close();

    const parsed = await parseResponse(clientReader);
    t.equal(parsed.status, 200, 'status is 200');
    t.equal(parsed.headers.get('content-type'), 'text/plain', 'content-type header');
    t.equal(await parsed.text(), 'hello, http!', 'body text matches');

    serverReader.close();
    clientReader.close();
    server.close();
  });

  it('serializeRequest + parseRequest roundtrip via Socket', async (t) => {
    const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const PORT = (server.address as Extract<typeof server.address, { family: 'ipv4' }>).port;
    const clientSock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: PORT });
    const serverConn = await server.accept();
    if (serverConn === null) throw new Error('expected server connection');

    const [serverReader, serverWriter] = serverConn.split();
    const [clientReader, clientWriter] = clientSock.split();

    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: 'request-body',
      headers: { 'content-type': 'text/plain', 'content-length': '12' },
    });
    await clientWriter.pipe(serializeRequest(req));
    clientWriter.close();

    const parsed = await parseRequest(serverReader);
    t.equal(parsed.method, 'POST', 'method is POST');
    t.ok(parsed.url.includes('/api/test'), 'URL includes path');
    t.equal(parsed.headers.get('content-type'), 'text/plain', 'content-type header');
    t.equal(await parsed.text(), 'request-body', 'body text matches');

    serverReader.close();
    serverWriter.close();
    clientReader.close();
    server.close();
  });
});

describe('Socket lifecycle', () => {
  it('Socket.close() marks socket as closed', async (t) => {
    const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const PORT = (server.address as Extract<typeof server.address, { family: 'ipv4' }>).port;
    const clientSock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: PORT });
    const serverConn = await server.accept();
    if (serverConn === null) throw new Error('expected server connection');

    t.ok(!clientSock.closed, 'socket not closed initially');
    clientSock.close();
    t.ok(clientSock.closed, 'socket closed after close()');

    if (serverConn === null) throw new Error('expected server connection');
    serverConn.close();
    server.close();
  });
});
