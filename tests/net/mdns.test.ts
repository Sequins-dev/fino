/**
 * Tests for fino:net/mdns — query-only mDNS and DNS-SD helpers.
 */
import { describe, it } from 'fino:test/test';
import { Mdns } from 'fino:net/mdns';
import {
  RECORD_TYPES,
  _buildQuery,
  _decodeName,
  _encodeName,
  _parseResponse,
} from 'internal:net/dns-wire';
import * as sock from 'fino:net/socket';
import * as loop from 'internal:runtime/loop';

function writeU16(out: number[], value: number): void {
  out.push((value >> 8) & 255, value & 255);
}

function writeU32(out: number[], value: number): void {
  out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
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
  if (record.type === RECORD_TYPES.A)
    return String(record.data)
      .split('.')
      .map((part) => Number(part));
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
function buildQueryWithKnownAnswer(name: string, qtype: number, record: FixtureRecord): Uint8Array {
  const out: number[] = [];
  writeU16(out, 0);
  writeU16(out, 0);
  writeU16(out, 1);
  writeU16(out, 1);
  writeU16(out, 0);
  writeU16(out, 0);
  out.push(..._encodeName(name));
  writeU16(out, qtype);
  writeU16(out, 1);
  out.push(...(record.name ? _encodeName(record.name) : _encodeName(name)));
  writeU16(out, record.type);
  writeU16(out, (record.cacheFlush ? 0x8000 : 0) | 1);
  writeU32(out, record.ttl ?? 120);
  const bytes = rdata(record);
  writeU16(out, bytes.length);
  out.push(...bytes);
  return new Uint8Array(out);
}
function buildUnsolicited(records: FixtureRecord[]): Uint8Array {
  const out: number[] = [];
  writeU16(out, 0);
  writeU16(out, 0x8400);
  writeU16(out, 0);
  writeU16(out, records.length);
  writeU16(out, 0);
  writeU16(out, 0);
  for (const record of records) {
    out.push(..._encodeName(record.name ?? '_http._tcp.local'));
    writeU16(out, record.type);
    writeU16(out, (record.cacheFlush ? 0x8000 : 0) | 1);
    writeU32(out, record.ttl ?? 120);
    const bytes = rdata(record);
    writeU16(out, bytes.length);
    out.push(...bytes);
  }
  return new Uint8Array(out);
}

function parseQuestion(packet: Uint8Array): { name: string; type: number; classCode: number } {
  const decoded = _decodeName(packet, 12);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return {
    name: decoded.name,
    type: view.getUint16(decoded.nextOffset, false),
    classCode: view.getUint16(decoded.nextOffset + 2, false),
  };
}

function startFixture(respond: (packet: Uint8Array) => FixtureRecord[]): {
  address: sock.Address;
  close(): void;
  done: Promise<void>;
} {
  const fd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
  sock.bind(fd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
  sock.setNonblocking(fd);
  const address = sock.getsockname(fd);
  if (address.family !== 'ipv4') throw new Error('expected IPv4 fixture');
  let closed = false;
  const done = (async () => {
    while (!closed) {
      const timeout = loop.timeout(20);
      const readable = await Promise.race([
        loop.readable(fd).then(
          () => true,
          () => false,
        ),
        timeout.then(() => false),
      ]);
      timeout.cancel();
      if (!readable) loop.removeRead(fd);
      if (!readable || closed) continue;
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
    done,
  };
}
function startSilentFixture(onPacket: (packet: Uint8Array, addr: sock.Address) => void): {
  address: sock.Address;
  close(): void;
  done: Promise<void>;
} {
  const fd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
  sock.bind(fd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
  sock.setNonblocking(fd);
  const address = sock.getsockname(fd);
  if (address.family !== 'ipv4') throw new Error('expected IPv4 fixture');
  let closed = false;
  const done = (async () => {
    while (!closed) {
      const timeout = loop.timeout(20);
      const readable = await Promise.race([
        loop.readable(fd).then(
          () => true,
          () => false,
        ),
        timeout.then(() => false),
      ]);
      timeout.cancel();
      if (!readable) loop.removeRead(fd);
      if (!readable || closed) continue;
      const packet = sock.recvfrom(fd, 4096);
      if (typeof packet === 'number') continue;
      onPacket(packet.data, packet.addr as sock.Address);
    }
  })();
  return {
    address,
    close() {
      closed = true;
      sock.close(fd);
    },
    done,
  };
}

async function recvWithTimeout(fd: number, timeoutMs = 500): Promise<Uint8Array> {
  const timeout = loop.timeout(timeoutMs);
  const readable = await Promise.race([
    loop.readable(fd).then(
      () => true,
      () => false,
    ),
    timeout.then(() => false),
  ]);
  timeout.cancel();
  if (!readable) {
    loop.removeRead(fd);
    throw new Error('timed out waiting for UDP packet');
  }
  const packet = sock.recvfrom(fd, 4096);
  if (typeof packet === 'number') throw new Error('expected UDP packet');
  return packet.data;
}
async function hasPacketWithin(fd: number, timeoutMs = 80): Promise<boolean> {
  const timeout = loop.timeout(timeoutMs);
  const readable = await Promise.race([
    loop.readable(fd).then(
      () => true,
      () => false,
    ),
    timeout.then(() => false),
  ]);
  timeout.cancel();
  if (!readable) {
    loop.removeRead(fd);
    return false;
  }
  const packet = sock.recvfrom(fd, 4096);
  return typeof packet !== 'number';
}
async function nextWithTimeout<T>(
  iter: AsyncIterator<T>,
  timeoutMs = 500,
): Promise<IteratorResult<T>> {
  const timeout = loop.timeout(timeoutMs);
  const result = await Promise.race([
    iter.next(),
    timeout.then(() => {
      throw new Error('timed out waiting for iterator event');
    }),
  ]);
  timeout.cancel();
  return result;
}

describe('Mdns query-only discovery', () => {
  it('resolveHost queries an mDNS endpoint and returns A records', async (t) => {
    const fixture = startFixture(() => [
      {
        type: RECORD_TYPES.A,
        data: '192.168.1.44',
        ttl: 120,
        cacheFlush: true,
      },
    ]);
    try {
      const mdns = new Mdns();
      try {
        const records = await mdns.resolveHost('printer.local', {
          server: fixture.address,
          timeoutMs: 500,
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
  it('query can request unicast responses with the mDNS QU bit', async (t) => {
    const fixture = startFixture((packet) => {
      const question = parseQuestion(packet);
      t.equal(question.name, 'printer.local', 'query sends requested name');
      t.equal(question.classCode, 0x8001, 'query sets QU bit on qclass');
      return [
        {
          type: RECORD_TYPES.A,
          data: '192.168.1.44',
          ttl: 120,
        },
      ];
    });
    try {
      const mdns = new Mdns();
      try {
        const records = await mdns.resolveHost('printer.local', {
          server: fixture.address,
          timeoutMs: 500,
          unicastResponse: true,
        });
        t.deepEqual(records, ['192.168.1.44'], 'QU query still resolves response records');
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('query includes known answers in the answer section', async (t) => {
    let queryCount = 0;
    let knownAnswers: Awaited<ReturnType<Mdns['query']>> = [];
    const fixture = startFixture((packet) => {
      queryCount++;
      const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
      if (queryCount === 1) {
        t.equal(view.getUint16(6, false), 0, 'first query has no known-answer section');
      } else {
        t.equal(view.getUint16(6, false), 1, 'second query includes one known answer');
        const parsed = _parseResponse(packet);
        t.equal(parsed.answers[0]?.type, RECORD_TYPES.PTR, 'known answer type is preserved');
        t.equal(
          parsed.answers[0]?.data,
          'Printer._http._tcp.local',
          'known answer rdata is preserved',
        );
      }
      return [
        {
          type: RECORD_TYPES.PTR,
          data: 'Printer._http._tcp.local',
          ttl: 4500,
        },
      ];
    });
    try {
      const mdns = new Mdns();
      try {
        knownAnswers = await mdns.query('_http._tcp.local', 'PTR', {
          server: fixture.address,
          timeoutMs: 500,
        });
        await mdns.query('_http._tcp.local', 'PTR', {
          server: fixture.address,
          timeoutMs: 500,
          knownAnswers,
        });
        t.equal(queryCount, 2, 'fixture received both queries');
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('query reuses fresh cached answers for repeated lookups', async (t) => {
    let queryCount = 0;
    const fixture = startFixture(() => {
      queryCount++;
      return [
        {
          type: RECORD_TYPES.A,
          data: '192.168.1.44',
          ttl: 120,
        },
      ];
    });
    try {
      const mdns = new Mdns();
      try {
        t.deepEqual(
          await mdns.resolveHost('printer.local', { server: fixture.address, timeoutMs: 500 }),
          ['192.168.1.44'],
          'first query resolves from fixture',
        );
        t.deepEqual(
          await mdns.resolveHost('printer.local', { server: fixture.address, timeoutMs: 500 }),
          ['192.168.1.44'],
          'second query resolves from cache',
        );
        t.equal(queryCount, 1, 'fresh cache avoids duplicate network query');
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('query rejects responses outside configured local-link source validation', async (t) => {
    const fixture = startFixture(() => [
      {
        type: RECORD_TYPES.A,
        data: '192.168.1.44',
        ttl: 120,
      },
    ]);
    try {
      const mdns = new Mdns();
      try {
        await t.rejects(
          () =>
            mdns.resolveHost('printer.local', {
              server: fixture.address,
              timeoutMs: 80,
              validateSource: true,
              localInterfaces: [
                {
                  index: 1,
                  name: 'test0',
                  addresses: [{ family: 'ipv4', ip: '192.168.1.10', port: 0 }],
                  netmasks: [{ family: 'ipv4', ip: '255.255.255.0', port: 0 }],
                },
              ],
            }),
          /timed out/,
          'non-local-link response is ignored',
        );
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('query retransmits before timeout when no answer arrives', async (t) => {
    let queries = 0;
    const fixture = startSilentFixture(() => {
      queries++;
    });
    try {
      const mdns = new Mdns();
      try {
        await t.rejects(
          () =>
            mdns.query('missing.local', 'A', {
              server: fixture.address,
              timeoutMs: 70,
              retryMinMs: 10,
              retryMaxMs: 10,
            }),
          /timed out/,
          'missing answer still times out',
        );
        t.ok(queries > 1, `query retransmits before timeout (got ${queries})`);
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
        const iter = mdns
          .browse('_http._tcp.local', { server: fixture.address, timeoutMs: 500 })
          [Symbol.asyncIterator]();
        const event = await iter.next();
        t.equal(event.done, false, 'browse yields an event');
        t.equal(
          event.value.name,
          'Printer._http._tcp.local',
          'browse event contains service instance',
        );
        t.equal(event.value.type, 'up', 'browse event reports an up record');
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('browse suppresses duplicate PTR answers in one-shot results', async (t) => {
    const fixture = startFixture(() => [
      { type: RECORD_TYPES.PTR, data: 'Printer._http._tcp.local' },
      { type: RECORD_TYPES.PTR, data: 'Printer._http._tcp.local' },
    ]);
    try {
      const mdns = new Mdns();
      try {
        const iter = mdns
          .browse('_http._tcp.local', { server: fixture.address, timeoutMs: 500 })
          [Symbol.asyncIterator]();
        const first = await nextWithTimeout(iter);
        const second = await nextWithTimeout(iter);
        t.equal(first.done, false, 'first browse event is yielded');
        t.equal(first.value.name, 'Printer._http._tcp.local', 'first event has the PTR target');
        t.equal(second.done, true, 'duplicate PTR target is not yielded twice');
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('continuous browse emits update for TTL changes and down for zero-TTL goodbye records', async (t) => {
    let queries = 0;
    const fixture = startFixture(() => {
      queries++;
      return [
        {
          type: RECORD_TYPES.PTR,
          data: 'Printer._http._tcp.local',
          ttl: queries === 1 ? 120 : queries === 2 ? 60 : 0,
        },
      ];
    });
    const controller = new AbortController();
    try {
      const mdns = new Mdns();
      try {
        const iter = mdns
          .browse('_http._tcp.local', {
            server: fixture.address,
            timeoutMs: 500,
            settleMs: 1,
            continuous: true,
            pollMs: 1,
            signal: controller.signal,
          })
          [Symbol.asyncIterator]();
        const up = await nextWithTimeout(iter);
        const update = await nextWithTimeout(iter);
        const down = await nextWithTimeout(iter);
        t.equal(up.done, false, 'continuous browse yields the initial service');
        t.equal(up.value.type, 'up', 'first event is up');
        t.equal(update.done, false, 'continuous browse yields changed service event');
        t.equal(update.value.type, 'update', 'changed TTL produces update');
        t.equal(down.done, false, 'continuous browse yields goodbye event');
        t.equal(down.value.type, 'down', 'zero-TTL PTR produces down');
        t.equal(
          down.value.name,
          'Printer._http._tcp.local',
          'down event names the retired service',
        );
        controller.abort(new Error('done'));
      } finally {
        await mdns.close();
      }
    } finally {
      controller.abort(new Error('done'));
      fixture.close();
      await fixture.done;
    }
  });
  it('continuous resolved browse emits update when resolved metadata changes', async (t) => {
    const fixture = startFixture((packet) => {
      const question = parseQuestion(packet);
      if (question.type === RECORD_TYPES.PTR) {
        return [
          {
            type: RECORD_TYPES.PTR,
            data: 'Printer._http._tcp.local',
            ttl: 120,
          },
        ];
      }
      if (question.type === RECORD_TYPES.SRV) {
        return [
          {
            type: RECORD_TYPES.SRV,
            data: {
              priority: 0,
              weight: 0,
              port: question.name === 'Printer._http._tcp.local' ? 8080 + srvQueries++ : 8080,
              target: 'printer.local',
            },
            ttl: 120,
          },
          {
            name: 'Printer._http._tcp.local',
            type: RECORD_TYPES.TXT,
            data: ['path=/print'],
            ttl: 120,
          },
          {
            name: 'printer.local',
            type: RECORD_TYPES.A,
            data: '192.168.1.44',
            ttl: 120,
          },
        ];
      }
      return [];
    });
    let srvQueries = 0;
    const controller = new AbortController();
    try {
      const mdns = new Mdns();
      try {
        const iter = mdns
          .browse('_http._tcp.local', {
            server: fixture.address,
            timeoutMs: 500,
            settleMs: 1,
            continuous: true,
            pollMs: 1,
            resolve: true,
            signal: controller.signal,
          })
          [Symbol.asyncIterator]();
        const up = await nextWithTimeout(iter);
        const update = await nextWithTimeout(iter);
        t.equal(up.done, false, 'resolved browse yields initial service');
        t.equal(up.value.type, 'up', 'first resolved event is up');
        t.equal(up.value.service?.port, 8080, 'initial event includes resolved service metadata');
        t.equal(update.done, false, 'resolved browse yields metadata update');
        t.equal(update.value.type, 'update', 'changed resolved metadata produces update');
        t.equal(
          update.value.service?.port,
          8081,
          'update event includes changed resolved metadata',
        );
        controller.abort(new Error('done'));
      } finally {
        await mdns.close();
      }
    } finally {
      controller.abort(new Error('done'));
      fixture.close();
      await fixture.done;
    }
  });
  it('continuous browse ingests unsolicited goodbye packets on its bound socket', async (t) => {
    const fixture = startFixture(() => [
      {
        type: RECORD_TYPES.PTR,
        data: 'Printer._http._tcp.local',
        ttl: 120,
      },
    ]);
    const bindProbe = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(bindProbe, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const bindAddress = sock.getsockname(bindProbe);
    sock.close(bindProbe);
    if (bindAddress.family !== 'ipv4') throw new Error('expected IPv4 bind address');
    const sender = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    const controller = new AbortController();
    try {
      const mdns = new Mdns();
      try {
        const iter = mdns
          .browse('_http._tcp.local', {
            bindAddress,
            server: fixture.address,
            timeoutMs: 500,
            settleMs: 1,
            continuous: true,
            pollMs: 10_000,
            signal: controller.signal,
          })
          [Symbol.asyncIterator]();
        const up = await nextWithTimeout(iter);
        t.equal(up.done, false, 'initial poll yields service');
        t.equal(up.value.type, 'up', 'initial event is up');
        sock.sendto(
          sender,
          buildUnsolicited([
            {
              name: '_http._tcp.local',
              type: RECORD_TYPES.PTR,
              data: 'Printer._http._tcp.local',
              ttl: 0,
            },
          ]),
          bindAddress,
        );
        const down = await nextWithTimeout(iter);
        t.equal(down.done, false, 'unsolicited goodbye yields an event');
        t.equal(down.value.type, 'down', 'unsolicited goodbye produces down');
        controller.abort(new Error('done'));
      } finally {
        await mdns.close();
      }
    } finally {
      controller.abort(new Error('done'));
      sock.close(sender);
      fixture.close();
      await fixture.done;
    }
  });
  it('resolveService combines SRV, TXT, and address records', async (t) => {
    const fixture = startFixture((packet) => {
      const question = parseQuestion(packet);
      if (question.type === RECORD_TYPES.SRV) {
        return [
          {
            type: RECORD_TYPES.SRV,
            data: { priority: 0, weight: 0, port: 8080, target: 'printer.local' },
          },
        ];
      }
      if (question.type === RECORD_TYPES.TXT) {
        return [{ type: RECORD_TYPES.TXT, data: ['Path=/print', 'duplex', 'PATH=ignored'] }];
      }
      return [{ type: RECORD_TYPES.A, data: '192.168.1.44' }];
    });
    try {
      const mdns = new Mdns();
      try {
        const service = await mdns.resolveService('Printer._http._tcp.local', {
          server: fixture.address,
          timeoutMs: 500,
        });
        t.equal(service.target, 'printer.local', 'SRV target is returned');
        t.equal(service.port, 8080, 'SRV port is returned');
        t.deepEqual(service.addresses, ['192.168.1.44'], 'target addresses are resolved');
        t.equal(
          new TextDecoder().decode(service.txt.get('path') as Uint8Array),
          '/print',
          'TXT key is lowercased',
        );
        t.equal(service.txt.get('duplex'), true, 'boolean TXT attribute is preserved');
      } finally {
        await mdns.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
    }
  });
  it('resolveService uses TXT and address records from the SRV response', async (t) => {
    let queries = 0;
    const fixture = startFixture((packet) => {
      queries++;
      const question = parseQuestion(packet);
      t.equal(
        question.type,
        RECORD_TYPES.SRV,
        'complete service response avoids follow-up queries',
      );
      return [
        {
          type: RECORD_TYPES.SRV,
          data: { priority: 0, weight: 0, port: 8080, target: 'printer.local' },
        },
        {
          name: 'Printer._http._tcp.local',
          type: RECORD_TYPES.TXT,
          data: ['Path=/print'],
        },
        {
          name: 'printer.local',
          type: RECORD_TYPES.A,
          data: '192.168.1.44',
        },
      ];
    });
    try {
      const mdns = new Mdns();
      try {
        const service = await mdns.resolveService('Printer._http._tcp.local', {
          server: fixture.address,
          timeoutMs: 500,
        });
        t.equal(service.port, 8080, 'SRV port is returned');
        t.deepEqual(service.addresses, ['192.168.1.44'], 'address from SRV response is used');
        t.equal(
          new TextDecoder().decode(service.txt.get('path') as Uint8Array),
          '/print',
          'TXT from SRV response is used',
        );
        t.equal(queries, 1, 'only one query is sent when the SRV response is complete');
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
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
          txt: { path: '/print', duplex: true },
          addresses: ['192.168.1.44'],
        },
        { address: { family: 'ipv4', ip: '127.0.0.1', port: 0 } },
      );
      try {
        const browser = new Mdns();
        try {
          const service = await browser.resolveService('Printer._http._tcp.local', {
            server: registration.address,
            timeoutMs: 500,
          });
          t.equal(service.port, 8080, 'published SRV record is resolved');
          t.deepEqual(service.addresses, ['192.168.1.44'], 'published address record is resolved');
          t.equal(
            new TextDecoder().decode(service.txt.get('path') as Uint8Array),
            '/print',
            'published TXT data is resolved',
          );
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
  it('publish answers interface-specific address RRsets when an interface is selected', async (t) => {
    const mdns = new Mdns();
    try {
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
          addresses: ['192.168.1.44'],
          addressesByInterface: { 7: ['10.0.0.7'] },
        },
        {
          address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
          interfaceIndex: 7,
        },
      );
      try {
        const browser = new Mdns();
        try {
          const service = await browser.resolveService('Printer._http._tcp.local', {
            server: registration.address,
            timeoutMs: 500,
          });
          t.deepEqual(
            service.addresses,
            ['10.0.0.7'],
            'selected interface receives its interface-specific address RRset',
          );
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
  it('publish rejects a conflicting service name during probing', async (t) => {
    const fixture = startFixture(() => [
      {
        name: 'Printer._http._tcp.local',
        type: RECORD_TYPES.SRV,
        data: { priority: 0, weight: 0, port: 9090, target: 'other.local' },
        ttl: 120,
        cacheFlush: true,
      },
    ]);
    const mdns = new Mdns();
    try {
      await t.rejects(
        () =>
          mdns.publish(
            {
              name: 'Printer',
              serviceType: '_http._tcp.local',
              target: 'printer.local',
              port: 8080,
            },
            {
              address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
              probeAddress: fixture.address,
              probeTimeoutMs: 500,
            },
          ),
        /service name conflict/,
        'conflicting SRV response rejects publication',
      );
    } finally {
      fixture.close();
      await fixture.done;
      await mdns.close();
    }
  });
  it('publish can automatically rename after a probing conflict', async (t) => {
    const fixture = startFixture((packet) => {
      const question = parseQuestion(packet);
      if (question.name === 'Printer._http._tcp.local') {
        return [
          {
            name: 'Printer._http._tcp.local',
            type: RECORD_TYPES.SRV,
            data: { priority: 0, weight: 0, port: 9090, target: 'other.local' },
            ttl: 120,
            cacheFlush: true,
          },
        ];
      }
      return [];
    });
    const mdns = new Mdns();
    try {
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
        },
        {
          address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
          probeAddress: fixture.address,
          probeTimeoutMs: 500,
          conflictResolution: 'rename',
        },
      );
      try {
        t.equal(
          registration.name,
          'Printer (2)._http._tcp.local',
          'registration exposes the automatically renamed instance',
        );
        const browser = new Mdns();
        try {
          const iter = browser
            .browse('_http._tcp.local', { server: registration.address, timeoutMs: 500 })
            [Symbol.asyncIterator]();
          const event = await nextWithTimeout(iter);
          t.equal(event.done, false, 'renamed publisher answers browse');
          t.equal(
            event.value.name,
            'Printer (2)._http._tcp.local',
            'browse sees the renamed service instance',
          );
        } finally {
          await browser.close();
        }
      } finally {
        await registration.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
      await mdns.close();
    }
  });
  it('publish sends the RFC probing sequence before announcing no-conflict service', async (t) => {
    let probes = 0;
    const fixture = startSilentFixture((packet) => {
      const question = parseQuestion(packet);
      if (question.name === 'Printer._http._tcp.local' && question.type === RECORD_TYPES.SRV)
        probes++;
    });
    const mdns = new Mdns();
    try {
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
        },
        {
          address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
          probeAddress: fixture.address,
          probeTimeoutMs: 20,
        },
      );
      try {
        t.equal(probes, 3, 'publisher sends three probes before registering');
      } finally {
        await registration.close();
      }
    } finally {
      fixture.close();
      await fixture.done;
      await mdns.close();
    }
  });
  it('publish suppresses duplicate questions from the same peer briefly', async (t) => {
    const mdns = new Mdns();
    const clientFd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
    sock.setNonblocking(clientFd);
    try {
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
        },
        { address: { family: 'ipv4', ip: '127.0.0.1', port: 0 } },
      );
      try {
        const query = _buildQuery(0, '_http._tcp.local', RECORD_TYPES.PTR);
        sock.sendto(clientFd, query, registration.address);
        sock.sendto(clientFd, query, registration.address);
        await recvWithTimeout(clientFd);
        t.equal(
          await hasPacketWithin(clientFd),
          false,
          'duplicate question does not receive a second response',
        );
      } finally {
        await registration.close();
      }
    } finally {
      sock.close(clientFd);
      await mdns.close();
    }
  });
  it('publish sends an unsolicited announcement when requested', async (t) => {
    const mdns = new Mdns();
    const clientFd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
    sock.setNonblocking(clientFd);
    const clientAddress = sock.getsockname(clientFd);
    if (clientAddress.family !== 'ipv4') throw new Error('expected IPv4 client address');
    try {
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
          txt: { path: '/print' },
          addresses: ['192.168.1.44'],
        },
        {
          address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
          announceAddress: clientAddress,
        },
      );
      try {
        const announcement = _parseResponse(await recvWithTimeout(clientFd));
        const records = [
          ...announcement.answers,
          ...announcement.authorities,
          ...announcement.additionals,
        ];
        t.ok(
          records.some(
            (record) =>
              record.type === RECORD_TYPES.PTR && record.data === 'Printer._http._tcp.local',
          ),
          'announcement includes service PTR',
        );
        t.ok(
          records.some(
            (record) =>
              record.type === RECORD_TYPES.SRV && record.name === 'Printer._http._tcp.local',
          ),
          'announcement includes SRV',
        );
        t.ok(
          records.some(
            (record) =>
              record.type === RECORD_TYPES.TXT && record.name === 'Printer._http._tcp.local',
          ),
          'announcement includes TXT',
        );
        t.ok(
          records.some(
            (record) => record.type === RECORD_TYPES.A && record.name === 'printer.local',
          ),
          'announcement includes address record',
        );
      } finally {
        await registration.close();
      }
    } finally {
      sock.close(clientFd);
      await mdns.close();
    }
  });
  it('publish suppresses answers already present as fresh known answers', async (t) => {
    const mdns = new Mdns();
    const clientFd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
    sock.setNonblocking(clientFd);
    try {
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
        },
        { address: { family: 'ipv4', ip: '127.0.0.1', port: 0 } },
      );
      try {
        const query = buildQueryWithKnownAnswer('_http._tcp.local', RECORD_TYPES.PTR, {
          name: '_http._tcp.local',
          type: RECORD_TYPES.PTR,
          data: 'Printer._http._tcp.local',
          ttl: 4000,
        });
        sock.sendto(clientFd, query, registration.address);
        t.equal(
          await hasPacketWithin(clientFd),
          false,
          'fresh known answer suppresses redundant PTR response',
        );
        sock.sendto(
          clientFd,
          _buildQuery(0, '_http._tcp.local', RECORD_TYPES.PTR),
          registration.address,
        );
        const response = _parseResponse(await recvWithTimeout(clientFd));
        t.ok(
          response.answers.some((record) => record.type === RECORD_TYPES.PTR),
          'responder still answers when known answer is absent',
        );
      } finally {
        await registration.close();
      }
    } finally {
      sock.close(clientFd);
      await mdns.close();
    }
  });
  it('publish aggregates delayed responses for the same peer', async (t) => {
    const mdns = new Mdns();
    const clientFd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
    sock.setNonblocking(clientFd);
    try {
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
          txt: { path: '/print' },
        },
        {
          address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
          responseDelayMs: 20,
        },
      );
      try {
        sock.sendto(
          clientFd,
          _buildQuery(0, 'Printer._http._tcp.local', RECORD_TYPES.SRV),
          registration.address,
        );
        sock.sendto(
          clientFd,
          _buildQuery(0, 'Printer._http._tcp.local', RECORD_TYPES.TXT),
          registration.address,
        );
        const response = _parseResponse(await recvWithTimeout(clientFd));
        const records = [...response.answers, ...response.authorities, ...response.additionals];
        t.ok(
          records.some((record) => record.type === RECORD_TYPES.SRV),
          'aggregated response includes SRV answer',
        );
        t.ok(
          records.some((record) => record.type === RECORD_TYPES.TXT),
          'aggregated response includes TXT answer',
        );
        t.equal(
          await hasPacketWithin(clientFd),
          false,
          'no duplicate delayed response follows the aggregate',
        );
      } finally {
        await registration.close();
      }
    } finally {
      sock.close(clientFd);
      await mdns.close();
    }
  });
  it('publish sends zero-TTL goodbye records to queriers on close', async (t) => {
    const mdns = new Mdns();
    const clientFd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
    sock.setNonblocking(clientFd);
    try {
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
          txt: { path: '/print' },
          addresses: ['192.168.1.44'],
        },
        { address: { family: 'ipv4', ip: '127.0.0.1', port: 0 } },
      );
      try {
        sock.sendto(
          clientFd,
          _buildQuery(0, '_http._tcp.local', RECORD_TYPES.PTR),
          registration.address,
        );
        await recvWithTimeout(clientFd);
        await registration.close();
        const goodbye = _parseResponse(await recvWithTimeout(clientFd));
        const records = [...goodbye.answers, ...goodbye.authorities, ...goodbye.additionals];
        t.ok(
          records.some(
            (record) =>
              record.type === RECORD_TYPES.PTR &&
              record.ttl === 0 &&
              record.data === 'Printer._http._tcp.local',
          ),
          'goodbye includes zero-TTL PTR record',
        );
        t.ok(
          records.some((record) => record.type === RECORD_TYPES.SRV && record.ttl === 0),
          'goodbye includes zero-TTL SRV record',
        );
        t.ok(
          records.some((record) => record.type === RECORD_TYPES.TXT && record.ttl === 0),
          'goodbye includes zero-TTL TXT record',
        );
        t.ok(
          records.some((record) => record.type === RECORD_TYPES.A && record.ttl === 0),
          'goodbye includes zero-TTL address record',
        );
      } finally {
        await registration.close();
      }
    } finally {
      sock.close(clientFd);
      await mdns.close();
    }
  });
  it('publish sends zero-TTL goodbye records to the configured goodbye address', async (t) => {
    const mdns = new Mdns();
    const clientFd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
    sock.bind(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
    sock.setNonblocking(clientFd);
    const goodbyeAddress = sock.getsockname(clientFd);
    if (goodbyeAddress.family !== 'ipv4') throw new Error('expected IPv4 goodbye address');
    try {
      const registration = await mdns.publish(
        {
          name: 'Printer',
          serviceType: '_http._tcp.local',
          target: 'printer.local',
          port: 8080,
          txt: { path: '/print' },
          addresses: ['192.168.1.44'],
        },
        {
          address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
          goodbyeAddress,
        },
      );
      await registration.close();
      const goodbye = _parseResponse(await recvWithTimeout(clientFd));
      const records = [...goodbye.answers, ...goodbye.authorities, ...goodbye.additionals];
      t.ok(
        records.some(
          (record) =>
            record.type === RECORD_TYPES.PTR &&
            record.ttl === 0 &&
            record.data === 'Printer._http._tcp.local',
        ),
        'configured goodbye includes zero-TTL PTR',
      );
      t.ok(
        records.some((record) => record.type === RECORD_TYPES.SRV && record.ttl === 0),
        'configured goodbye includes zero-TTL SRV',
      );
    } finally {
      sock.close(clientFd);
      await mdns.close();
    }
  });
});
