/**
 * Benchmarks for fino:net/dns (packet encoding/decoding only — no network)
 *
 * Run with: cargo run -- --bench benchmarks/dns.bench.mts
 *
 * Uses only the internal exports (_encodeName, _buildQuery, _parseResponse)
 * to avoid network I/O. A synthetic DNS A-record response is constructed for
 * the parsing benchmarks.
 */

import { _encodeName, _buildQuery, _parseResponse, RECORD_TYPES } from 'fino:net/dns';
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
  });

  b.group('by name length', (g) => {
    g.measure('short name',  () => _parseResponse(A_RESPONSE_SHORT));
    g.measure('long name',   () => _parseResponse(A_RESPONSE_LONG));
  });
});
