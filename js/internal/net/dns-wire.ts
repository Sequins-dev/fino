/**
* internal:net/dns-wire - DNS packet helpers shared by DNS-family modules.
*
* This module is intentionally internal. Public code should use
* `fino:net/dns` and `fino:net/mdns`; these helpers expose raw packet
* encoding, decoding, and parser behavior for runtime modules and focused
* protocol tests.
*/
import * as sock from '../../net/socket.ts';
import { Scanner } from '../../parsing/scanner.ts';
import { decodeUtf8, encodeUtf8 } from 'internal:encoding';
import { os } from 'internal:process';
import type { DnsRecordData, DnsResourceRecord, DnsResponse, DnsServer } from '../../net/dns.ts';

const QTYPE_A = 1;
const QTYPE_NS = 2;
const QTYPE_CNAME = 5;
const QTYPE_SOA = 6;
const QTYPE_PTR = 12;
const QTYPE_MX = 15;
const QTYPE_TXT = 16;
const QTYPE_DS = 43;
const QTYPE_RRSIG = 46;
const QTYPE_NSEC = 47;
const QTYPE_DNSKEY = 48;
const QTYPE_AAAA = 28;
const QTYPE_SRV = 33;
const QTYPE_OPT = 41;
const QTYPE_NSEC3 = 50;
const QTYPE_NSEC3PARAM = 51;

export const RECORD_TYPES = {
  A: QTYPE_A,
  NS: QTYPE_NS,
  CNAME: QTYPE_CNAME,
  SOA: QTYPE_SOA,
  PTR: QTYPE_PTR,
  MX: QTYPE_MX,
  TXT: QTYPE_TXT,
  AAAA: QTYPE_AAAA,
  SRV: QTYPE_SRV,
  DS: QTYPE_DS,
  RRSIG: QTYPE_RRSIG,
  NSEC: QTYPE_NSEC,
  DNSKEY: QTYPE_DNSKEY,
  NSEC3: QTYPE_NSEC3,
  NSEC3PARAM: QTYPE_NSEC3PARAM
};

const DEFAULT_SERVERS = [{
  ip: '8.8.8.8',
  family: 'ipv4',
  port: 53
}, {
  ip: '8.8.4.4',
  family: 'ipv4',
  port: 53
}] satisfies DnsServer[];
const isDarwin = os === 'darwin';

function isIpv4Literal(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255 && String(octet) === String(Number(part));
  });
}

function isIpv6Literal(value: string): boolean {
  return value.includes(':') && !value.includes('.') && /^[0-9a-fA-F:]+$/.test(value);
}

export function _parseResolvConf(text: string): DnsServer[] {
  const servers: DnsServer[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/#.*/, '').trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[0] !== 'nameserver' || !parts[1]) continue;
    const ip = parts[1];
    if (isIpv4Literal(ip)) {
      servers.push({ ip, family: 'ipv4', port: 53 });
    } else if (isIpv6Literal(ip)) {
      servers.push({ ip, family: 'ipv6', port: 53 });
    }
  }
  return servers.length > 0 ? servers : DEFAULT_SERVERS.map((server) => ({ ...server }));
}

export function _randomQueryId(): number {
  const bytes = new Uint16Array(1);
  do {
    crypto.getRandomValues(bytes);
  } while (bytes[0] === 0);
  return bytes[0]!;
}

function _adaptPunycodeBias(delta: number, numPoints: number, firstTime: boolean): number {
  delta = firstTime ? Math.floor(delta / 700) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > 455) {
    delta = Math.floor(delta / 35);
    k += 36;
  }
  return k + Math.floor(36 * delta / (delta + 38));
}

function _encodePunycodeDigit(digit: number): string {
  return String.fromCharCode(digit + 22 + 75 * (digit < 26 ? 1 : 0));
}

function _normalizeDnsLabel(label: string): string {
  const points = Array.from(label, (ch) => ch.codePointAt(0)!);
  if (points.every((cp) => cp < 128)) return label;
  let output = '';
  let handled = 0;
  for (const cp of points) {
    if (cp < 128) {
      output += String.fromCharCode(cp).toLowerCase();
      handled++;
    }
  }
  const basic = handled;
  if (basic > 0) output += '-';
  let n = 128;
  let delta = 0;
  let bias = 72;
  while (handled < points.length) {
    let m = Infinity;
    for (const cp of points) if (cp >= n && cp < m) m = cp;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const cp of points) {
      if (cp < n) delta++;
      if (cp !== n) continue;
      let q = delta;
      for (let k = 36;; k += 36) {
        const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
        if (q < t) break;
        output += _encodePunycodeDigit(t + (q - t) % (36 - t));
        q = Math.floor((q - t) / (36 - t));
      }
      output += _encodePunycodeDigit(q);
      bias = _adaptPunycodeBias(delta, handled + 1, handled === basic);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return 'xn--' + output;
}

export function _encodeName(name: string): Uint8Array {
  if (name.endsWith('.')) name = name.slice(0, -1);
  const labels = name.split('.');
  let totalLen = 1;
  const parts = [];
  for (const label of labels) {
    if (label.length === 0) continue;
    const normalizedLabel = _normalizeDnsLabel(label);
    const bytes = encodeUtf8(normalizedLabel);
    if (bytes.length > 63) throw new Error(`DNS label too long: '${label}'`);
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
  return out;
}

export function _buildQuery(id: number, name: string, qtype: number, options: {
  dnssec?: boolean;
  udpPayloadSize?: number;
} = {}): Uint8Array {
  const encodedName = _encodeName(name);
  const addOpt = options.dnssec === true;
  const totalLen = 12 + encodedName.length + 4 + (addOpt ? 11 : 0);
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  view.setUint16(0, id, false);
  view.setUint16(2, 256, false);
  view.setUint16(4, 1, false);
  if (addOpt) view.setUint16(10, 1, false);
  out.set(encodedName, 12);
  view.setUint16(12 + encodedName.length, qtype, false);
  view.setUint16(12 + encodedName.length + 2, 1, false);
  if (addOpt) {
    const optOffset = 12 + encodedName.length + 4;
    out[optOffset] = 0;
    view.setUint16(optOffset + 1, QTYPE_OPT, false);
    view.setUint16(optOffset + 3, options.udpPayloadSize ?? 1232, false);
    out[optOffset + 5] = 0;
    out[optOffset + 6] = 0;
    view.setUint16(optOffset + 7, 32768, false);
    view.setUint16(optOffset + 9, 0, false);
  }
  return out;
}

export function _decodeName(msg: Uint8Array, startOffset: number): {
  name: string;
  nextOffset: number;
} {
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
    if ((len & 192) === 192) {
      if (scanner.remainingBytes < 1) throw new Error('DNS: truncated compression pointer');
      const lo = scanner.readU8();
      if (endOffset === -1) endOffset = scanner.offset;
      if (hops++ > 128) throw new Error('DNS: compression pointer loop detected');
      const pointer = (len & 63) << 8 | lo;
      if (pointer >= msg.length) throw new Error('DNS: compression pointer out of range');
      scanner.jump(pointer);
      continue;
    }
    if ((len & 192) !== 0) throw new Error('DNS: invalid label length');
    if (len === 0) {
      if (endOffset === -1) endOffset = scanner.offset;
      break;
    }
    if (scanner.remainingBytes < len) throw new Error('DNS: truncated label');
    parts.push(scanner.eatText(len, 'utf-8'));
  }
  return { name: parts.join('.'), nextOffset: endOffset };
}

function decodeTypeBitmap(bytes: Uint8Array): number[] {
  const types: number[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 2 > bytes.byteLength) throw new Error('DNS: truncated DNSSEC type bitmap');
    const window = bytes[offset++]!;
    const length = bytes[offset++]!;
    if (length === 0 || length > 32) throw new Error('DNS: invalid DNSSEC type bitmap length');
    if (offset + length > bytes.byteLength) throw new Error('DNS: truncated DNSSEC type bitmap window');
    for (let i = 0; i < length; i++) {
      const value = bytes[offset + i]!;
      for (let bit = 0; bit < 8; bit++) {
        if ((value & 1 << 7 - bit) !== 0) types.push(window * 256 + i * 8 + bit);
      }
    }
    offset += length;
  }
  return types;
}

function parseResourceRecord(msg: Uint8Array, offset: number): {
  record: DnsResourceRecord;
  nextOffset: number;
} {
  const { name, nextOffset: afterName } = _decodeName(msg, offset);
  const scanner = new Scanner(msg, { format: 'dns' });
  scanner.jump(afterName);
  if (scanner.remainingBytes < 10) throw new Error('DNS: truncated resource record header');
  const type = scanner.readU16BEField('resource record type');
  const rawClass = scanner.readU16BEField('resource record class');
  const classCode = rawClass & 0x7fff;
  const cacheFlush = (rawClass & 0x8000) !== 0;
  const ttl = scanner.readU32BEField('resource record ttl');
  const rdlength = scanner.readU16BEField('resource record data length');
  const rdataStart = scanner.offset;
  const rdataEnd = rdataStart + rdlength;
  if (rdataEnd > msg.length) throw new Error('DNS: truncated resource record data');
  const rawData = msg.slice(rdataStart, rdataEnd);
  let data: DnsRecordData;
  switch (type) {
    case QTYPE_A:
      if (rdlength !== 4) throw new Error('DNS: invalid A record length');
      data = `${msg[rdataStart]}.${msg[rdataStart + 1]}.${msg[rdataStart + 2]}.${msg[rdataStart + 3]}`;
      break;
    case QTYPE_AAAA:
      if (rdlength !== 16) throw new Error('DNS: invalid AAAA record length');
      data = formatIPv6(msg.subarray(rdataStart, rdataStart + 16));
      break;
    case QTYPE_CNAME:
    case QTYPE_NS:
    case QTYPE_PTR:
      data = _decodeName(msg, rdataStart).name;
      break;
    case QTYPE_MX: {
      if (rdlength < 3) throw new Error('DNS: truncated MX record data');
      const rdata = new Scanner(msg.subarray(rdataStart, rdataEnd), { format: 'dns' });
      const priority = rdata.readU16BEField('MX priority');
      const exchange = _decodeName(msg, rdataStart + 2).name;
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
      const { name: rname, nextOffset: afterRname } = _decodeName(msg, afterMname);
      if (afterRname + 20 > rdataEnd) throw new Error('DNS: truncated SOA record data');
      const soa = new Scanner(msg.subarray(afterRname, rdataEnd), { format: 'dns' });
      data = {
        nsname: mname,
        hostmaster: rname,
        serial: soa.readU32BEField('SOA serial'),
        refresh: soa.readU32BEField('SOA refresh'),
        retry: soa.readU32BEField('SOA retry'),
        expire: soa.readU32BEField('SOA expire'),
        minttl: soa.readU32BEField('SOA minimum ttl')
      };
      break;
    }
    case QTYPE_SRV: {
      if (rdlength < 7) throw new Error('DNS: truncated SRV record data');
      const rdata = new Scanner(msg.subarray(rdataStart, rdataEnd), { format: 'dns' });
      const priority = rdata.readU16BEField('SRV priority');
      const weight = rdata.readU16BEField('SRV weight');
      const port = rdata.readU16BEField('SRV port');
      const target = _decodeName(msg, rdataStart + 6).name;
      data = { priority, weight, port, name: target };
      break;
    }
    case QTYPE_DS: {
      if (rdlength < 4) throw new Error('DNS: truncated DS record data');
      const rdata = new Scanner(msg.subarray(rdataStart, rdataEnd), { format: 'dns' });
      data = {
        keyTag: rdata.readU16BEField('DS key tag'),
        algorithm: rdata.readU8(),
        digestType: rdata.readU8(),
        digest: msg.slice(rdataStart + 4, rdataEnd)
      };
      break;
    }
    case QTYPE_DNSKEY: {
      if (rdlength < 4) throw new Error('DNS: truncated DNSKEY record data');
      const rdata = new Scanner(msg.subarray(rdataStart, rdataEnd), { format: 'dns' });
      data = {
        flags: rdata.readU16BEField('DNSKEY flags'),
        protocol: rdata.readU8(),
        algorithm: rdata.readU8(),
        publicKey: msg.slice(rdataStart + 4, rdataEnd)
      };
      break;
    }
    case QTYPE_RRSIG: {
      if (rdlength < 19) throw new Error('DNS: truncated RRSIG record data');
      const rdata = new Scanner(msg.subarray(rdataStart, rdataEnd), { format: 'dns' });
      const typeCovered = rdata.readU16BEField('RRSIG type covered');
      const algorithm = rdata.readU8();
      const labels = rdata.readU8();
      const originalTtl = rdata.readU32BEField('RRSIG original ttl');
      const expiration = rdata.readU32BEField('RRSIG expiration');
      const inception = rdata.readU32BEField('RRSIG inception');
      const keyTag = rdata.readU16BEField('RRSIG key tag');
      const { name: signerName, nextOffset: afterSigner } = _decodeName(msg, rdataStart + 18);
      if (afterSigner > rdataEnd) throw new Error('DNS: truncated RRSIG signer name');
      data = { typeCovered, algorithm, labels, originalTtl, expiration, inception, keyTag, signerName, signature: msg.slice(afterSigner, rdataEnd) };
      break;
    }
    case QTYPE_NSEC: {
      const { name: nextDomainName, nextOffset: afterNext } = _decodeName(msg, rdataStart);
      if (afterNext > rdataEnd) throw new Error('DNS: truncated NSEC record data');
      data = { nextDomainName, types: decodeTypeBitmap(msg.subarray(afterNext, rdataEnd)) };
      break;
    }
    case QTYPE_NSEC3: {
      if (rdlength < 5) throw new Error('DNS: truncated NSEC3 record data');
      const rdata = new Scanner(msg.subarray(rdataStart, rdataEnd), { format: 'dns' });
      const hashAlgorithm = rdata.readU8();
      const flags = rdata.readU8();
      const iterations = rdata.readU16BEField('NSEC3 iterations');
      const saltLength = rdata.readU8();
      if (rdata.remainingBytes < saltLength + 1) throw new Error('DNS: truncated NSEC3 salt');
      const salt = rdata.eatBytes(saltLength);
      const hashLength = rdata.readU8();
      if (rdata.remainingBytes < hashLength) throw new Error('DNS: truncated NSEC3 next hashed owner');
      const nextHashedOwnerName = rdata.eatBytes(hashLength);
      data = {
        hashAlgorithm,
        flags,
        iterations,
        salt,
        nextHashedOwnerName,
        types: decodeTypeBitmap(msg.subarray(rdataStart + rdata.offset, rdataEnd))
      };
      break;
    }
    case QTYPE_NSEC3PARAM: {
      if (rdlength < 5) throw new Error('DNS: truncated NSEC3PARAM record data');
      const rdata = new Scanner(msg.subarray(rdataStart, rdataEnd), { format: 'dns' });
      const hashAlgorithm = rdata.readU8();
      const flags = rdata.readU8();
      const iterations = rdata.readU16BEField('NSEC3PARAM iterations');
      const saltLength = rdata.readU8();
      if (rdata.remainingBytes !== saltLength) throw new Error('DNS: invalid NSEC3PARAM salt length');
      data = { hashAlgorithm, flags, iterations, salt: rdata.eatBytes(saltLength) };
      break;
    }
    case QTYPE_OPT:
      data = rawData;
      break;
    default:
      data = msg.slice(rdataStart, rdataEnd);
      break;
  }
  return {
    record: { name, type, classCode, cacheFlush, ttl, rawData, data },
    nextOffset: rdataEnd
  };
}

export function _parseResponse(msg: Uint8Array): DnsResponse {
  if (msg.length < 12) throw new Error('DNS: response too short');
  const scanner = new Scanner(msg, { format: 'dns' });
  const id = scanner.readU16BEField('id');
  const flags = scanner.readU16BEField('flags');
  const qdcount = scanner.readU16BEField('question count');
  const ancount = scanner.readU16BEField('answer count');
  const nscount = scanner.readU16BEField('authority count');
  const arcount = scanner.readU16BEField('additional count');
  const rcode = flags & 15;
  const truncated = Boolean(flags >> 9 & 1);
  for (let i = 0; i < qdcount; i++) {
    const { nextOffset } = _decodeName(msg, scanner.offset);
    scanner.jump(nextOffset);
    if (scanner.remainingBytes < 4) throw new Error('DNS: truncated question');
    scanner.eatBytes(4);
  }
  const answers: DnsResourceRecord[] = [];
  const authorities: DnsResourceRecord[] = [];
  const additionals: DnsResourceRecord[] = [];
  let edns: DnsResponse['edns'];
  function readRRs(out: DnsResourceRecord[], count: number) {
    for (let i = 0; i < count; i++) {
      const { record, nextOffset } = parseResourceRecord(msg, scanner.offset);
      scanner.jump(nextOffset);
      out.push(record);
    }
  }
  readRRs(answers, ancount);
  readRRs(authorities, nscount);
  for (let i = 0; i < arcount; i++) {
    const rrOffset = scanner.offset;
    const { record, nextOffset } = parseResourceRecord(msg, scanner.offset);
    scanner.jump(nextOffset);
    if (record.type === QTYPE_OPT) {
      const { nextOffset: afterName } = _decodeName(msg, rrOffset);
      const optScanner = new Scanner(msg, { format: 'dns' });
      optScanner.jump(afterName + 2);
      const udpPayloadSize = optScanner.readU16BEField('OPT UDP payload size');
      const ttl = optScanner.readU32BEField('OPT ttl');
      const flags = ttl & 65535;
      edns = {
        udpPayloadSize,
        dnssecOk: (flags & 32768) !== 0,
        extendedRcode: ttl >>> 24 & 255,
        version: ttl >>> 16 & 255,
        flags
      };
      continue;
    }
    additionals.push(record);
  }
  return { id, flags, rcode, truncated, answers, authorities, additionals, edns };
}

function formatIPv6(bytes16: Uint8Array): string {
  const SOCKADDR_IN6_SIZE = 28;
  const buf = new ArrayBuffer(SOCKADDR_IN6_SIZE);
  const view = new DataView(buf);
  if (isDarwin) {
    view.setUint8(0, SOCKADDR_IN6_SIZE);
    view.setUint8(1, sock.AF_INET6);
  } else {
    view.setUint16(0, sock.AF_INET6, true);
  }
  new Uint8Array(buf, 8, 16).set(bytes16.subarray(0, 16));
  const addr = sock.decodeAddr(buf);
  if ('ip' in addr && typeof addr.ip === 'string') return addr.ip;
  return '';
}

export function _reverseIP(ip: string): string {
  if (ip.includes(':')) return ipv6ToPtrName(ip);
  return ip.split('.').reverse().join('.') + '.in-addr.arpa';
}

function ipv6ToPtrName(ip: string): string {
  const halves = ip.split('::');
  let groups: string[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - left.length - right.length;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  } else {
    groups = ip.split(':');
  }
  const hex = groups.map((g) => g.padStart(4, '0')).join('');
  return hex.split('').reverse().join('.') + '.ip6.arpa';
}
