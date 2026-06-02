/**
 * Tests for fino:socket + fino:loop (promise-based API).
 */

import { describe, it } from 'fino:test/test';
import * as sock from 'fino:net/socket';
import * as loop from 'internal:runtime/loop';
const encodeUtf8 = (s: string) => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView) => new TextDecoder().decode(b);

describe('Constants', () => {
  it('AF_INET is 2', (t) => {
    t.equal(sock.AF_INET, 2);
  });

  it('SOCK_STREAM is 1', (t) => {
    t.equal(sock.SOCK_STREAM, 1);
  });

  it('SOCK_DGRAM is 2', (t) => {
    t.equal(sock.SOCK_DGRAM, 2);
  });
});

describe('Address encoding / decoding', () => {
  it('encodeAddr / decodeAddr — IPv4', (t) => {
    const { buf } = sock.encodeAddr({ family: 'ipv4', ip: '127.0.0.1', port: 9900 });
    const a = sock.decodeAddr(buf);
    t.equal(a.family, 'ipv4');
    if (a.family !== 'ipv4' || !('ip' in a) || !('port' in a)) throw new Error('expected ipv4');
    t.equal(a.ip, '127.0.0.1');
    t.equal(a.port, 9900);
  });

  it('encodeAddr / decodeAddr — IPv6', (t) => {
    const { buf } = sock.encodeAddr({ family: 'ipv6', ip: '::1', port: 9901 });
    const a = sock.decodeAddr(buf);
    t.equal(a.family, 'ipv6');
    if (a.family !== 'ipv6' || !('ip' in a) || !('port' in a)) throw new Error('expected ipv6');
    t.equal(a.ip, '::1');
    t.equal(a.port, 9901);
  });

  it('encodeAddr / decodeAddr — Unix', (t) => {
    const { buf } = sock.encodeAddr({ family: 'unix', path: '/tmp/fino_test.sock' });
    const a = sock.decodeAddr(buf);
    t.equal(a.family, 'unix');
    if (a.family !== 'unix' || !('path' in a)) throw new Error('expected unix');
    t.equal(a.path, '/tmp/fino_test.sock');
  });
});

describe('TCP / UDP loopback', () => {
  it('TCP echo via loop.readable / loop.writable', async (t) => {
    const PORT = 19900;

    const serverFd = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setsockopt(serverFd, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(serverFd, { family: 'ipv4', ip: '127.0.0.1', port: PORT });
    sock.listen(serverFd, 10);
    sock.setNonblocking(serverFd);

    const clientFd = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(clientFd);
    sock.connect(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: PORT });

    await loop.readable(serverFd);
    const result = sock.accept(serverFd);
    t.ok(result !== null, 'accept returned a connection');
    if (result === null) throw new Error('expected accept result');
    const acceptedFd = result.fd;
    sock.setNonblocking(acceptedFd);

    await loop.writable(clientFd);
    const errBuf = sock.getsockopt(clientFd, sock.SOL_SOCKET, sock.SO_ERROR);
    const errno  = new DataView(errBuf).getInt32(0, true);
    t.equal(errno, 0, 'connect succeeded');

    const msg  = encodeUtf8('hello, fino!');
    const sent = sock.send(clientFd, msg, 0);
    t.ok(sent > 0, 'send returned bytes written');

    await loop.readable(acceptedFd);
    const received = sock.recv(acceptedFd, 256, 0);
    t.ok(received instanceof Uint8Array, 'recv returned Uint8Array');
    if (!(received instanceof Uint8Array)) throw new Error('expected Uint8Array');
    t.equal(decodeUtf8(received), 'hello, fino!', 'message matches');

    sock.close(acceptedFd);
    sock.close(clientFd);
    sock.close(serverFd);
  });

  it('loop.timeout fires after delay', async (t) => {
    const before = Date.now();
    await loop.timeout(50);
    const elapsed = Date.now() - before;
    t.ok(elapsed >= 40, 'at least 40ms elapsed (got ' + elapsed + 'ms)');
  });

  it('UDP sendto / recvfrom', async (t) => {
    const PORT = 19901;

    const server = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    const client = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(server, { family: 'ipv4', ip: '127.0.0.1', port: PORT });
    sock.setNonblocking(server);

    sock.sendto(client, encodeUtf8('udp-ping'), { family: 'ipv4', ip: '127.0.0.1', port: PORT });

    await loop.readable(server);
    const res = sock.recvfrom(server, 256);
    t.ok(res !== null, 'recvfrom returned data');
    if (res === null || typeof res === 'number') throw new Error('expected recvfrom result');
    t.equal(decodeUtf8(res.data), 'udp-ping', 'udp payload matches');
    t.equal(res.addr.family, 'ipv4', 'sender is ipv4');

    sock.close(server);
    sock.close(client);
  });
});
