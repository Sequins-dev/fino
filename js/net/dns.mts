/**
 * fino:dns — async DNS resolution via the RFC 1035 wire protocol over UDP.
 *
 * This module implements DNS resolution entirely in JS by speaking the DNS
 * wire protocol directly over UDP sockets (from `fino:socket`). It reads
 * nameservers from `/etc/resolv.conf` via `fino:file`. No blocking libc
 * calls are made — the entire resolution path is async and event-loop driven.
 *
 *
 * ## Why not use libc getaddrinfo?
 *
 * `getaddrinfo(3)` is the standard libc function for DNS resolution, but it
 * blocks the calling thread. Calling it from Fino would freeze the entire
 * event loop for the duration of the DNS query — potentially hundreds of
 * milliseconds. Using raw UDP lets us await the response asynchronously via
 * `loop.readable()`, keeping the process responsive to other I/O while the
 * query is in flight.
 *
 *
 * ## DNS wire protocol overview (RFC 1035)
 *
 * A DNS query packet is:
 *
 *   Header (12 bytes, big-endian):
 *     [0-1]  ID      — 16-bit transaction ID (random per query)
 *     [2-3]  Flags   — 0x0100 = standard query with recursion desired
 *     [4-5]  QDCOUNT — number of questions (always 1)
 *     [6-7]  ANCOUNT — answer count (0 in queries)
 *     [8-9]  NSCOUNT — authority count (0 in queries)
 *     [10-11] ARCOUNT — additional count (0 in queries)
 *
 *   Question section:
 *     QNAME   — domain name in wire format (length-prefixed labels, null-terminated)
 *     QTYPE   — record type (A=1, AAAA=28, MX=15, etc.)
 *     QCLASS  — always IN=1 (Internet)
 *
 * Wire-format domain names encode each label (dot-separated part) as a length
 * byte followed by the label's bytes. "example.com" becomes:
 *   [7] 'e','x','a','m','p','l','e'  [3] 'c','o','m'  [0]
 *
 * DNS responses use **compression pointers** to avoid repeating domain names:
 * a two-byte sequence starting with bits 11xxxxxx is a pointer to an earlier
 * offset in the message. `_decodeName()` follows these pointers recursively,
 * with a hop limit to prevent infinite loops from malformed responses.
 *
 *
 * ## Resource record parsing
 *
 * Each answer/authority/additional record is:
 *   NAME    — domain name (may use compression)
 *   TYPE    — u16 big-endian
 *   CLASS   — u16 big-endian (always 1)
 *   TTL     — u32 big-endian (seconds)
 *   RDLENGTH— u16 big-endian (length of RDATA)
 *   RDATA   — variable; format depends on TYPE
 *
 * `parseResourceRecord()` handles A, AAAA, CNAME, NS, PTR, MX, TXT, SOA, and
 * SRV. Unknown types return raw bytes.
 *
 *
 * ## CNAME chain following
 *
 * For A and AAAA queries, `resolve()` follows CNAME chains automatically (up
 * to 10 hops) by re-querying the CNAME target if the response contains no
 * direct A/AAAA records. This is how most real resolvers work — the CNAME
 * leads to the actual IP.
 *
 *
 * ## Nameserver discovery
 *
 * On first use, `#loadServers()` reads `/etc/resolv.conf` and parses
 * `nameserver <ip>` lines. If the file is unreadable or has no nameserver
 * lines, it falls back to Google's public DNS servers (8.8.8.8, 8.8.4.4).
 * Callers can override nameservers with `resolver.setServers(['1.1.1.1'])`.
 *
 *
 * ## IPv6 formatting via sock.decodeAddr
 *
 * Rather than implementing IPv6 string formatting from scratch (handling `::`,
 * leading zeros, etc.), `formatIPv6()` builds a synthetic `sockaddr_in6`
 * buffer and passes it to `sock.decodeAddr()`, which calls `inet_ntop(3)`.
 * This gives correct RFC 5952 compressed output (e.g. `2001:db8::1`) without
 * extra code.
 *
 *
 * ## Query timeout and retry
 *
 * Each query races `loop.readable(lp, fd)` against `loop.timeout(lp, ms)`.
 * If the timeout fires first, we close the socket and try the next nameserver.
 * After all servers have been tried `retries` times without a valid response,
 * we throw an `ETIMEOUT` error.
 *
 *
 * ## Contributing
 *
 * - DNS packets are big-endian. All header fields and record metadata use the
 *   `readU16()` / `readU32()` big-endian helpers defined at the top of the file.
 * - Transaction IDs should be random per query to prevent response spoofing.
 *   The current implementation uses `Math.random()`. A production resolver
 *   would use `getpid()` XOR'd with a counter to reduce collision probability.
 * - UDP datagrams may arrive out of order or be duplicates. We check that the
 *   response ID matches the query ID and discard non-matching packets.
 * - DNSSEC validation is not implemented. Responses are trusted at face value.
 */

import * as sock from './socket.mts';
import * as loop from '../runtime/loop.mts';
import { DiskFileSystem } from '../file/fs.mts';
import { decodeUtf8, encodeUtf8 } from '../internal/globals/encoding.mts';
import { os } from 'internal:process';
import { Scanner } from '../parsing/scanner.mts';

type DnsServerFamily = 'ipv4' | 'ipv6';
type RecordTypeName = keyof typeof RECORD_TYPES;

interface DnsServer { ip: string; family: DnsServerFamily; port: number; }
interface DnsError extends Error { code?: string; hostname?: string; }

export interface MxRecord   { priority: number; exchange: string; }
export interface SoaRecord  { nsname: string; hostmaster: string; serial: number; refresh: number; retry: number; expire: number; minttl: number; }
export interface SrvRecord  { priority: number; weight: number; port: number; name: string; }

export type DnsRecordData = string | string[] | MxRecord | SoaRecord | SrvRecord | Uint8Array | null;

export interface DnsResourceRecord {
  name: string;
  type: number;
  ttl:  number;
  data: DnsRecordData;
}

export interface DnsResponse {
  id:          number;
  flags:       number;
  rcode:       number;
  truncated:   boolean;
  answers:     DnsResourceRecord[];
  authorities: DnsResourceRecord[];
  additionals: DnsResourceRecord[];
}

export interface ResolverOptions { timeout?: number; retries?: number; }
export interface LookupOptions   { family?: 4 | 6; }
export interface LookupResult    { address: string; family: 4 | 6; }

const isDarwin = os === 'darwin';

// ---------------------------------------------------------------------------
// Record type constants
// ---------------------------------------------------------------------------

const QTYPE_A     = 1;
const QTYPE_NS    = 2;
const QTYPE_CNAME = 5;
const QTYPE_SOA   = 6;
const QTYPE_PTR   = 12;
const QTYPE_MX    = 15;
const QTYPE_TXT   = 16;
const QTYPE_AAAA  = 28;
const QTYPE_SRV   = 33;

/** Map from DNS record type name to numeric QTYPE value. */
export const RECORD_TYPES = {
  A:     QTYPE_A,     NS:   QTYPE_NS,  CNAME: QTYPE_CNAME,
  SOA:   QTYPE_SOA,   PTR:  QTYPE_PTR, MX:    QTYPE_MX,
  TXT:   QTYPE_TXT,   AAAA: QTYPE_AAAA, SRV:  QTYPE_SRV,
};

const RCODE_ERRORS: Partial<Record<number, { code: string; msg: string }>> = {
  1: { code: 'EFORMERR',  msg: 'format error'    },
  2: { code: 'ESERVFAIL', msg: 'server failure'   },
  3: { code: 'ENOTFOUND', msg: 'domain not found' },
  4: { code: 'ENOTIMP',   msg: 'not implemented'  },
  5: { code: 'EREFUSED',  msg: 'query refused'    },
};

const DEFAULT_SERVERS = [
  { ip: '8.8.8.8', family: 'ipv4', port: 53 },
  { ip: '8.8.4.4', family: 'ipv4', port: 53 },
] satisfies DnsServer[];

// ---------------------------------------------------------------------------
// DNS wire protocol — encoder
// ---------------------------------------------------------------------------

/**
 * Encode a domain name into DNS wire format (length-prefixed labels).
 * "example.com" → Uint8Array [7, 'e','x','a','m','p','l','e', 3, 'c','o','m', 0]
 *
 * Exported for unit testing.
 */
export function _encodeName(name: string): Uint8Array {
  if (name.endsWith('.')) name = name.slice(0, -1);
  const labels = name.split('.');

  let totalLen = 1; // terminating 0 byte
  const parts = [];
  for (const label of labels) {
    if (label.length === 0) continue;
    if (label.length > 63) throw new Error(`DNS label too long: '${label}'`);
    const bytes = encodeUtf8(label);
    totalLen += 1 + bytes.length;
    parts.push(bytes);
  }

  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const bytes of parts) {
    out[pos++] = bytes.length;
    out.set(bytes, pos);
    pos += bytes.length;
  }
  // out[pos] is 0 (already zeroed)
  return out;
}

/**
 * Build a complete DNS query packet.
 *
 * @param {number} id     16-bit transaction ID
 * @param {string} name   Hostname to query
 * @param {number} qtype  QTYPE constant (e.g. QTYPE_A)
 * @returns {Uint8Array}
 *
 * Exported for unit testing.
 */
export function _buildQuery(id: number, name: string, qtype: number): Uint8Array {
  const encodedName = _encodeName(name);
  const totalLen    = 12 + encodedName.length + 4; // header + qname + qtype(2) + qclass(2)
  const out  = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);

  // DNS header (12 bytes, big-endian)
  view.setUint16(0, id,     false); // ID
  view.setUint16(2, 0x0100, false); // Flags: RD=1, everything else 0
  view.setUint16(4, 1,      false); // QDCOUNT = 1
  // ANCOUNT, NSCOUNT, ARCOUNT = 0 (already zero)

  // Question section
  out.set(encodedName, 12);
  view.setUint16(12 + encodedName.length,     qtype, false); // QTYPE
  view.setUint16(12 + encodedName.length + 2, 1,     false); // QCLASS = IN

  return out;
}

// ---------------------------------------------------------------------------
// DNS wire protocol — decoder
// ---------------------------------------------------------------------------

/**
 * Decode a DNS name from wire format, following compression pointers.
 *
 * @param {Uint8Array} msg         Full DNS message
 * @param {number}     startOffset Byte offset into msg where the name starts
 * @returns {{ name: string, nextOffset: number }}
 *   nextOffset is the offset of the first byte after this name in the stream.
 *
 * Exported for unit testing.
 */
export function _decodeName(msg: Uint8Array, startOffset: number): { name: string; nextOffset: number } {
  const parts: string[] = [];
  const scanner = new Scanner(msg, { format: 'dns' });
  const seen = new Set<number>();
  let hops = 0;
  let endOffset = -1;

  scanner.jump(startOffset);

  while (true) {
    if (scanner.remainingBytes < 1) throw new Error('DNS: truncated name');
    const labelOffset = scanner.offset;
    if (seen.has(labelOffset)) throw new Error('DNS: compression pointer loop detected');
    seen.add(labelOffset);

    const len = scanner.readU8();

    if ((len & 0xC0) === 0xC0) {
      // Compression pointer (2 bytes): remaining 14 bits = offset into msg
      if (scanner.remainingBytes < 1) throw new Error('DNS: truncated compression pointer');
      const lo = scanner.readU8();
      if (endOffset === -1) endOffset = scanner.offset;
      if (hops++ > 128) throw new Error('DNS: compression pointer loop detected');
      const pointer = ((len & 0x3F) << 8) | lo;
      if (pointer >= msg.length) throw new Error('DNS: compression pointer out of range');
      scanner.jump(pointer);
      continue;
    }

    if ((len & 0xC0) !== 0) throw new Error('DNS: invalid label length');

    if (len === 0) {
      // Root label — end of name
      if (endOffset === -1) endOffset = scanner.offset;
      break;
    }

    if (scanner.remainingBytes < len) throw new Error('DNS: truncated label');
    parts.push(scanner.eatText(len, 'utf-8'));
  }

  return { name: parts.join('.'), nextOffset: endOffset };
}

/**
 * Parse one DNS resource record from msg starting at offset.
 * Returns { record, nextOffset } where nextOffset points past the record.
 */
function parseResourceRecord(msg: Uint8Array, offset: number): { record: DnsResourceRecord; nextOffset: number } {
  const { name, nextOffset: afterName } = _decodeName(msg, offset);
  const scanner = new Scanner(msg, { format: 'dns' });
  scanner.jump(afterName);
  if (scanner.remainingBytes < 10) throw new Error('DNS: truncated resource record header');

  const type = scanner.readU16BEField('resource record type');
  scanner.readU16BEField('resource record class');
  const ttl = scanner.readU32BEField('resource record ttl');
  const rdlength = scanner.readU16BEField('resource record data length');

  const rdataStart = scanner.offset;
  const rdataEnd   = rdataStart + rdlength;
  if (rdataEnd > msg.length) throw new Error('DNS: truncated resource record data');

  let data: DnsRecordData;
  switch (type) {
    case QTYPE_A: {
      if (rdlength !== 4) throw new Error('DNS: invalid A record length');
      data = `${msg[rdataStart]}.${msg[rdataStart+1]}.${msg[rdataStart+2]}.${msg[rdataStart+3]}`;
      break;
    }
    case QTYPE_AAAA: {
      if (rdlength !== 16) throw new Error('DNS: invalid AAAA record length');
      data = formatIPv6(msg.subarray(rdataStart, rdataStart + 16));
      break;
    }
    case QTYPE_CNAME:
    case QTYPE_NS:
    case QTYPE_PTR: {
      data = _decodeName(msg, rdataStart).name;
      break;
    }
    case QTYPE_MX: {
      if (rdlength < 3) throw new Error('DNS: truncated MX record data');
      const rdata = new Scanner(msg.subarray(rdataStart, rdataEnd), { format: 'dns' });
      const priority = rdata.readU16BEField('MX priority');
      const exchange   = _decodeName(msg, rdataStart + 2).name;
      data = { priority, exchange };
      break;
    }
    case QTYPE_TXT: {
      const strings: string[] = [];
      let pos = rdataStart;
      while (pos < rdataEnd) {
        const slen = msg[pos++];
        if (slen === undefined) break;
        if (pos + slen > rdataEnd) throw new Error('DNS: truncated TXT record data');
        strings.push(decodeUtf8(msg.subarray(pos, pos + slen)));
        pos += slen;
      }
      data = strings;
      break;
    }
    case QTYPE_SOA: {
      const { name: mname, nextOffset: afterMname } = _decodeName(msg, rdataStart);
      const { name: rname, nextOffset: afterRname  } = _decodeName(msg, afterMname);
      if (afterRname + 20 > rdataEnd) throw new Error('DNS: truncated SOA record data');
      const soa = new Scanner(msg.subarray(afterRname, rdataEnd), { format: 'dns' });
      data = {
        nsname:     mname,
        hostmaster: rname,
        serial:     soa.readU32BEField('SOA serial'),
        refresh:    soa.readU32BEField('SOA refresh'),
        retry:      soa.readU32BEField('SOA retry'),
        expire:     soa.readU32BEField('SOA expire'),
        minttl:     soa.readU32BEField('SOA minimum ttl'),
      };
      break;
    }
    case QTYPE_SRV: {
      if (rdlength < 7) throw new Error('DNS: truncated SRV record data');
      const rdata = new Scanner(msg.subarray(rdataStart, rdataEnd), { format: 'dns' });
      const priority = rdata.readU16BEField('SRV priority');
      const weight   = rdata.readU16BEField('SRV weight');
      const port     = rdata.readU16BEField('SRV port');
      const target   = _decodeName(msg, rdataStart + 6).name;
      data = { priority, weight, port, name: target };
      break;
    }
    default: {
      // Unknown type — return raw bytes
      data = msg.slice(rdataStart, rdataEnd);
      break;
    }
  }

  return {
    record: { name, type, ttl, data },
    nextOffset: rdataEnd,
  };
}

/**
 * Parse a complete DNS response packet.
 *
 * @param {Uint8Array} msg
 * @returns {{ id, flags, rcode, truncated, answers, authorities, additionals }}
 *
 * Exported for unit testing.
 */
export function _parseResponse(msg: Uint8Array): DnsResponse {
  if (msg.length < 12) throw new Error('DNS: response too short');

  const scanner = new Scanner(msg, { format: 'dns' });
  const id      = scanner.readU16BEField('id');
  const flags   = scanner.readU16BEField('flags');
  const qdcount = scanner.readU16BEField('question count');
  const ancount = scanner.readU16BEField('answer count');
  const nscount = scanner.readU16BEField('authority count');
  const arcount = scanner.readU16BEField('additional count');

  const rcode     = flags & 0xF;
  const truncated = Boolean((flags >> 9) & 1);

  // Skip question section (we trust the response matches our query)
  for (let i = 0; i < qdcount; i++) {
    const { nextOffset } = _decodeName(msg, scanner.offset);
    scanner.jump(nextOffset);
    if (scanner.remainingBytes < 4) throw new Error('DNS: truncated question');
    scanner.eatBytes(4); // QTYPE(2) + QCLASS(2)
  }

  const answers: DnsResourceRecord[] = [];
  const authorities: DnsResourceRecord[] = [];
  const additionals: DnsResourceRecord[] = [];

  // Closure advances the shared response scanner past each RR.
  function readRRs(out: DnsResourceRecord[], count: number) {
    for (let i = 0; i < count; i++) {
      const { record, nextOffset } = parseResourceRecord(msg, scanner.offset);
      scanner.jump(nextOffset);
      out.push(record);
    }
  }

  readRRs(answers,     ancount);
  readRRs(authorities, nscount);
  readRRs(additionals, arcount);

  return { id, flags, rcode, truncated, answers, authorities, additionals };
}

// ---------------------------------------------------------------------------
// Address formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format 16 raw IPv6 address bytes as a colon-separated string.
 * Reuses inet_ntop via sock.decodeAddr() on a synthetic sockaddr_in6 buffer.
 */
function formatIPv6(bytes16: Uint8Array): string {
  const SOCKADDR_IN6_SIZE = 28;
  const buf  = new ArrayBuffer(SOCKADDR_IN6_SIZE);
  const view = new DataView(buf);
  if (isDarwin) {
    view.setUint8(0, SOCKADDR_IN6_SIZE);  // sa_len
    view.setUint8(1, sock.AF_INET6);      // sa_family
  } else {
    view.setUint16(0, sock.AF_INET6, true); // sa_family (LE)
  }
  // bytes 2-3: port = 0 | bytes 4-7: flowinfo = 0
  new Uint8Array(buf, 8, 16).set(bytes16.subarray(0, 16)); // sin6_addr
  // bytes 24-27: scope_id = 0
  const addr = sock.decodeAddr(buf);
  if ('ip' in addr && typeof addr.ip === 'string') {
    return addr.ip;
  }
  return '';
}

/**
 * Convert an IP address string to its PTR query name.
 *   "1.2.3.4"  → "4.3.2.1.in-addr.arpa"
 *   "2001:db8::1" → nibble-reversed + ".ip6.arpa"
 *
 * Exported for unit testing.
 */
export function _reverseIP(ip: string): string {
  if (ip.includes(':')) {
    return ipv6ToPtrName(ip);
  }
  return ip.split('.').reverse().join('.') + '.in-addr.arpa';
}

/** Expand an IPv6 address to its full .ip6.arpa PTR name. */
function ipv6ToPtrName(ip: string): string {
  // Handle :: expansion → full 8 groups of 4 hex digits
  const halves = ip.split('::');
  let groups: string[];
  if (halves.length === 2) {
    const left  = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill  = 8 - left.length - right.length;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  } else {
    groups = ip.split(':');
  }
  const hex = groups.map(g => g.padStart(4, '0')).join('');
  return hex.split('').reverse().join('.') + '.ip6.arpa';
}

// ---------------------------------------------------------------------------
// Result formatting per record type
// ---------------------------------------------------------------------------

function isStringRecord(record: DnsResourceRecord): record is DnsResourceRecord & { data: string } {
  return typeof record.data === 'string';
}

function isMxRecord(record: DnsResourceRecord): record is DnsResourceRecord & { data: MxRecord } {
  return record.data !== null
    && typeof record.data === 'object'
    && 'exchange' in record.data
    && 'priority' in record.data;
}

function formatRecords(records: DnsResourceRecord[], rrtype: RecordTypeName): DnsRecordData[] {
  switch (rrtype) {
    case 'A':
    case 'AAAA':
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return records.filter(isStringRecord).map(r => r.data);
    case 'MX':
      return records.filter(isMxRecord).map(r => r.data);
    case 'TXT':
      return records.map(r => r.data);
    case 'SOA':
      return records.length > 0 && records[0] ? [records[0].data] : [];
    case 'SRV':
      return records.map(r => r.data);
    default:
      return records.map(r => r.data);
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export class Resolver {
  #servers: DnsServer[] | null;
  #serversLoaded: Promise<void> | null;
  #timeout: number;
  #retries: number;

  /**
   * @param {object} [opts]
   * @param {number} [opts.timeout=5000]  Query timeout in milliseconds.
   * @param {number} [opts.retries=2]     Retry attempts per server.
   */
  constructor(opts: ResolverOptions = {}) {
    this.#servers       = null;
    this.#serversLoaded = null;
    this.#timeout       = opts.timeout ?? 5000;
    this.#retries       = opts.retries ?? 2;
  }

  // -------------------------------------------------------------------------
  // Nameserver management
  // -------------------------------------------------------------------------

  /**
   * Return the current list of nameserver IP addresses.
   * @returns {string[]}
   */
  getServers(): string[] {
    return (this.#servers ?? DEFAULT_SERVERS).map(s =>
      s.port !== 53 ? `${s.ip}:${s.port}` : s.ip
    );
  }

  /**
   * Override the nameserver list. Each entry is an IPv4 or IPv6 address string,
   * optionally with a port: '1.1.1.1', '1.1.1.1:5353', '[::1]:5353'.
   * @param {string[]} servers
   */
  setServers(servers: string[]): void {
    if (!Array.isArray(servers) || servers.length === 0) {
      throw new Error('dns.setServers: expected a non-empty array of IP addresses');
    }
    this.#servers = servers.map(entry => {
      const s = String(entry);
      let ip = s;
      let port = 53;
      if (s.startsWith('[')) {
        // IPv6 with optional port: [2001:...]:port or [2001:...]
        const closeBracket = s.indexOf(']');
        ip = s.slice(1, closeBracket >= 0 ? closeBracket : s.length);
        if (closeBracket >= 0 && s[closeBracket + 1] === ':') {
          port = parseInt(s.slice(closeBracket + 2), 10) || 53;
        }
      } else {
        // IPv4 with optional port: ip or ip:port
        const potentialIp = s.slice(0, s.lastIndexOf(':') > 0 ? s.lastIndexOf(':') : s.length);
        if (s.lastIndexOf(':') > 0 && !potentialIp.includes(':')) {
          ip = potentialIp;
          port = parseInt(s.slice(s.lastIndexOf(':') + 1), 10) || 53;
        }
      }
      return { ip, port, family: ip.includes(':') ? ('ipv6' as const) : ('ipv4' as const) };
    });
    // Mark as loaded so #ensureServers does not overwrite
    if (!this.#serversLoaded) {
      this.#serversLoaded = Promise.resolve();
    }
  }

  // -------------------------------------------------------------------------
  // Public query API
  // -------------------------------------------------------------------------

  /**
   * Resolve a hostname for the given record type.
   *
   * @param {string} hostname
   * @param {string} [rrtype='A']  One of: A AAAA CNAME MX NS PTR SOA SRV TXT
   * @returns {Promise<Array>}
   */
  async resolve(hostname: string, rrtype: RecordTypeName = 'A'): Promise<DnsRecordData[]> {
    const qtypeNum = RECORD_TYPES[rrtype];

    // For A/AAAA, follow CNAME chains up to 10 hops
    const followCname = (rrtype === 'A' || rrtype === 'AAAA');
    let name = hostname;

    for (let hop = 0; hop <= 10; hop++) {
      const response = await this.#sendQuery(name, qtypeNum);

      const direct = response.answers.filter(r => r.type === qtypeNum);
      if (direct.length > 0) {
        return formatRecords(direct, rrtype);
      }

      if (followCname) {
        const cname = response.answers.find(r => r.type === QTYPE_CNAME);
        if (cname && typeof cname.data === 'string') {
          name = cname.data;
          continue;
        }
      }

      return [];
    }

    const err: DnsError = new Error(`dns: too many CNAME hops for '${hostname}'`);
    err.code     = 'ENODATA';
    err.hostname = hostname;
    throw err;
  }

  /** Resolve IPv4 addresses. @returns {Promise<string[]>} */
  async resolve4(hostname: string)     { return this.resolve(hostname, 'A');     }
  /** Resolve IPv6 addresses. @returns {Promise<string[]>} */
  async resolve6(hostname: string)     { return this.resolve(hostname, 'AAAA');  }
  /** Resolve MX records. @returns {Promise<{exchange, priority}[]>} */
  async resolveMx(hostname: string)    { return this.resolve(hostname, 'MX');    }
  /** Resolve TXT records. @returns {Promise<string[][]>} */
  async resolveTxt(hostname: string)   { return this.resolve(hostname, 'TXT');   }
  /** Resolve NS records. @returns {Promise<string[]>} */
  async resolveNs(hostname: string)    { return this.resolve(hostname, 'NS');    }
  /** Resolve SRV records. @returns {Promise<{name, port, priority, weight}[]>} */
  async resolveSrv(hostname: string)   { return this.resolve(hostname, 'SRV');   }
  /** Resolve SOA record. @returns {Promise<object>} */
  async resolveSoa(hostname: string)   { return this.resolve(hostname, 'SOA');   }
  /** Resolve CNAME records. @returns {Promise<string[]>} */
  async resolveCname(hostname: string) { return this.resolve(hostname, 'CNAME'); }

  /**
   * Reverse DNS lookup.
   * @param {string} ip  IPv4 or IPv6 address.
   * @returns {Promise<string[]>}
   */
  async reverse(ip: string): Promise<DnsRecordData[]> {
    return this.resolve(_reverseIP(ip), 'PTR');
  }

  // -------------------------------------------------------------------------
  // Private: nameserver loading
  // -------------------------------------------------------------------------

  async #ensureServers() {
    if (this.#servers !== null) return;
    if (!this.#serversLoaded) {
      this.#serversLoaded = this.#loadServers();
    }
    await this.#serversLoaded;
  }

  async #loadServers() {
    try {
      const fs   = new DiskFileSystem();
      const text = await fs.readFile('/etc/resolv.conf');
      const servers: DnsServer[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('nameserver')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2 && parts[1]) {
          const ip = parts[1];
          servers.push({ ip, family: ip.includes(':') ? 'ipv6' : 'ipv4', port: 53 });
        }
      }
      this.#servers = servers.length > 0 ? servers : DEFAULT_SERVERS;
    } catch {
      this.#servers = DEFAULT_SERVERS;
    }
  }

  // -------------------------------------------------------------------------
  // Private: query execution
  // -------------------------------------------------------------------------

  /**
   * Send a DNS UDP query and return the parsed response.
   * Tries each nameserver in order, with up to #retries total rounds.
   */
  async #sendQuery(name: string, qtype: number): Promise<DnsResponse> {
    await this.#ensureServers();

    // Random 16-bit transaction ID (1..65535)
    const id     = Math.max(1, (Math.random() * 0xFFFF) | 0);
    const packet = _buildQuery(id, name, qtype);

    const TIMED_OUT = Symbol('timeout');
    const servers = this.#servers ?? DEFAULT_SERVERS;

    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      for (const server of servers) {
        const af = server.family === 'ipv6' ? sock.AF_INET6 : sock.AF_INET;

        let fd;
        try {
          fd = sock.socket(af, sock.SOCK_DGRAM, 0);
        } catch {
          continue; // socket creation failed, try next server
        }

        sock.setNonblocking(fd);

        const bytesSent = sock.sendto(fd, packet, {
          family: server.family,
          ip:     server.ip,
          port:   server.port,
        });
        if (bytesSent < 0) {
          sock.close(fd);
          continue;
        }

        // Race the fd becoming readable against a timeout
        const dnsTimer = loop.timeout(this.#timeout);
        const result = await Promise.race([
          loop.readable(fd).then(function dnsReady() { dnsTimer.cancel(); return 'ready'; }),
          dnsTimer.then(function dnsTimedOut() { return TIMED_OUT; }),
        ]);

        if (result === TIMED_OUT) {
          loop.removeRead(fd);
          sock.close(fd);
          continue; // try next server
        }

        // fd is readable — receive the UDP datagram
        const recvResult = sock.recvfrom(fd, 4096);
        sock.close(fd);

        if (typeof recvResult === 'number' || recvResult === null) {
          continue; // receive error (e.g. EAGAIN)
        }

        let response;
        try {
          response = _parseResponse(recvResult.data);
        } catch {
          continue; // malformed packet
        }

        // Discard responses with wrong transaction ID
        if (response.id !== id) continue;

        // Handle non-zero RCODE
        if (response.rcode !== 0) {
          const rcodeInfo = RCODE_ERRORS[response.rcode];
          if (rcodeInfo) {
            const err: DnsError = new Error(`dns: ${rcodeInfo.msg} for '${name}'`);
            err.code     = rcodeInfo.code;
            err.hostname = name;
            throw err;
          }
          continue; // unknown rcode, try next
        }

        return response;
      }
    }

    const err: DnsError = new Error(`dns: query timed out for '${name}'`);
    err.code     = 'ETIMEOUT';
    err.hostname = name;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Module-level convenience
// ---------------------------------------------------------------------------

/** Module-level default Resolver (created on first use). */
let _defaultResolver: Resolver | null = null;

/**
 * Look up the primary address for a hostname.
 *
 * @param {string}  hostname
 * @param {{ family?: 4|6 }} [opts]  Defaults to IPv4.
 * @returns {Promise<{ address: string, family: 4|6 }>}
 */
export async function lookup(hostname: string, opts: LookupOptions = {}): Promise<LookupResult> {
  const family = opts.family ?? 4;

  // If hostname is already an IP literal, return it directly without DNS lookup.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return { address: hostname, family: 4 };
  }
  if (hostname.includes(':')) {
    // IPv6 address literal (e.g. "::1", "2001:db8::1")
    return { address: hostname, family: 6 };
  }

  if (!_defaultResolver) _defaultResolver = new Resolver();
  const rrtype = family === 6 ? 'AAAA' : 'A';
  const addresses = await _defaultResolver.resolve(hostname, rrtype);
  if (addresses.length === 0) {
    const err: DnsError = new Error(`dns: no ${rrtype} record for '${hostname}'`);
    err.code     = 'ENOTFOUND';
    err.hostname = hostname;
    throw err;
  }
  const address = addresses[0];
  if (typeof address !== 'string') {
    const err: DnsError = new Error(`dns: invalid ${rrtype} response for '${hostname}'`);
    err.code = 'ENODATA';
    err.hostname = hostname;
    throw err;
  }
  return { address, family };
}

export default { Resolver, lookup, RECORD_TYPES };
