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
  it('exports multicast socket constants and helpers', (t) => {
    t.equal(typeof sock.IP_ADD_MEMBERSHIP, 'number', 'IPv4 join constant is exported');
    t.equal(typeof sock.IP_DROP_MEMBERSHIP, 'number', 'IPv4 leave constant is exported');
    t.equal(typeof sock.IP_MULTICAST_TTL, 'number', 'IPv4 multicast TTL constant is exported');
    t.equal(typeof sock.IPV6_JOIN_GROUP, 'number', 'IPv6 join constant is exported');
    t.equal(typeof sock.IPV6_LEAVE_GROUP, 'number', 'IPv6 leave constant is exported');
    t.equal(typeof sock.joinMulticastGroup, 'function', 'joinMulticastGroup helper is exported');
    t.equal(typeof sock.leaveMulticastGroup, 'function', 'leaveMulticastGroup helper is exported');
    t.equal(typeof sock.setMulticastOptions, 'function', 'setMulticastOptions helper is exported');
    t.equal(typeof sock.networkInterfaces, 'function', 'networkInterfaces helper is exported');
    t.equal(typeof sock.interfaceIndex, 'function', 'interfaceIndex helper is exported');
    t.equal(
      typeof sock.networkInterfaceIndices,
      'function',
      'networkInterfaceIndices helper is exported',
    );
  });
  it('enumerates network interface indexes', (t) => {
    const interfaces = sock.networkInterfaces();
    t.equal(Array.isArray(interfaces), true, 'networkInterfaces returns an array');
    t.equal(
      interfaces.every(
        (iface) =>
          Number.isInteger(iface.index) && iface.index > 0 && typeof iface.name === 'string',
      ),
      true,
      'interfaces include positive indexes and names',
    );
    t.equal(
      interfaces.every((iface) => iface.addresses === undefined || Array.isArray(iface.addresses)),
      true,
      'interfaces allow optional address arrays',
    );
    t.equal(
      interfaces.every((iface) => iface.up === undefined || typeof iface.up === 'boolean'),
      true,
      'interfaces allow optional boolean up flags',
    );
    t.equal(
      interfaces.every(
        (iface) => iface.multicast === undefined || typeof iface.multicast === 'boolean',
      ),
      true,
      'interfaces allow optional boolean multicast flags',
    );
    const indices = sock.networkInterfaceIndices();
    t.deepEqual(
      indices,
      interfaces.map((iface) => iface.index),
      'networkInterfaceIndices matches networkInterfaces indexes',
    );
    if (interfaces.length > 0 && interfaces[0]!.name.length > 0) {
      t.equal(
        sock.interfaceIndex(interfaces[0]!.name),
        interfaces[0]!.index,
        'interfaceIndex resolves an enumerated name',
      );
    }
  });
});
describe('Address encoding / decoding', () => {
  it('encodeAddr / decodeAddr — IPv4', (t) => {
    const { buf } = sock.encodeAddr({
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 9900,
    });
    const a = sock.decodeAddr(buf);
    t.equal(a.family, 'ipv4');
    if (a.family !== 'ipv4' || !('ip' in a) || !('port' in a)) throw new Error('expected ipv4');
    t.equal(a.ip, '127.0.0.1');
    t.equal(a.port, 9900);
  });
  it('encodeAddr / decodeAddr — IPv6', (t) => {
    const { buf } = sock.encodeAddr({
      family: 'ipv6',
      ip: '::1',
      port: 9901,
    });
    const a = sock.decodeAddr(buf);
    t.equal(a.family, 'ipv6');
    if (a.family !== 'ipv6' || !('ip' in a) || !('port' in a)) throw new Error('expected ipv6');
    t.equal(a.ip, '::1');
    t.equal(a.port, 9901);
  });
  it('encodeAddr / decodeAddr — IPv6 scopeId', (t) => {
    const { buf } = sock.encodeAddr({
      family: 'ipv6',
      ip: '::1',
      port: 9902,
      scopeId: 7,
    });
    const a = sock.decodeAddr(buf);
    t.equal(a.family, 'ipv6');
    if (a.family !== 'ipv6') throw new Error('expected ipv6');
    t.equal(a.scopeId, 7, 'scopeId round-trips through sockaddr_in6');
  });
  it('encodeAddr / decodeAddr — Unix', (t) => {
    const { buf } = sock.encodeAddr({
      family: 'unix',
      path: '/tmp/fino_test.sock',
    });
    const a = sock.decodeAddr(buf);
    t.equal(a.family, 'unix');
    if (a.family !== 'unix' || !('path' in a)) throw new Error('expected unix');
    t.equal(a.path, '/tmp/fino_test.sock');
  });
});
describe('TCP / UDP loopback', () => {
  it('TCP echo via loop.readable / loop.writable', async (t) => {
    const serverFd = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setsockopt(serverFd, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(serverFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    sock.listen(serverFd, 10);
    sock.setNonblocking(serverFd);
    const address = sock.getsockname(serverFd);
    if (address.family !== 'ipv4') throw new Error('expected IPv4 socket address');
    const clientFd = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(clientFd);
    sock.connect(clientFd, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: address.port,
    });
    await loop.readable(serverFd);
    const result = sock.accept(serverFd);
    t.ok(result !== null, 'accept returned a connection');
    if (result === null) throw new Error('expected accept result');
    const acceptedFd = result.fd;
    sock.setNonblocking(acceptedFd);
    await loop.writable(clientFd);
    const errBuf = sock.getsockopt(clientFd, sock.SOL_SOCKET, sock.SO_ERROR);
    const errno = new DataView(errBuf).getInt32(0, true);
    t.equal(errno, 0, 'connect succeeded');
    const msg = encodeUtf8('hello, fino!');
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
    const server = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    const client = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(server, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    sock.setNonblocking(server);
    const address = sock.getsockname(server);
    if (address.family !== 'ipv4') throw new Error('expected IPv4 socket address');
    sock.sendto(client, encodeUtf8('udp-ping'), {
      family: 'ipv4',
      ip: '127.0.0.1',
      port: address.port,
    });
    await loop.readable(server);
    const res = sock.recvfrom(server, 256);
    t.ok(res !== null, 'recvfrom returned data');
    if (res === null || typeof res === 'number') throw new Error('expected recvfrom result');
    t.equal(decodeUtf8(res.data), 'udp-ping', 'udp payload matches');
    t.equal(res.addr.family, 'ipv4', 'sender is ipv4');
    sock.close(server);
    sock.close(client);
  });
  it('UDP sendmmsgBatch / recvmmsgBatch transfer datagrams when supported', async (t) => {
    const server = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    const client = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    try {
      sock.bind(server, {
        family: 'ipv4',
        ip: '127.0.0.1',
        port: 0,
      });
      sock.setNonblocking(server);
      const bound = sock.getsockname(server);
      if (bound.family !== 'ipv4') throw new Error('expected IPv4 socket address');
      const dest = {
        family: 'ipv4' as const,
        ip: '127.0.0.1',
        port: bound.port,
      };
      const sent = sock.sendmmsgBatch(client, [
        {
          data: encodeUtf8('batch-one'),
          dest,
        },
        {
          data: encodeUtf8('batch-two'),
          dest,
        },
      ]);
      if (sent === null) {
        t.equal(
          sock.recvmmsgBatch(server, 2),
          null,
          'batch receive reports unsupported with batch send',
        );
        return;
      }
      t.equal(sent.sent, 2, 'sendmmsgBatch accepted both datagrams');
      t.equal(sent.errno, null, 'sendmmsgBatch reports no errno');
      const received = [];
      const deadline = Date.now() + 200;
      while (received.length < 2 && Date.now() < deadline) {
        const batch = sock.recvmmsgBatch(server, 2 - received.length, 64);
        if (typeof batch === 'number') {
          t.ok(batch < 0, 'recvmmsgBatch reports a negative errno when no datagram is ready');
          await Promise.race([loop.readable(server), loop.timeout(20)]);
          continue;
        }
        t.ok(Array.isArray(batch), 'recvmmsgBatch returned datagrams');
        if (!Array.isArray(batch)) throw new Error('expected recvmmsgBatch results');
        received.push(...batch);
        if (batch.length > 0) continue;
        await Promise.race([loop.readable(server), loop.timeout(20)]);
      }
      t.equal(received.length, 2, 'recvmmsgBatch received both datagrams');
      t.deepEqual(
        received.map((packet) => decodeUtf8(packet.data)).sort(),
        ['batch-one', 'batch-two'],
        'batch payloads match',
      );
      for (const packet of received) {
        const raw = packet as any;
        t.ok(
          raw.addrBuffer instanceof ArrayBuffer,
          'batch receive exposes raw sockaddr storage for hot paths',
        );
        t.ok(
          Number.isInteger(raw.addrLen) && raw.addrLen > 0,
          'batch receive reports raw sockaddr length',
        );
        if (
          !(raw.addrBuffer instanceof ArrayBuffer) ||
          !Number.isInteger(raw.addrLen) ||
          raw.addrLen <= 0
        )
          continue;
        const decoded = sock.decodeAddr(raw.addrBuffer.slice(0, raw.addrLen));
        t.equal(
          decoded.family,
          packet.addr.family,
          'raw sockaddr decodes to the reported address family',
        );
        if (decoded.family === 'ipv4' && packet.addr.family === 'ipv4') {
          t.equal(decoded.ip, packet.addr.ip, 'raw sockaddr decodes to the reported IPv4 address');
          t.equal(decoded.port, packet.addr.port, 'raw sockaddr decodes to the reported IPv4 port');
        }
      }
      const rawBatch = sock.createDatagramRecvBatch(2, 64);
      if (rawBatch !== null) {
        const sentRaw = sock.sendmmsgBatch(client, [
          {
            data: encodeUtf8('raw-one'),
            dest,
          },
          {
            data: encodeUtf8('raw-two'),
            dest,
          },
        ]);
        t.ok(sentRaw !== null && sentRaw.sent === 2, 'sendmmsgBatch accepted raw-mode datagrams');
        const recvRaw = (rawBatch as any).recvRaw;
        t.equal(typeof recvRaw, 'function', 'batch receive exposes a raw-address mode');
        if (typeof recvRaw !== 'function') return;
        const rawPayloads: string[] = [];
        const rawDeadline = Date.now() + 200;
        while (rawPayloads.length < 2 && Date.now() < rawDeadline) {
          const rawPackets = recvRaw.call(rawBatch, server);
          if (typeof rawPackets === 'number') {
            if (rawPackets >= 0)
              throw new Error(`unexpected raw-address batch count ${rawPackets}`);
            await Promise.race([loop.readable(server), loop.timeout(20)]);
            continue;
          }
          t.ok(Array.isArray(rawPackets), 'raw-address batch receive returned datagrams');
          if (!Array.isArray(rawPackets)) throw new Error('expected raw-address batch results');
          t.equal(
            rawPackets.some((packet: any) => Object.hasOwn(packet, 'addr')),
            false,
            'raw-address batch receive skips decoded addresses',
          );
          rawPayloads.push(...rawPackets.map((packet: any) => decodeUtf8(packet.data)));
          if (rawPackets.length > 0) continue;
          await Promise.race([loop.readable(server), loop.timeout(20)]);
        }
        t.deepEqual(rawPayloads.sort(), ['raw-one', 'raw-two'], 'raw-address batch payloads match');
        const sentEach = sock.sendmmsgBatch(client, [
          {
            data: encodeUtf8('each-one'),
            dest,
          },
          {
            data: encodeUtf8('each-two'),
            dest,
          },
        ]);
        t.ok(
          sentEach !== null && sentEach.sent === 2,
          'sendmmsgBatch accepted callback-mode datagrams',
        );
        const recvRawEach = (rawBatch as any).recvRawEach;
        t.equal(typeof recvRawEach, 'function', 'batch receive exposes callback raw-address mode');
        if (typeof recvRawEach !== 'function') return;
        const eachPayloads: string[] = [];
        const eachAddrLens: number[] = [];
        let eachCount = 0;
        const eachDeadline = Date.now() + 200;
        while (eachCount < 2 && Date.now() < eachDeadline) {
          const count = recvRawEach.call(
            rawBatch,
            server,
            (data: Uint8Array, addrBuffer: ArrayBuffer, addrLen: number) => {
              t.ok(
                addrBuffer instanceof ArrayBuffer,
                'callback raw-address receive exposes sockaddr storage',
              );
              eachPayloads.push(decodeUtf8(data));
              eachAddrLens.push(addrLen);
            },
          );
          if (count > 0) {
            eachCount += count;
            continue;
          }
          await Promise.race([loop.readable(server), loop.timeout(20)]);
        }
        t.equal(eachCount, 2, 'callback raw-address batch receive reports datagram count');
        t.deepEqual(
          eachPayloads.sort(),
          ['each-one', 'each-two'],
          'callback raw-address batch payloads match',
        );
        t.equal(
          eachAddrLens.every((len) => Number.isInteger(len) && len > 0),
          true,
          'callback raw-address batch reports address lengths',
        );
      }
    } finally {
      sock.close(server);
      sock.close(client);
    }
  });
  it('UDP sendmsgEcn / recvmsgEcn deliver payloads and parse ECN when provided by the OS', async (t) => {
    const server = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    const client = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    try {
      sock.bind(server, {
        family: 'ipv4',
        ip: '127.0.0.1',
        port: 0,
      });
      sock.setNonblocking(server);
      sock.setsockopt(server, sock.IPPROTO_IP, sock.IP_RECVTOS, true);
      const bound = sock.getsockname(server);
      if (bound.family !== 'ipv4') throw new Error('expected IPv4 socket address');
      const sent = sock.sendmsgEcn(
        client,
        encodeUtf8('ecn-ping'),
        {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: bound.port,
        },
        3,
      );
      t.equal(sent, 'ecn-ping'.length, 'sendmsgEcn sends the payload');
      await loop.readable(server);
      const packet = sock.recvmsgEcn(server, 64);
      t.ok(typeof packet !== 'number', 'recvmsgEcn returned a packet');
      if (typeof packet === 'number') throw new Error(`recvmsgEcn failed with errno ${packet}`);
      t.equal(decodeUtf8(packet.data), 'ecn-ping', 'ECN receive payload matches');
      if (packet.ecn !== undefined)
        t.equal(packet.ecn, 3, 'ECN bits are parsed when ancillary data is returned');
    } finally {
      sock.close(server);
      sock.close(client);
    }
  });
  it('UDP recvmsgPacketInfo delivers payloads and parses packet info when provided by the OS', async (t) => {
    const server = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    const client = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    try {
      sock.bind(server, {
        family: 'ipv4',
        ip: '127.0.0.1',
        port: 0,
      });
      sock.setNonblocking(server);
      sock.setsockopt(server, sock.IPPROTO_IP, sock.IP_RECVPKTINFO, true);
      const bound = sock.getsockname(server);
      if (bound.family !== 'ipv4') throw new Error('expected IPv4 socket address');
      const sent = sock.sendto(client, encodeUtf8('pktinfo-ping'), {
        family: 'ipv4',
        ip: '127.0.0.1',
        port: bound.port,
      });
      t.equal(sent, 'pktinfo-ping'.length, 'sendto sends the payload');
      await loop.readable(server);
      const packet = sock.recvmsgPacketInfo(server, 64);
      t.ok(typeof packet !== 'number', 'recvmsgPacketInfo returned a packet');
      if (typeof packet === 'number')
        throw new Error(`recvmsgPacketInfo failed with errno ${packet}`);
      t.equal(decodeUtf8(packet.data), 'pktinfo-ping', 'packet-info receive payload matches');
      if (packet.destination !== undefined) {
        t.equal(packet.destination.family, 'ipv4', 'packet-info destination is IPv4 when supplied');
        t.equal(packet.destination.ip, '127.0.0.1', 'packet-info destination address is parsed');
      }
      if (packet.interfaceIndex !== undefined) {
        t.equal(
          Number.isInteger(packet.interfaceIndex),
          true,
          'packet-info interface index is numeric when supplied',
        );
      }
    } finally {
      sock.close(server);
      sock.close(client);
    }
  });
  it('socket option helpers throw on invalid descriptors', (t) => {
    t.throws(
      () => sock.setsockopt(-1, sock.SOL_SOCKET, sock.SO_REUSEADDR, true),
      /setsockopt\(\) failed/,
      'setsockopt reports syscall failure',
    );
    t.throws(
      () => sock.getsockopt(-1, sock.SOL_SOCKET, sock.SO_ERROR),
      /getsockopt\(\) failed/,
      'getsockopt reports syscall failure',
    );
  });
});
