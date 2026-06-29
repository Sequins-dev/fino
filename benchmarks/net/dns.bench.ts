/**
 * Benchmarks for fino:net/dns (packet encoding/decoding only — no network)
 *
 * Run with: cargo run -- --bench benchmarks/dns.bench.ts
 *
 * Uses only the internal exports (_encodeName, _buildQuery, _parseResponse)
 * to avoid network I/O. A synthetic DNS A-record response is constructed for
 * the parsing benchmarks.
 */

import { _encodeName, _buildQuery, _parseResponse, RECORD_TYPES } from 'fino:net/dns';
import { validateSignedResponse } from '../../js/internal/net/dnssec.ts';
import { bench } from 'fino:bench';

// ---------------------------------------------------------------------------
// Build a synthetic valid DNS A-record response for parsing benchmarks.
// Format: header(12) + question section + answer section
// ---------------------------------------------------------------------------

function buildAResponse(name: string, ip: string): Uint8Array {
  const nameWire = _encodeName(name);
  // Question: QNAME + QTYPE(2) + QCLASS(2)
  const questionLen = nameWire.length + 4;
  // Answer: compressed ptr(2) + TYPE(2) + CLASS(2) + TTL(4) + RDLEN(2) + A(4)
  const answerLen = 2 + 2 + 2 + 4 + 2 + 4;
  const total = 12 + questionLen + answerLen;

  const buf  = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // Header
  view.setUint16(0, 0x1234, false);  // ID
  view.setUint16(2, 0x8180, false);  // QR=1, OPCODE=0, AA=0, TC=0, RD=1, RA=1
  view.setUint16(4, 1, false);       // QDCOUNT = 1
  view.setUint16(6, 1, false);       // ANCOUNT = 1
  view.setUint16(8, 0, false);       // NSCOUNT = 0
  view.setUint16(10, 0, false);      // ARCOUNT = 0

  // Question section
  buf.set(nameWire, 12);
  view.setUint16(12 + nameWire.length, RECORD_TYPES.A, false);  // QTYPE
  view.setUint16(12 + nameWire.length + 2, 1, false);           // QCLASS (IN)

  // Answer section
  const ansOff = 12 + questionLen;
  view.setUint16(ansOff, 0xC00C, false);              // compressed name pointer to offset 12
  view.setUint16(ansOff + 2, RECORD_TYPES.A, false);  // TYPE A
  view.setUint16(ansOff + 4, 1, false);               // CLASS IN
  view.setUint32(ansOff + 6, 300, false);             // TTL = 300
  view.setUint16(ansOff + 10, 4, false);              // RDLENGTH = 4

  const parts = ip.split('.').map(Number);
  buf[ansOff + 12] = parts[0]!;
  buf[ansOff + 13] = parts[1]!;
  buf[ansOff + 14] = parts[2]!;
  buf[ansOff + 15] = parts[3]!;

  return buf;
}

function buildAAAAResponse(name: string): Uint8Array {
  const nameWire = _encodeName(name);
  const questionLen = nameWire.length + 4;
  const answerLen = 2 + 2 + 2 + 4 + 2 + 16; // AAAA rdata = 16 bytes
  const total = 12 + questionLen + answerLen;

  const buf  = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  view.setUint16(0, 0x5678, false);
  view.setUint16(2, 0x8180, false);
  view.setUint16(4, 1, false);
  view.setUint16(6, 1, false);

  buf.set(nameWire, 12);
  view.setUint16(12 + nameWire.length, RECORD_TYPES.AAAA, false);
  view.setUint16(12 + nameWire.length + 2, 1, false);

  const ansOff = 12 + questionLen;
  view.setUint16(ansOff, 0xC00C, false);
  view.setUint16(ansOff + 2, RECORD_TYPES.AAAA, false);
  view.setUint16(ansOff + 4, 1, false);
  view.setUint32(ansOff + 6, 300, false);
  view.setUint16(ansOff + 10, 16, false);
  // IPv6 ::1 (loopback)
  buf[ansOff + 27] = 1;

  return buf;
}

const A_RESPONSE_SHORT  = buildAResponse('example.com', '93.184.216.34');
const A_RESPONSE_LONG   = buildAResponse('api.v2.internal.svc.cluster.example.com', '10.0.1.1');
const AAAA_RESPONSE     = buildAAAAResponse('example.com');

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

function buildDnssecResponse(name: string): Uint8Array {
  const nameWire = _encodeName(name);
  const questionLen = nameWire.length + 4;
  const ds = concatBytes([writeU16(20326), new Uint8Array([8, 2]), new Uint8Array(32).fill(0xaa)]);
  const dnskey = concatBytes([writeU16(257), new Uint8Array([3, 8, 1, 0, 1, 3, 1, 0, 1])]);
  const rrsig = concatBytes([
    writeU16(RECORD_TYPES.A),
    new Uint8Array([8, 2]),
    writeU32(300),
    writeU32(4_102_444_800),
    writeU32(4_099_852_800),
    writeU16(20326),
    nameWire,
    new Uint8Array(256).fill(0xbb),
  ]);
  const rdatas = [
    { type: RECORD_TYPES.DS, data: ds },
    { type: RECORD_TYPES.DNSKEY, data: dnskey },
    { type: RECORD_TYPES.RRSIG, data: rrsig },
  ];
  let rrLen = 0;
  for (const rdata of rdatas) rrLen += 2 + 2 + 2 + 4 + 2 + rdata.data.byteLength;
  const buf = new Uint8Array(12 + questionLen + rrLen + 11);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 0x8888, false);
  view.setUint16(2, 0x8180, false);
  view.setUint16(4, 1, false);
  view.setUint16(6, rdatas.length, false);
  view.setUint16(10, 1, false);
  let off = 12;
  buf.set(nameWire, off); off += nameWire.length;
  view.setUint16(off, RECORD_TYPES.A, false); off += 2;
  view.setUint16(off, 1, false); off += 2;
  for (const record of rdatas) {
    buf[off++] = 0xc0; buf[off++] = 0x0c;
    view.setUint16(off, record.type, false); off += 2;
    view.setUint16(off, 1, false); off += 2;
    view.setUint32(off, 300, false); off += 4;
    view.setUint16(off, record.data.byteLength, false); off += 2;
    buf.set(record.data, off); off += record.data.byteLength;
  }
  buf[off++] = 0;
  view.setUint16(off, 41, false); off += 2;
  view.setUint16(off, 1232, false); off += 2;
  off += 2;
  view.setUint16(off, 0x8000, false); off += 2;
  view.setUint16(off, 0, false);
  return buf;
}

const DNSSEC_RESPONSE = buildDnssecResponse('example.com');
const MALFORMED_TRUNCATED_RESPONSE = A_RESPONSE_SHORT.subarray(0, A_RESPONSE_SHORT.byteLength - 3);
const DNSSEC_VALIDATION_CORPUS = {
  rcode: 0,
  answers: [{
    name: 'unsigned.test',
    type: RECORD_TYPES.A,
    ttl: 60,
    data: '192.0.2.1',
    rawData: new Uint8Array([192, 0, 2, 1]),
  }],
  authorities: [],
};

bench('_encodeName', (b) => {
  b.measure('2-label short',   () => _encodeName('example.com'));
  b.measure('2-label long',    () => _encodeName('subdomain.example.com'));
  b.measure('5-label',         () => _encodeName('api.v2.internal.svc.example.com'));
  b.measure('trailing dot',    () => _encodeName('example.com.'));
  b.measure('single label',    () => _encodeName('localhost'));
});

bench('_buildQuery', (b) => {
  b.group('by record type', (g) => {
    g.measure('A',     () => _buildQuery(0x1234, 'example.com', RECORD_TYPES.A));
    g.measure('AAAA',  () => _buildQuery(0x1234, 'example.com', RECORD_TYPES.AAAA));
    g.measure('MX',    () => _buildQuery(0x1234, 'example.com', RECORD_TYPES.MX));
    g.measure('TXT',   () => _buildQuery(0x1234, 'example.com', RECORD_TYPES.TXT));
    g.measure('SRV',   () => _buildQuery(0x1234, '_http._tcp.example.com', RECORD_TYPES.SRV));
    g.measure('A + DNSSEC DO', () => _buildQuery(0x1234, 'example.com', RECORD_TYPES.A, { dnssec: true }));
  });

  b.group('by name length', (g) => {
    g.measure('short name',    () => _buildQuery(0x1234, 'a.co', RECORD_TYPES.A));
    g.measure('medium name',   () => _buildQuery(0x1234, 'example.com', RECORD_TYPES.A));
    g.measure('long name',     () => _buildQuery(0x1234, 'api.v2.internal.svc.cluster.example.com', RECORD_TYPES.A));
  });
});

bench('_parseResponse', (b) => {
  b.group('by record type', (g) => {
    g.measure('A record',    () => _parseResponse(A_RESPONSE_SHORT));
    g.measure('AAAA record', () => _parseResponse(AAAA_RESPONSE));
    g.measure('DNSSEC records + OPT', () => _parseResponse(DNSSEC_RESPONSE));
  });

  b.group('by name length', (g) => {
    g.measure('short name',  () => _parseResponse(A_RESPONSE_SHORT));
    g.measure('long name',   () => _parseResponse(A_RESPONSE_LONG));
  });

  b.group('failure paths', (g) => {
    g.measure('malformed truncated response rejects', () => {
      try {
        _parseResponse(MALFORMED_TRUNCATED_RESPONSE);
        throw new Error('malformed truncated response unexpectedly parsed');
      } catch (err) {
        if (String((err as Error).message ?? err).includes('unexpectedly parsed')) throw err;
      }
    });

    g.measure('DNSSEC validation corpus missing signature rejects', async () => {
      try {
        await validateSignedResponse(DNSSEC_VALIDATION_CORPUS as any, 'unsigned.test', RECORD_TYPES.A, {
          trustAnchors: [],
          now: 2_000,
        });
        throw new Error('DNSSEC validation corpus unexpectedly accepted unsigned answer');
      } catch (err) {
        if (String((err as Error).message ?? err).includes('unexpectedly accepted')) throw err;
      }
    });
  });
});
