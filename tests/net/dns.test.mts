/**
 * Tests for fino:dns — Resolver, lookup, wire protocol helpers.
 */

import { describe, it, before, after } from 'fino:test/test';
import {
  Resolver, lookup, RECORD_TYPES,
  _encodeName, _buildQuery, _decodeName, _parseResponse, _reverseIP,
} from 'fino:net/dns';
import { dlopen } from 'fino:ffi';
import { os } from 'fino:process';
import * as sock from 'fino:net/socket';
import * as loop from 'internal:runtime/loop';
import { Socket } from 'fino:net/socket';

type DnsErrorLike = { message?: string; code?: string };
const libc = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const nativeSocket = dlopen(libc, {
  bind: { parameters: ['i32', 'buffer', 'u32'], result: 'i32' },
});

function bindIpv4Native(fd: number, ip: string, port: number): void {
  if (ip !== '127.0.0.1') throw new Error(`unsupported fixture bind IP: ${ip}`);
  const sockaddr = new Uint8Array(16);
  const dv = new DataView(sockaddr.buffer);
  if (os === 'darwin') {
    dv.setUint8(0, 16);
    dv.setUint8(1, sock.AF_INET);
  } else {
    dv.setUint16(0, sock.AF_INET, true);
  }
  dv.setUint16(2, port, false);
  dv.setUint32(4, 0x7f000001, false);
  const rc = nativeSocket.symbols.bind(fd, sockaddr, 16) as number;
  if (rc < 0) throw new Error('native bind failed');
}

type LocalDnsRecord = {
  type: number;
  ttl?: number;
  data: string | string[] | { exchange: string; priority: number };
};

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function writeU16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function writeU32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function ipv4Bytes(ip: string): Uint8Array {
  return new Uint8Array(ip.split('.').map((part) => Number(part)));
}

function ipv6Bytes(ip: string): Uint8Array {
  if (ip !== '2001:db8::42') throw new Error(`unsupported fixture IPv6: ${ip}`);
  return new Uint8Array([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x42]);
}

function txtBytes(parts: string[]): Uint8Array {
  const encoder = new TextEncoder();
  return concatBytes(parts.map((part) => {
    const encoded = encoder.encode(part);
    return concatBytes([new Uint8Array([encoded.byteLength]), encoded]);
  }));
}

function recordRdata(record: LocalDnsRecord): Uint8Array {
  if (record.type === RECORD_TYPES.A) return ipv4Bytes(record.data as string);
  if (record.type === RECORD_TYPES.AAAA) return ipv6Bytes(record.data as string);
  if (record.type === RECORD_TYPES.NS || record.type === RECORD_TYPES.PTR || record.type === RECORD_TYPES.CNAME) {
    return _encodeName(record.data as string);
  }
  if (record.type === RECORD_TYPES.TXT) return txtBytes(record.data as string[]);
  if (record.type === RECORD_TYPES.MX) {
    const mx = record.data as { exchange: string; priority: number };
    return concatBytes([writeU16(mx.priority), _encodeName(mx.exchange)]);
  }
  throw new Error(`unsupported fixture record type ${record.type}`);
}

function buildDnsResponse(query: Uint8Array, records: LocalDnsRecord[], opts: { rcode?: number; truncated?: boolean } = {}): Uint8Array {
  const { nextOffset } = _decodeName(query, 12);
  const questionEnd = nextOffset + 4;
  const question = query.slice(12, questionEnd);
  const out: number[] = [];
  const push16 = (value: number) => { out.push((value >> 8) & 0xff, value & 0xff); };
  const push32 = (value: number) => { out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff); };
  const queryView = new DataView(query.buffer, query.byteOffset, query.byteLength);
  push16(queryView.getUint16(0, false));
  push16(0x8180 | (opts.truncated ? 0x0200 : 0) | (opts.rcode ?? 0));
  push16(1);
  push16(opts.rcode ? 0 : records.length);
  push16(0);
  push16(0);
  out.push(...question);
  if (!opts.rcode) {
    for (const record of records) {
      const rdata = recordRdata(record);
      out.push(0xc0, 0x0c);
      push16(record.type);
      push16(1);
      push32(record.ttl ?? 60);
      push16(rdata.byteLength);
      out.push(...rdata);
    }
  }
  return new Uint8Array(out);
}

function parseQuestion(query: Uint8Array): { name: string; type: number } {
  const decoded = _decodeName(query, 12);
  const view = new DataView(query.buffer, query.byteOffset, query.byteLength);
  return { name: decoded.name, type: view.getUint16(decoded.nextOffset, false) };
}

class LocalDnsServer {
  #udpFd = -1;
  #tcpServer: ReturnType<typeof Socket.listen> | null = null;
  #closed = false;
  #records = new Map<string, LocalDnsRecord[]>();
  #truncateOnceFor = new Set<string>();
  readonly port: number;

  constructor(records: Record<string, LocalDnsRecord[]>, truncateOnceFor: string[] = []) {
    for (const [key, value] of Object.entries(records)) this.#records.set(key, value);
    for (const key of truncateOnceFor) this.#truncateOnceFor.add(key);

    let boundPort = 0;
    let lastError: unknown = null;
    for (let i = 0; i < 20; i++) {
      const port = 20_000 + Math.floor(Math.random() * 20_000);
      const udpFd = sock.socket(sock.AF_INET, sock.SOCK_DGRAM, 0);
      try {
        bindIpv4Native(udpFd, '127.0.0.1', port);
        const tcpServer = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port });
        this.#udpFd = udpFd;
        this.#tcpServer = tcpServer;
        boundPort = port;
        break;
      } catch (err) {
        lastError = err;
        sock.close(udpFd);
      }
    }
    if (boundPort === 0) throw lastError instanceof Error ? lastError : new Error('failed to bind local DNS fixture');
    sock.setNonblocking(this.#udpFd);
    this.port = boundPort;
    this.#serveUdp();
    this.#serveTcp();
  }

  address(): string {
    return `127.0.0.1:${this.port}`;
  }

  close(): void {
    this.#closed = true;
    if (this.#udpFd >= 0) {
      loop.removeRead(this.#udpFd);
      sock.close(this.#udpFd);
    }
    this.#tcpServer?.close();
    this.#udpFd = -1;
    this.#tcpServer = null;
  }

  async #serveUdp(): Promise<void> {
    try {
      while (!this.#closed) {
        await loop.readable(this.#udpFd);
        if (this.#closed) return;
        const recv = sock.recvfrom(this.#udpFd, 4096);
        if (typeof recv === 'number') continue;
        const response = this.#responseFor(recv.data, true);
        sock.sendto(this.#udpFd, response, recv.addr as sock.Address);
      }
    } catch (_) {
      if (!this.#closed) throw _;
    }
  }

  async #serveTcp(): Promise<void> {
    const server = this.#tcpServer!;
    try {
      while (!this.#closed) {
        const conn = await server.accept();
        if (conn === null) return;
        this.#handleTcp(conn);
      }
    } catch (_) {
      if (!this.#closed) throw _;
    }
  }

  async #handleTcp(conn: Socket): Promise<void> {
    const [reader, writer] = conn.split();
    try {
      const lenBytes = await reader.readExactly(2);
      if (!lenBytes) return;
      const len = new DataView(lenBytes.buffer, lenBytes.byteOffset, lenBytes.byteLength).getUint16(0, false);
      const query = await reader.readExactly(len);
      if (!query) return;
      const response = this.#responseFor(query, false);
      const framed = new Uint8Array(2 + response.byteLength);
      new DataView(framed.buffer).setUint16(0, response.byteLength, false);
      framed.set(response, 2);
      await writer.write(framed);
    } finally {
      await writer.close();
      await reader.close();
    }
  }

  #responseFor(query: Uint8Array, udp: boolean): Uint8Array {
    const question = parseQuestion(query);
    const key = `${question.name}:${question.type}`;
    const records = this.#records.get(key);
    if (!records) return buildDnsResponse(query, [], { rcode: 3 });
    if (udp && this.#truncateOnceFor.delete(key)) return buildDnsResponse(query, [], { truncated: true });
    return buildDnsResponse(query, records);
  }
}

describe('Wire protocol', () => {
  it('_encodeName — multi-label', (t) => {
    const out = _encodeName('example.com');
    t.equal(out[0], 7, 'first label length = 7');
    t.equal(out[8], 3, 'second label length = 3');
    t.equal(out[12], 0, 'root label');
    t.equal(out.length, 13, 'total length');
  });

  it('_encodeName — single label', (t) => {
    const out = _encodeName('localhost');
    t.equal(out[0], 9, 'label length = 9');
    t.equal(out[10], 0, 'root label');
    t.equal(out.length, 11, 'total length');
  });

  it('_encodeName — strips trailing dot', (t) => {
    const a = _encodeName('example.com');
    const b = _encodeName('example.com.');
    t.equal(a.length, b.length, 'same length with/without trailing dot');
    for (let i = 0; i < a.length; i++) {
      t.equal(a[i], b[i], `byte ${i} matches`);
    }
  });

  it('_buildQuery — header fields', (t) => {
    const pkt  = _buildQuery(0x1234, 'example.com', RECORD_TYPES.A);
    const view = new DataView(pkt.buffer);
    t.equal(view.getUint16(0, false), 0x1234, 'ID');
    t.equal(view.getUint16(2, false), 0x0100, 'flags (RD=1)');
    t.equal(view.getUint16(4, false), 1,      'QDCOUNT = 1');
    t.equal(view.getUint16(6, false), 0,      'ANCOUNT = 0');
    t.equal(view.getUint16(8, false), 0,      'NSCOUNT = 0');
    t.equal(view.getUint16(10, false), 0,     'ARCOUNT = 0');
  });

  it('_buildQuery — question section QTYPE and QCLASS', (t) => {
    const pkt       = _buildQuery(1, 'example.com', RECORD_TYPES.A);
    const nameBytes = _encodeName('example.com');
    const view      = new DataView(pkt.buffer);
    const qtypeOff  = 12 + nameBytes.length;
    t.equal(view.getUint16(qtypeOff,     false), RECORD_TYPES.A, 'QTYPE = A');
    t.equal(view.getUint16(qtypeOff + 2, false), 1,              'QCLASS = IN');
  });

  it('_decodeName — simple name (no compression)', (t) => {
    const encoded = _encodeName('foo.bar');
    const { name, nextOffset } = _decodeName(encoded, 0);
    t.equal(name, 'foo.bar', 'decoded name');
    t.equal(nextOffset, encoded.length, 'nextOffset at end');
  });

  it('_decodeName — compression pointer', (t) => {
    const encoded = _encodeName('example.com');
    const msg     = new Uint8Array(12 + encoded.length + 2);
    msg.set(encoded, 12);
    msg[12 + encoded.length]     = 0xC0;
    msg[12 + encoded.length + 1] = 0x0C;
    const { name } = _decodeName(msg, 12 + encoded.length);
    t.equal(name, 'example.com', 'pointer resolves to correct name');
  });

  it('_decodeName — rejects truncated compression pointers', (t) => {
    t.throws(() => _decodeName(new Uint8Array([0xC0]), 0), /truncated compression pointer/i);
  });

  it('_decodeName — rejects compression pointer loops', (t) => {
    const msg = new Uint8Array([0xC0, 0x00]);
    t.throws(() => _decodeName(msg, 0), /pointer loop/i);
  });

  it('_parseResponse — synthetic A record response', (t) => {
    const qname    = _encodeName('example.com');
    const totalLen = 12 + qname.length + 4 +
                     qname.length + 4 + 2 + 4 + 2 + 4;
    const msg  = new Uint8Array(totalLen);
    const view = new DataView(msg.buffer);
    view.setUint16(0,  0xABCD, false);
    view.setUint16(2,  0x8180, false);
    view.setUint16(4,  1,      false);
    view.setUint16(6,  1,      false);
    let off = 12;
    msg.set(qname, off); off += qname.length;
    view.setUint16(off, RECORD_TYPES.A, false); off += 2;
    view.setUint16(off, 1, false); off += 2;
    msg.set(qname, off); off += qname.length;
    view.setUint16(off, RECORD_TYPES.A, false); off += 2;
    view.setUint16(off, 1,              false); off += 2;
    view.setUint32(off, 300,            false); off += 4;
    view.setUint16(off, 4,              false); off += 2;
    msg[off] = 93; msg[off + 1] = 184; msg[off + 2] = 216; msg[off + 3] = 34;
    const parsed = _parseResponse(msg);
    t.equal(parsed.id, 0xABCD, 'ID matches');
    t.equal(parsed.rcode, 0, 'RCODE = 0');
    t.equal(parsed.answers.length, 1, 'one answer');
    t.equal(parsed.answers[0]!.data, '93.184.216.34', 'A record data');
    t.equal(parsed.answers[0]!.ttl,  300, 'TTL');
  });

  it('_parseResponse — rejects truncated packets', (t) => {
    t.throws(() => _parseResponse(new Uint8Array([0, 1, 2])), /response too short/i);
  });

  it('_parseResponse — rejects truncated resource records', (t) => {
    const qname = _encodeName('example.com');
    const msg = new Uint8Array(12 + qname.length + 4 + 2);
    const view = new DataView(msg.buffer);
    view.setUint16(0, 0xABCD, false);
    view.setUint16(2, 0x8180, false);
    view.setUint16(4, 1, false);
    view.setUint16(6, 1, false);
    let off = 12;
    msg.set(qname, off); off += qname.length;
    view.setUint16(off, RECORD_TYPES.A, false); off += 2;
    view.setUint16(off, 1, false); off += 2;
    msg[off] = 0xC0;
    msg[off + 1] = 0x0C;
    t.throws(() => _parseResponse(msg), /resource record/i);
  });

  it('_reverseIP — IPv4', (t) => {
    t.equal(_reverseIP('1.2.3.4'), '4.3.2.1.in-addr.arpa', 'IPv4 reverse');
    t.equal(_reverseIP('8.8.8.8'), '8.8.8.8.in-addr.arpa', 'Google DNS reverse name');
  });

  it('_reverseIP — IPv6', (t) => {
    const result = _reverseIP('2001:db8::1');
    t.ok(result.endsWith('.ip6.arpa'), 'ends with .ip6.arpa');
    t.ok(result.startsWith('1.'), 'first nibble is trailing 1');
  });
});

describe('Integration', () => {
  let dns: LocalDnsServer;

  before(() => {
    dns = new LocalDnsServer({
      [`example.test:${RECORD_TYPES.A}`]: [{ type: RECORD_TYPES.A, data: '127.0.0.42' }],
      [`ipv6.example.test:${RECORD_TYPES.AAAA}`]: [{ type: RECORD_TYPES.AAAA, data: '2001:db8::42' }],
      [`example.test:${RECORD_TYPES.MX}`]: [{ type: RECORD_TYPES.MX, data: { exchange: 'mail.example.test', priority: 10 } }],
      [`example.test:${RECORD_TYPES.NS}`]: [{ type: RECORD_TYPES.NS, data: 'ns1.example.test' }],
      [`example.test:${RECORD_TYPES.TXT}`]: [{ type: RECORD_TYPES.TXT, data: ['v=spf1', 'include:example.test'] }],
      [`42.0.0.127.in-addr.arpa:${RECORD_TYPES.PTR}`]: [{ type: RECORD_TYPES.PTR, data: 'ptr.example.test' }],
      [`large.example.test:${RECORD_TYPES.A}`]: [{ type: RECORD_TYPES.A, data: '127.0.0.99' }],
    }, [`large.example.test:${RECORD_TYPES.A}`]);
  });

  after(() => {
    dns.close();
  });

  function localResolver(): Resolver {
    const resolver = new Resolver({ timeout: 500, retries: 0 });
    resolver.setServers([dns.address()]);
    return resolver;
  }

  it('resolver.resolve4 — local fixture', async (t) => {
    const addrs = await localResolver().resolve4('example.test');
    t.ok(Array.isArray(addrs) && addrs.length > 0, 'got at least one A record');
    t.ok(addrs.every(a => typeof a === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(a)), 'all are IPv4 strings');
    t.equal(addrs[0], '127.0.0.42', 'resolved fixture address');
  });

  it('resolver.resolve6 — local fixture', async (t) => {
    const addrs = await localResolver().resolve6('ipv6.example.test');
    t.ok(Array.isArray(addrs) && addrs.length > 0, 'got at least one AAAA record');
    t.ok(addrs.every(a => typeof a === 'string' && a.includes(':')), 'all contain colons (IPv6)');
    t.equal(addrs[0], '2001:db8::42', 'resolved fixture IPv6 address');
  });

  it('resolver.resolveMx — local fixture', async (t) => {
    const records = await localResolver().resolveMx('example.test');
    const first = records[0] as { exchange?: string; priority?: number } | undefined;
    t.ok(Array.isArray(records) && records.length > 0, 'got MX records');
    t.equal(first?.exchange, 'mail.example.test', 'has exchange field');
    t.equal(first?.priority, 10, 'has priority field');
  });

  it('resolver.resolveNs — local fixture', async (t) => {
    const ns = await localResolver().resolveNs('example.test');
    t.ok(Array.isArray(ns) && ns.length > 0, 'got NS records');
    t.deepEqual(ns, ['ns1.example.test'], 'all are domain strings');
  });

  it('resolver.resolveTxt — local fixture', async (t) => {
    const txt = await localResolver().resolveTxt('example.test');
    t.ok(Array.isArray(txt), 'TXT result is an array');
    t.deepEqual(txt, [['v=spf1', 'include:example.test']], 'TXT chunks are preserved');
  });

  it('resolver — NXDOMAIN throws with err.code === ENOTFOUND', async (t) => {
    let caughtErr: unknown;
    try {
      await localResolver().resolve4('missing.example.test');
      t.fail('expected NXDOMAIN to throw');
    } catch (err) {
      caughtErr = err;
    }
    t.ok(caughtErr instanceof Error, 'NXDOMAIN throws an Error instance');
    const e = caughtErr as { code?: string; message?: string };
    t.equal(e.code, 'ENOTFOUND', 'err.code is exactly "ENOTFOUND" (not just in the message)');
    t.ok(
      (e.message ?? '').length > 0,
      'error message is non-empty: ' + e.message,
    );
  });

  it('resolver.setServers — overrides servers and resolves', async (t) => {
    const resolver = new Resolver();
    resolver.setServers([dns.address()]);
    t.deepEqual(resolver.getServers(), [dns.address()], 'getServers returns overridden servers');
    const addrs = await resolver.resolve4('example.test');
    t.ok(Array.isArray(addrs) && addrs.length > 0, 'still resolves with custom server');
  });

  it('resolver.reverse — local fixture', async (t) => {
    const names = await localResolver().reverse('127.0.0.42');
    t.ok(Array.isArray(names) && names.length > 0, 'got PTR records');
    t.deepEqual(names, ['ptr.example.test'], 'got fixture PTR record');
  });

  it('resolver falls back to TCP when UDP response is truncated', async (t) => {
    const addrs = await localResolver().resolve4('large.example.test');
    t.deepEqual(addrs, ['127.0.0.99'], 'TCP fallback returns full answer');
  });

  it('lookup — example.com family 4', async (t) => {
    const result = await lookup('example.com');
    t.ok(typeof result.address === 'string', 'has address');
    t.equal(result.family, 4, 'family = 4');
    t.ok(/^\d+\.\d+\.\d+\.\d+$/.test(result.address), 'address is IPv4');
  });

  it('lookup — IPv6 literal family 6', async (t) => {
    const result = await lookup('2001:4860:4860::8888', { family: 6 });
    t.ok(typeof result.address === 'string', 'has address');
    t.equal(result.family, 6, 'family = 6');
    t.ok(result.address.includes(':'), 'address is IPv6');
  });

  it('resolver — timeout with unreachable server', async (t) => {
    // Bind a local UDP socket that receives queries but never responds.
    // Using 192.0.2.1:53 fails on macOS where mDNSResponder intercepts all
    // port-53 traffic and returns real DNS answers.
    const libc = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
    const ffi = dlopen(libc, {
      socket:      { parameters: ['i32', 'i32', 'i32'], result: 'i32' },
      bind:        { parameters: ['i32', 'buffer', 'u32'], result: 'i32' },
      close:       { parameters: ['i32'], result: 'i32' },
      getsockname: { parameters: ['i32', 'buffer', 'buffer'], result: 'i32' },
    });
    const AF_INET = 2, SOCK_DGRAM = 2;
    const sinkFd = ffi.symbols.socket(AF_INET, SOCK_DGRAM, 0) as number;
    t.ok(sinkFd >= 0, 'sink socket created');

    const sockaddr = new Uint8Array(16);
    const dv = new DataView(sockaddr.buffer);
    dv.setUint8(0, 16); dv.setUint8(1, AF_INET);
    dv.setUint16(2, 0, false); dv.setUint32(4, 0x7f000001, false);
    ffi.symbols.bind(sinkFd, sockaddr, 16);

    const addrOut = new Uint8Array(16);
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, 16, true);
    ffi.symbols.getsockname(sinkFd, addrOut, lenBuf);
    const port = new DataView(addrOut.buffer).getUint16(2, false);

    const resolver = new Resolver({ timeout: 300, retries: 0 });
    resolver.setServers([`127.0.0.1:${port}`]);

    try {
      await t.rejects(
        () => resolver.resolve4('example.com'),
        (err) => {
          const e = err as DnsErrorLike;
          return /timeout|ETIMEOUT/i.test((e.message ?? '') + ' ' + (e.code ?? ''));
        },
        'throws timeout error for unreachable server',
      );
    } finally {
      ffi.symbols.close(sinkFd);
    }
  });
});
