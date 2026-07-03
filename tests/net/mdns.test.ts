/**
* Tests for fino:net/mdns — query-only mDNS and DNS-SD helpers.
*/
import { describe, it } from 'fino:test/test';
import { Mdns } from 'fino:net/mdns';
import { RECORD_TYPES, _buildQuery, _decodeName, _encodeName, _parseResponse } from 'fino:net/dns';
import * as sock from 'fino:net/socket';
import * as loop from 'internal:runtime/loop';

function writeU16(out: number[], value: number): void {
  out.push(value >> 8 & 255, value & 255);
}

function writeU32(out: number[], value: number): void {
  out.push(value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255);
}

type FixtureRecord = {
  name?: string;
  type: number;
  data: string | string[] | { priority: number; weight: number; port: number; target: string };
  ttl?: number;
  cacheFlush?: boolean;
};

function txtBytes(parts: string[]): number[] {
  const encoder = new TextEncoder();
  const out: number[] = [];
  for (const part of parts) {
    const bytes = encoder.encode(part);
    out.push(bytes.byteLength, ...bytes);
  }
  return out;
}

function rdata(record: FixtureRecord): number[] {
  if (record.type === RECORD_TYPES.A) return String(record.data).split('.').map((part) => Number(part));
  if (record.type === RECORD_TYPES.PTR) return Array.from(_encodeName(String(record.data)));
  if (record.type === RECORD_TYPES.TXT) return txtBytes(record.data as string[]);
  if (record.type === RECORD_TYPES.SRV) {
    const srv = record.data as { priority: number; weight: number; port: number; target: string };
    const out: number[] = [];
    writeU16(out, srv.priority);
    writeU16(out, srv.weight);
    writeU16(out, srv.port);
    out.push(..._encodeName(srv.target));
    return out;
  }
  throw new Error(`unsupported fixture record type ${record.type}`);
}

function buildResponse(query: Uint8Array, records: FixtureRecord[]): Uint8Array {
  const { nextOffset } = _decodeName(query, 12);
  const question = query.slice(12, nextOffset + 4);
  const out: number[] = [];
  writeU16(out, 0);
  writeU16(out, 0x8400);
  writeU16(out, 1);
  writeU16(out, records.length);
  writeU16(out, 0);
  writeU16(out, 0);
  out.push(...question);
  for (const record of records) {
    out.push(...(record.name ? _encodeName(record.name) : [0xc0, 0x0c]));
    writeU16(out, record.type);
    writeU16(out, (record.cacheFlush ? 0x8000 : 0) | 1);
    writeU32(out, record.ttl ?? 120);
    const bytes = rdata(record);
    writeU16(out, bytes.length);
    out.push(...bytes);
  }
  return new Uint8Array(out);
}

function parseQuestion(packet: Uint8Array): { name: string; type: number } {
  const decoded = _decodeName(packet, 12);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return { name: decoded.name, type: view.getUint16(decoded.nextOffset, false) };
}

function startFixture(respond: (packet: Uint8Array) => FixtureRecord[]): { address: sock.Address; close(): void; done: Promise<void> } {
  const fd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
  sock.bind(fd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
  sock.setNonblocking(fd);
  const address = sock.getsockname(fd);
  if (address.family !== 'ipv4') throw new Error('expected IPv4 fixture');
  let closed = false;
  const done = (async () => {
    while (!closed) {
      const timeout = loop.timeout(20);
      const readable = await Promise.race([loop.readable(fd).then(() => true, () => false), timeout.then(() => false)]);
      timeout.cancel();
      if (!readable) loop.removeRead(fd);
      if (!readable || closed) break;
      const packet = sock.recvfrom(fd, 4096);
      if (typeof packet === 'number') continue;
      const records = respond(packet.data);
      sock.sendto(fd, buildResponse(packet.data, records), packet.addr as sock.Address);
    }
  })();
  return {
    address,
    close() {
      closed = true;
      sock.close(fd);
    },
    done
  };
}

async function recvWithTimeout(fd: number, timeoutMs = 500): Promise<Uint8Array> {
  const timeout = loop.timeout(timeoutMs);
  const readable = await Promise.race([loop.readable(fd).then(() => true, () => false), timeout.then(() => false)]);
  timeout.cancel();
  if (!readable) {
    loop.removeRead(fd);
    throw new Error('timed out waiting for UDP packet');
  }
  const packet = sock.recvfrom(fd, 4096);
  if (typeof packet === 'number') throw new Error('expected UDP packet');
  return packet.data;
}

describe('Mdns query-only discovery', () => {
  it('resolveHost queries an mDNS endpoint and returns A records', async (t) => {
    const fixture = startFixture(() => [{
      type: RECORD_TYPES.A,
      data: '192.168.1.44',
      ttl: 120,
      cacheFlush: true
    }]);
    try {
      const mdns = new Mdns();
      try {
        const records = await mdns.resolveHost('printer.local', {
          server: fixture.address,
          timeoutMs: 500
        });
        t.deepEqual(records, ['192.168.1.44'], 'resolveHost returns address records');
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('browse yields PTR service instances', async (t) => {
    const fixture = startFixture((packet) => {
      const question = parseQuestion(packet);
      t.equal(question.name, '_http._tcp.local', 'browse sends PTR name');
      return [{ type: RECORD_TYPES.PTR, data: 'Printer._http._tcp.local' }];
    });
    try {
      const mdns = new Mdns();
      try {
        const iter = mdns.browse('_http._tcp.local', { server: fixture.address, timeoutMs: 500 })[Symbol.asyncIterator]();
        const event = await iter.next();
        t.equal(event.done, false, 'browse yields an event');
        t.equal(event.value.name, 'Printer._http._tcp.local', 'browse event contains service instance');
        t.equal(event.value.type, 'up', 'browse event reports an up record');
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('resolveService combines SRV, TXT, and address records', async (t) => {
    const fixture = startFixture((packet) => {
      const question = parseQuestion(packet);
      if (question.type === RECORD_TYPES.SRV) {
        return [{ type: RECORD_TYPES.SRV, data: { priority: 0, weight: 0, port: 8080, target: 'printer.local' } }];
      }
      if (question.type === RECORD_TYPES.TXT) {
        return [{ type: RECORD_TYPES.TXT, data: ['Path=/print', 'duplex', 'PATH=ignored'] }];
      }
      return [{ type: RECORD_TYPES.A, data: '192.168.1.44' }];
    });
    try {
      const mdns = new Mdns();
      try {
        const service = await mdns.resolveService('Printer._http._tcp.local', { server: fixture.address, timeoutMs: 500 });
        t.equal(service.target, 'printer.local', 'SRV target is returned');
        t.equal(service.port, 8080, 'SRV port is returned');
        t.deepEqual(service.addresses, ['192.168.1.44'], 'target addresses are resolved');
        t.equal(new TextDecoder().decode(service.txt.get('path') as Uint8Array), '/print', 'TXT key is lowercased');
        t.equal(service.txt.get('duplex'), true, 'boolean TXT attribute is preserved');
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('publish answers PTR browse and service resolution queries', async (t) => {
    const mdns = new Mdns();
    try {
      const registration = await mdns.publish({
        name: 'Printer',
        serviceType: '_http._tcp.local',
        target: 'printer.local',
        port: 8080,
        txt: { path: '/print', duplex: true },
        addresses: ['192.168.1.44']
      }, { address: { family: 'ipv4', ip: '127.0.0.1', port: 0 } });
      try {
        const browser = new Mdns();
        try {
          const service = await browser.resolveService('Printer._http._tcp.local', {
            server: registration.address,
            timeoutMs: 500
          });
          t.equal(service.port, 8080, 'published SRV record is resolved');
          t.deepEqual(service.addresses, ['192.168.1.44'], 'published address record is resolved');
          t.equal(new TextDecoder().decode(service.txt.get('path') as Uint8Array), '/print', 'published TXT data is resolved');
        } finally {
          await browser.close();
        }
      } finally {
        await registration.close();
      }
    } finally {
      await mdns.close();
    }
  });
  it('publish sends zero-TTL goodbye records to queriers on close', async (t) => {
    const mdns = new Mdns();
    const clientFd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
    sock.setNonblocking(clientFd);
    try {
      const registration = await mdns.publish({
        name: 'Printer',
        serviceType: '_http._tcp.local',
        target: 'printer.local',
        port: 8080,
        txt: { path: '/print' },
        addresses: ['192.168.1.44']
      }, { address: { family: 'ipv4', ip: '127.0.0.1', port: 0 } });
      try {
        sock.sendto(clientFd, _buildQuery(0, '_http._tcp.local', RECORD_TYPES.PTR), registration.address);
        await recvWithTimeout(clientFd);
        await registration.close();
        const goodbye = _parseResponse(await recvWithTimeout(clientFd));
        const records = [...goodbye.answers, ...goodbye.authorities, ...goodbye.additionals];
        t.ok(records.some((record) => record.type === RECORD_TYPES.PTR && record.ttl === 0 && record.data === 'Printer._http._tcp.local'), 'goodbye includes zero-TTL PTR record');
        t.ok(records.some((record) => record.type === RECORD_TYPES.SRV && record.ttl === 0), 'goodbye includes zero-TTL SRV record');
        t.ok(records.some((record) => record.type === RECORD_TYPES.TXT && record.ttl === 0), 'goodbye includes zero-TTL TXT record');
        t.ok(records.some((record) => record.type === RECORD_TYPES.A && record.ttl === 0), 'goodbye includes zero-TTL address record');
      } finally {
        await registration.close();
      }
    } finally {
      sock.close(clientFd);
      await mdns.close();
    }
  });
});
