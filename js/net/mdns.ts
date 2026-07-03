/**
* fino:net/mdns — Multicast DNS and DNS-SD discovery helpers.
*
* Learn more:
* - Multicast DNS: https://www.rfc-editor.org/rfc/rfc6762
* - DNS-Based Service Discovery: https://www.rfc-editor.org/rfc/rfc6763
* - DNS message format: https://www.rfc-editor.org/rfc/rfc1035
*
* This module keeps mDNS separate from the unicast DNS resolver because mDNS
* has local-link trust rules, multicast sockets, cache semantics, and
* DNS-SD service lifecycles that do not belong in ordinary recursive DNS.
*
* This implementation supports one-shot host resolution, DNS-SD browse events,
* service resolution, and responder-backed publication. Multicast interface
* selection is available through `fino:net/socket`; deterministic tests may
* pass an explicit unicast `server` or bind `address`.
*
* ```ts no_run
* import { Mdns } from 'fino:net/mdns';
*
* const mdns = new Mdns();
* const addresses = await mdns.resolveHost('printer.local');
* await mdns.close();
* ```
*/
import * as sock from './socket.ts';
import * as loop from '../internal/runtime/loop.ts';
import { RECORD_TYPES, _buildQuery, _decodeName, _encodeName, _parseResponse } from './dns.ts';
import type { Address } from './socket.ts';
import type { DnsResourceRecord } from './dns.ts';

export type MdnsRecordType = 'A' | 'AAAA' | 'PTR' | 'SRV' | 'TXT';

export interface MdnsQueryOptions {
  /** Query timeout in milliseconds. Defaults to 2500. */
  timeoutMs?: number;
  /** Minimum delay before retransmitting unanswered one-shot queries. Defaults to 250. */
  retryMinMs?: number;
  /** Maximum delay before retransmitting unanswered one-shot queries. Defaults to 1000. */
  retryMaxMs?: number;
  /** Additional milliseconds to collect answer bursts after the first packet. Defaults to 20. */
  settleMs?: number;
  /** Local UDP address to bind for the query or continuous browse socket. */
  bindAddress?: Address;
  /** IPv4 interface address used for multicast membership and outbound packets. */
  interfaceAddress?: string;
  /** IPv6 interface index used for multicast membership and outbound packets. */
  interfaceIndex?: number;
  /** Set the mDNS QU bit to request a unicast response when supported. */
  unicastResponse?: boolean;
  /** Known answers to include in outgoing mDNS queries for responder suppression. */
  knownAnswers?: readonly DnsResourceRecord[];
  /** Use the instance cache for fresh answers. Defaults to true. */
  cache?: boolean;
  /** Validate response source addresses against local interface metadata. */
  validateSource?: boolean;
  /** Interface metadata used for source validation. Defaults to `networkInterfaces()`. */
  localInterfaces?: readonly sock.NetworkInterface[];
  /** Override destination for deterministic tests or controlled relays. */
  server?: Address;
  /** Abort a long-running query or browse operation. */
  signal?: AbortSignal;
  /** Keep `browse()` alive and emit later `up`/`down` events. */
  continuous?: boolean;
  /** Resolve service metadata for browse events and emit updates when it changes. */
  resolve?: boolean;
  /** Delay between continuous browse refresh queries. Defaults to 1000. */
  pollMs?: number;
}
export interface MdnsBrowseEvent {
  /** Event kind for service lifetime changes. */
  type: 'up' | 'update' | 'down';
  /** Service instance name, such as `Printer._http._tcp.local`. */
  name: string;
  /** Browsed service type, such as `_http._tcp.local`. */
  serviceType: string;
  /** Interface index when known. */
  interfaceIndex: number | null;
  /** Resolved service metadata when browse runs with `resolve: true`. */
  service?: MdnsService;
}
export interface MdnsService {
  /** Service instance name. */
  name: string;
  /** SRV target hostname. */
  target: string;
  /** SRV target port. */
  port: number;
  /** DNS-SD TXT attributes keyed case-insensitively. */
  txt: Map<string, Uint8Array | true>;
  /** A/AAAA addresses resolved for `target`. */
  addresses: string[];
  /** Interface index when known. */
  interfaceIndex: number | null;
}
export interface MdnsPublishService {
  /** Instance label without the service type, such as `Printer`. */
  name: string;
  /** DNS-SD service type, such as `_http._tcp.local`. */
  serviceType: string;
  /** SRV target hostname. */
  target: string;
  /** SRV target port. */
  port: number;
  /** TXT attributes. String values encode as UTF-8; `true` encodes as a boolean key. */
  txt?: Record<string, string | Uint8Array | true>;
  /** Target A/AAAA addresses. */
  addresses?: string[];
  /** Target A/AAAA addresses to use for specific interface indexes. */
  addressesByInterface?: Record<number, string[]>;
}
export interface MdnsPublishOptions {
  /** Bind address for the responder. Defaults to IPv4 mDNS port 5353. */
  address?: Address;
  /** Join the mDNS multicast group for the bound address family. Defaults to true only for the default bind address. */
  multicast?: boolean;
  /** IPv4 interface address used for multicast membership and outbound packets. */
  interfaceAddress?: string;
  /** IPv6 interface index used for multicast membership and outbound packets. */
  interfaceIndex?: number;
  /** Probe this destination for conflicting service records before publishing. */
  probeAddress?: Address;
  /** Probe response timeout in milliseconds. Defaults to 250. */
  probeTimeoutMs?: number;
  /** Conflict handling after probing. Defaults to rejecting the publish call. */
  conflictResolution?: 'reject' | 'rename';
  /** Maximum automatic rename attempts when `conflictResolution` is `rename`. Defaults to 5. */
  maxRenameAttempts?: number;
  /** Send an unsolicited announcement packet to this destination after binding. */
  announceAddress?: Address;
  /** Send goodbye records to this destination on close in addition to known queriers. */
  goodbyeAddress?: Address;
  /** Aggregate matching responses for this many milliseconds before sending. Defaults to immediate replies. */
  responseDelayMs?: number;
}
export interface MdnsRegistration {
  /** Bound UDP address for the responder. */
  readonly address: Address;
  /** Final DNS-SD service instance name. This may include an automatic rename suffix. */
  readonly name: string;
  /** Stop answering and close the UDP socket. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

const MDNS_IPV4: Address = { family: 'ipv4', ip: '224.0.0.251', port: 5353 };
const MDNS_IPV6: Address = { family: 'ipv6', ip: 'ff02::fb', port: 5353 };
const DUPLICATE_QUESTION_SUPPRESSION_MS = 1000;

function timeoutError(name: string): Error {
  const err = new Error(`mdns: query timed out for '${name}'`);
  (err as { code?: string }).code = 'ETIMEOUT';
  return err;
}

function wildcardAddress(family: 'ipv4' | 'ipv6', port = 0): Address {
  return family === 'ipv6' ? { family: 'ipv6', ip: '::', port } : { family: 'ipv4', ip: '0.0.0.0', port };
}
function receivePacket(fd: number, usePacketInfo: boolean): {
  data: Uint8Array;
  addr: Address | sock.UnknownAddress;
  destination?: Address;
  interfaceIndex?: number;
} | number {
  return usePacketInfo ? sock.recvmsgPacketInfo(fd, 9000) : sock.recvfrom(fd, 9000);
}
type MulticastMembership = {
  interfaceAddress?: string;
  interfaceIndex?: number;
};
type MulticastOptions = {
  interfaceAddress?: string;
  interfaceIndex?: number;
};
function multicastMemberships(family: 'ipv4' | 'ipv6', options: MulticastOptions): MulticastMembership[] {
  if (family === 'ipv4' && options.interfaceAddress !== undefined) return [{ interfaceAddress: options.interfaceAddress }];
  if (options.interfaceIndex !== undefined) return [{ interfaceIndex: options.interfaceIndex }];
  const interfaces = sock.networkInterfaces().filter((iface) => {
    if (iface.up === false || iface.multicast === false) return false;
    if (iface.loopback === true) return false;
    if (iface.addresses === undefined || iface.addresses.length === 0) return true;
    return iface.addresses.some((address) => address.family === family);
  });
  if (family === 'ipv4') {
    const addresses = new Set<string>();
    for (const iface of interfaces) {
      for (const address of iface.addresses ?? []) {
        if (address.family !== 'ipv4' || address.ip === '0.0.0.0' || address.ip.startsWith('127.')) continue;
        addresses.add(address.ip);
      }
    }
    return addresses.size === 0 ? [{}] : [...addresses].map((interfaceAddress) => ({ interfaceAddress }));
  }
  const indices = [...new Set(interfaces.map((iface) => iface.index).filter((index) => Number.isInteger(index) && index > 0))];
  return indices.length === 0 ? [{}] : indices.map((interfaceIndex) => ({ interfaceIndex }));
}
function joinMdnsMulticast(fd: number, family: 'ipv4' | 'ipv6', options: MulticastOptions): MulticastMembership[] {
  const group = family === 'ipv6' ? MDNS_IPV6.ip : MDNS_IPV4.ip;
  const joined: MulticastMembership[] = [];
  let lastError: unknown;
  for (const membership of multicastMemberships(family, options)) {
    try {
      sock.joinMulticastGroup(fd, {
        group,
        interfaceAddress: membership.interfaceAddress,
        interfaceIndex: membership.interfaceIndex
      });
      joined.push(membership);
    } catch (error) {
      lastError = error;
    }
  }
  if (joined.length === 0 && lastError !== undefined) throw lastError;
  return joined;
}
function leaveMdnsMulticast(fd: number, family: 'ipv4' | 'ipv6', memberships: readonly MulticastMembership[]): void {
  const group = family === 'ipv6' ? MDNS_IPV6.ip : MDNS_IPV4.ip;
  for (const membership of memberships) {
    try {
      sock.leaveMulticastGroup(fd, {
        group,
        interfaceAddress: membership.interfaceAddress,
        interfaceIndex: membership.interfaceIndex
      });
    } catch {}
  }
}
function sendMdnsPacket(fd: number, packet: Uint8Array, family: 'ipv4' | 'ipv6', memberships: readonly MulticastMembership[], server?: Address): void {
  if (server !== undefined) {
    sock.sendto(fd, packet, server);
    return;
  }
  let sent = false;
  let lastError: unknown;
  const targets = memberships.length === 0 ? [{}] : memberships;
  for (const membership of targets) {
    try {
      sock.setMulticastOptions(fd, {
        family,
        interfaceAddress: membership.interfaceAddress,
        interfaceIndex: membership.interfaceIndex
      });
      const destination = family === 'ipv6' && membership.interfaceIndex !== undefined ? {
        family: 'ipv6' as const,
        ip: MDNS_IPV6.ip,
        port: MDNS_IPV6.port,
        scopeId: membership.interfaceIndex
      } : family === 'ipv6' ? MDNS_IPV6 : MDNS_IPV4;
      sock.sendto(fd, packet, destination);
      sent = true;
    } catch (error) {
      lastError = error;
    }
  }
  if (!sent && lastError !== undefined) throw lastError;
}
function retryDelay(options: MdnsQueryOptions): number {
  const min = Math.max(1, Math.floor(options.retryMinMs ?? 250));
  const max = Math.max(min, Math.floor(options.retryMaxMs ?? 1000));
  return min + Math.floor(Math.random() * (max - min + 1));
}
function mdnsQueryPacket(name: string, type: number, unicastResponse: boolean | undefined): Uint8Array {
  return mdnsQueryPacketWithKnownAnswers(name, type, unicastResponse, []);
}
function mdnsQueryPacketWithKnownAnswers(name: string, type: number, unicastResponse: boolean | undefined, knownAnswers: readonly DnsResourceRecord[] | undefined): Uint8Array {
  const packet = _buildQuery(0, name, type);
  const decoded = _decodeName(packet, 12);
  if ((knownAnswers?.length ?? 0) === 0) {
    if (unicastResponse !== true) return packet;
    const out = packet.slice();
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(decoded.nextOffset + 2, 0x8001, false);
    return out;
  }
  const questionEnd = decoded.nextOffset + 4;
  const out: number[] = Array.from(packet.slice(0, questionEnd));
  for (const answer of knownAnswers ?? []) {
    out.push(..._encodeName(answer.name));
    pushU16(out, answer.type);
    pushU16(out, answer.classCode);
    pushU32(out, answer.ttl);
    pushU16(out, answer.rawData.byteLength);
    out.push(...answer.rawData);
  }
  const result = new Uint8Array(out);
  const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
  resultView.setUint16(4, 1, false);
  resultView.setUint16(6, knownAnswers?.length ?? 0, false);
  if (unicastResponse === true) resultView.setUint16(decoded.nextOffset + 2, 0x8001, false);
  return result;
}
function recordKey(record: DnsResourceRecord): string {
  return `${record.name}/${record.type}/${record.classCode}/${String(record.data)}`;
}
function recordsKey(records: readonly DnsResourceRecord[]): string {
  return records.map(recordKey).sort().join('|');
}
function serviceKey(service: MdnsService | undefined): string {
  if (service === undefined) return '';
  const txt = [...service.txt.entries()].map(([key, value]) => `${key}=${value === true ? 'true' : Array.from(value).join('.')}`).sort().join('&');
  return `${service.target}/${service.port}/${service.addresses.slice().sort().join(',')}/${txt}`;
}
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    out = (out << 8 | value) >>> 0;
  }
  return out >>> 0;
}
function sameIpv4Link(source: string, address: string, mask: string): boolean {
  const src = ipv4ToInt(source);
  const addr = ipv4ToInt(address);
  const netmask = ipv4ToInt(mask);
  return src !== null && addr !== null && netmask !== null && ((src & netmask) >>> 0) === ((addr & netmask) >>> 0);
}
function isLocalLinkSource(address: Address | sock.UnknownAddress, options: MdnsQueryOptions): boolean {
  if (address.family !== 'ipv4' && address.family !== 'ipv6') return false;
  if (options.localInterfaces === undefined) {
    if (address.family === 'ipv4' && (address.ip.startsWith('127.') || address.ip.startsWith('169.254.'))) return true;
    if (address.family === 'ipv6' && (address.ip === '::1' || address.ip.toLowerCase().startsWith('fe80:'))) return true;
  }
  const interfaces = options.localInterfaces ?? sock.networkInterfaces();
  for (const iface of interfaces) {
    if (iface.up === false) continue;
    const addrs = iface.addresses ?? [];
    const masks = iface.netmasks ?? [];
    for (let i = 0; i < addrs.length; i++) {
      const local = addrs[i]!;
      const mask = masks[i];
      if (address.family === 'ipv4' && local.family === 'ipv4' && mask?.family === 'ipv4' && sameIpv4Link(address.ip, local.ip, mask.ip)) return true;
      if (address.family === 'ipv6' && local.family === 'ipv6' && (address.scopeId === undefined || address.scopeId === iface.index || address.scopeId === local.scopeId)) return true;
    }
  }
  return false;
}
async function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const timeout = loop.timeout(ms);
  let onAbort: (() => void) | null = null;
  let aborted = false;
  const abort = signal === undefined ? null : new Promise<false>((resolve) => {
    onAbort = () => {
      aborted = true;
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const result = await Promise.race([timeout.then(() => true), abort ?? new Promise<never>(() => {})]);
  timeout.cancel();
  if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  return result && !aborted;
}
function txtMap(records: DnsResourceRecord[]): Map<string, Uint8Array | true> {
  const out = new Map<string, Uint8Array | true>();
  const encoder = new TextEncoder();
  for (const record of records) {
    if (record.type !== RECORD_TYPES.TXT || !Array.isArray(record.data)) continue;
    for (const raw of record.data) {
      const eq = raw.indexOf('=');
      const key = (eq < 0 ? raw : raw.slice(0, eq)).toLowerCase();
      if (!key || out.has(key)) continue;
      out.set(key, eq < 0 ? true : encoder.encode(raw.slice(eq + 1)));
    }
  }
  return out;
}
function pushU16(out: number[], value: number): void {
  out.push(value >> 8 & 255, value & 255);
}
function pushU32(out: number[], value: number): void {
  out.push(value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255);
}
function txtRdata(txt: Record<string, string | Uint8Array | true> | undefined): number[] {
  const out: number[] = [];
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(txt ?? {})) {
    const bytes = value === true ? encoder.encode(key) : value instanceof Uint8Array ? new Uint8Array([...encoder.encode(key + '='), ...value]) : encoder.encode(key + '=' + value);
    if (bytes.byteLength > 255) throw new RangeError('mdns: TXT attribute is longer than 255 bytes');
    out.push(bytes.byteLength, ...bytes);
  }
  if (out.length === 0) out.push(0);
  return out;
}
function addressRecordType(address: string): number {
  return address.includes(':') ? RECORD_TYPES.AAAA : RECORD_TYPES.A;
}
function addressRdata(address: string): number[] {
  if (!address.includes(':')) return address.split('.').map((part) => Number(part));
  if (address === '::1') return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  throw new Error('mdns: IPv6 publisher currently supports ::1 in JS responder fixtures');
}
type ResponseRecord = {
  name: string;
  type: number;
  ttl: number;
  cacheFlush?: boolean;
  rdata: number[];
};
function buildResponse(query: Uint8Array, records: ResponseRecord[]): Uint8Array {
  const id = new DataView(query.buffer, query.byteOffset, query.byteLength).getUint16(0, false);
  const questionEnd = _decodeName(query, 12).nextOffset + 4;
  const question = query.slice(12, questionEnd);
  return buildPacket(id, question, records);
}
function buildPacket(id: number, question: Uint8Array | null, records: ResponseRecord[]): Uint8Array {
  const out: number[] = [];
  pushU16(out, id);
  pushU16(out, 0x8400);
  pushU16(out, question === null ? 0 : 1);
  pushU16(out, records.length);
  pushU16(out, 0);
  pushU16(out, 0);
  if (question !== null) out.push(...question);
  for (const record of records) {
    out.push(..._encodeName(record.name));
    pushU16(out, record.type);
    pushU16(out, (record.cacheFlush ? 0x8000 : 0) | 1);
    pushU32(out, record.ttl);
    pushU16(out, record.rdata.length);
    out.push(...record.rdata);
  }
  return new Uint8Array(out);
}
function parseQuestion(packet: Uint8Array): { name: string; type: number } {
  const decoded = _decodeName(packet, 12);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return {
    name: decoded.name,
    type: view.getUint16(decoded.nextOffset, false)
  };
}
function parseKnownAnswers(packet: Uint8Array): DnsResourceRecord[] {
  try {
    return _parseResponse(packet).answers;
  } catch {
    return [];
  }
}
function isKnownAnswer(record: ResponseRecord, knownAnswers: DnsResourceRecord[], ptrData: string): boolean {
  for (const known of knownAnswers) {
    if (known.name !== record.name || known.type !== record.type) continue;
    if (known.ttl <= record.ttl / 2) continue;
    if (record.type === RECORD_TYPES.PTR && known.data !== ptrData) continue;
    return true;
  }
  return false;
}
function responseRecordKey(record: ResponseRecord): string {
  return `${record.name}/${record.type}/${record.ttl}/${record.rdata.join('.')}`;
}
function hasConflict(records: DnsResourceRecord[], instance: string, serviceType: string): boolean {
  for (const record of records) {
    if (record.ttl === 0) continue;
    if (record.type === RECORD_TYPES.PTR && record.name === serviceType && record.data === instance) return true;
    if ((record.type === RECORD_TYPES.SRV || record.type === RECORD_TYPES.TXT) && record.name === instance) return true;
  }
  return false;
}
function renamedInstanceLabel(name: string, attempt: number): string {
  return `${name} (${attempt + 1})`;
}

/** Query-only mDNS client.
*
* Instances currently own no long-lived sockets; `close()` is present so the
* API can grow into browse and publish lifecycles without changing callers.
*/
export class Mdns {
  #closed = false;
  #cache = new Map<string, { expiresAt: number; records: DnsResourceRecord[] }>();

  #cacheKey(name: string, rrtype: MdnsRecordType, options: MdnsQueryOptions): string {
    const family = options.server?.family === 'ipv6' ? 'ipv6' : 'ipv4';
    const server = options.server === undefined ? 'mdns' : `${options.server.family}/${'ip' in options.server ? options.server.ip : ''}/${'port' in options.server ? options.server.port : ''}`;
    return `${family}/${server}/${name}/${rrtype}`;
  }

  #getCached(name: string, rrtype: MdnsRecordType, options: MdnsQueryOptions): DnsResourceRecord[] | null {
    if (options.cache === false) return null;
    if ((options.knownAnswers?.length ?? 0) > 0) return null;
    const entry = this.#cache.get(this.#cacheKey(name, rrtype, options));
    if (entry === undefined) return null;
    if (entry.expiresAt <= Date.now()) {
      this.#cache.delete(this.#cacheKey(name, rrtype, options));
      return null;
    }
    return entry.records.slice();
  }

  #storeCache(name: string, rrtype: MdnsRecordType, options: MdnsQueryOptions, records: DnsResourceRecord[]): void {
    if (options.cache === false || records.length === 0) return;
    if ((options.knownAnswers?.length ?? 0) > 0) return;
    const ttl = Math.min(...records.filter((record) => record.ttl > 0).map((record) => record.ttl));
    if (!Number.isFinite(ttl)) return;
    this.#cache.set(this.#cacheKey(name, rrtype, options), {
      expiresAt: Date.now() + ttl * 1000,
      records: records.slice()
    });
  }

  /** Query records for a local-link name.
  *
  * Queries are sent over UDP and return parsed resource records from the
  * answer, authority, and additional sections. The default destination is the
  * standard mDNS multicast group for the selected family.
  */
  async query(name: string, rrtype: MdnsRecordType, options: MdnsQueryOptions = {}): Promise<DnsResourceRecord[]> {
    if (this.#closed) throw new Error('mdns: client is closed');
    if (options.signal?.aborted) throw options.signal.reason;
    const cached = this.#getCached(name, rrtype, options);
    if (cached !== null) return cached;
    const qtype = RECORD_TYPES[rrtype];
    const family = options.server?.family === 'ipv6' ? 'ipv6' : 'ipv4';
    const fd = sock.socket(family === 'ipv6' ? sock.AF_INET6 : sock.AF_INET, sock.SOCK_DGRAM, sock.IPPROTO_UDP);
    let memberships: MulticastMembership[] = [];
    try {
      sock.bind(fd, options.bindAddress ?? wildcardAddress(family));
      sock.setNonblocking(fd);
      if (options.server === undefined) {
        memberships = joinMdnsMulticast(fd, family, options);
        sock.setMulticastOptions(fd, { family, ttl: 255, loopback: true });
        sock.setsockopt(fd, family === 'ipv6' ? sock.IPPROTO_IPV6 : sock.IPPROTO_IP, family === 'ipv6' ? sock.IPV6_RECVPKTINFO : sock.IP_RECVPKTINFO, true);
      }
      const packet = mdnsQueryPacketWithKnownAnswers(name, qtype, options.unicastResponse, options.knownAnswers);
      sendMdnsPacket(fd, packet, family, memberships, options.server);
      const records: DnsResourceRecord[] = [];
      const seen = new Set<string>();
      const deadline = Date.now() + (options.timeoutMs ?? 2500);
      const settleMs = options.settleMs ?? 20;
      let nextRetry = Date.now() + retryDelay(options);
      while (!options.signal?.aborted) {
        const now = Date.now();
        if (records.length === 0 && now >= nextRetry && now < deadline) {
          sendMdnsPacket(fd, packet, family, memberships, options.server);
          nextRetry = now + retryDelay(options);
        }
        const waitUntil = records.length === 0 ? Math.min(deadline, nextRetry) : now + settleMs;
        const waitMs = Math.max(0, waitUntil - Date.now());
        if (waitMs === 0) break;
        const timeout = loop.timeout(waitMs);
        const readable = await Promise.race([loop.readable(fd).then(() => true, () => false), timeout.then(() => false)]);
        timeout.cancel();
        if (!readable) {
          loop.removeRead(fd);
          if (records.length === 0 && Date.now() < deadline) continue;
          break;
        }
        const received = receivePacket(fd, options.server === undefined);
        if (typeof received === 'number') continue;
        if ((options.validateSource ?? options.server === undefined) && !isLocalLinkSource(received.addr, options)) continue;
        const response = _parseResponse(received.data);
        for (const record of [...response.answers, ...response.authorities, ...response.additionals]) {
          const key = recordKey(record);
          if (seen.has(key)) continue;
          seen.add(key);
          records.push(record);
        }
      }
      if (options.signal?.aborted) throw options.signal.reason;
      if (records.length === 0) throw timeoutError(name);
      this.#storeCache(name, rrtype, options, records);
      return records;
    } finally {
      if (memberships.length > 0) leaveMdnsMulticast(fd, family, memberships);
      sock.close(fd);
    }
  }

  /** Resolve A and AAAA records for a `.local` hostname. */
  async resolveHost(name: string, options: MdnsQueryOptions = {}): Promise<string[]> {
    const records = await this.query(name, options.server?.family === 'ipv6' ? 'AAAA' : 'A', options);
    return records.filter((record) => record.type === RECORD_TYPES.A || record.type === RECORD_TYPES.AAAA).map((record) => String(record.data));
  }

  /** Browse a DNS-SD service type and yield service instance events.
  *
  * By default this performs one PTR query and yields unique `up` events. With
  * `continuous: true`, the iterator refreshes until aborted and emits `down`
  * when zero-TTL goodbye records or TTL expiry retire an instance.
  */
  browse(serviceType: string, options: MdnsQueryOptions = {}): AsyncIterable<MdnsBrowseEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const seen = new Map<string, { name: string; interfaceIndex: number | null; expiresAt: number; ttl: number; recordsKey: string; serviceKey: string }>();
        const eventsForRecords = async (records: DnsResourceRecord[], interfaceIndex: number | null = null): Promise<MdnsBrowseEvent[]> => {
          const events: MdnsBrowseEvent[] = [];
          const now = Date.now();
          for (const record of records) {
            if (record.type !== RECORD_TYPES.PTR || typeof record.data !== 'string') continue;
            const key = `${interfaceIndex ?? 0}/${record.data}`;
            if (record.ttl === 0) {
              if (seen.delete(key)) {
                events.push({
                  type: 'down' as const,
                  name: record.data,
                  serviceType,
                  interfaceIndex
                });
              }
              continue;
            }
            const previous = seen.get(key);
            const service = options.resolve === true ? await self.resolveService(record.data, { ...options, cache: false }).catch(() => undefined) : undefined;
            const nextServiceKey = serviceKey(service);
            const nextRecordsKey = recordsKey(records.filter((candidate) => candidate.name === record.data || candidate.name === service?.target));
            seen.set(key, { name: record.data, interfaceIndex, expiresAt: now + record.ttl * 1000, ttl: record.ttl, recordsKey: nextRecordsKey, serviceKey: nextServiceKey });
            if (previous === undefined) {
              events.push({
                type: 'up' as const,
                name: record.data,
                serviceType,
                interfaceIndex,
                ...service === undefined ? {} : { service }
              });
            } else if (previous.ttl !== record.ttl || previous.recordsKey !== nextRecordsKey || previous.serviceKey !== nextServiceKey) {
              events.push({
                type: 'update' as const,
                name: record.data,
                serviceType,
                interfaceIndex,
                ...service === undefined ? {} : { service }
              });
            }
          }
          for (const [key, entry] of [...seen]) {
            if (entry.expiresAt > now) continue;
            seen.delete(key);
            events.push({
              type: 'down' as const,
              name: entry.name,
              serviceType,
              interfaceIndex: entry.interfaceIndex
            });
          }
          return events;
        };
        if (options.continuous !== true) {
          const records = await self.query(serviceType, 'PTR', options);
          for (const event of await eventsForRecords(records)) yield event;
          return;
        }
        const family = options.server?.family === 'ipv6' || options.bindAddress?.family === 'ipv6' ? 'ipv6' : 'ipv4';
        const fd = sock.socket(family === 'ipv6' ? sock.AF_INET6 : sock.AF_INET, sock.SOCK_DGRAM, sock.IPPROTO_UDP);
        let memberships: MulticastMembership[] = [];
        try {
          sock.bind(fd, options.bindAddress ?? wildcardAddress(family));
          sock.setNonblocking(fd);
          const usePacketInfo = options.server === undefined;
          if (usePacketInfo) {
            memberships = joinMdnsMulticast(fd, family, options);
            sock.setMulticastOptions(fd, { family, ttl: 255, loopback: true });
            sock.setsockopt(fd, family === 'ipv6' ? sock.IPPROTO_IPV6 : sock.IPPROTO_IP, family === 'ipv6' ? sock.IPV6_RECVPKTINFO : sock.IP_RECVPKTINFO, true);
          }
          const query = mdnsQueryPacketWithKnownAnswers(serviceType, RECORD_TYPES.PTR, options.unicastResponse, options.knownAnswers);
          let nextPoll = 0;
          const pollMs = options.pollMs ?? 1000;
          while (!self.#closed && !options.signal?.aborted) {
            const now = Date.now();
            if (now >= nextPoll) {
              sendMdnsPacket(fd, query, family, memberships, options.server);
              nextPoll = now + pollMs;
            }
            const waitMs = Math.max(1, Math.min(nextPoll - Date.now(), pollMs));
            const timeout = loop.timeout(waitMs);
            const readable = await Promise.race([loop.readable(fd).then(() => true, () => false), timeout.then(() => false)]);
            timeout.cancel();
            if (!readable) {
              loop.removeRead(fd);
              for (const event of await eventsForRecords([])) yield event;
              continue;
            }
            const packet = receivePacket(fd, usePacketInfo);
            if (typeof packet === 'number') continue;
            if ((options.validateSource ?? usePacketInfo) && !isLocalLinkSource(packet.addr, options)) continue;
            const response = _parseResponse(packet.data);
            const records = [...response.answers, ...response.authorities, ...response.additionals];
            for (const event of await eventsForRecords(records, packet.interfaceIndex ?? null)) yield event;
          }
        } finally {
          if (memberships.length > 0) leaveMdnsMulticast(fd, family, memberships);
          sock.close(fd);
        }
      }
    };
  }

  /** Resolve a DNS-SD service instance into a connection target. */
  async resolveService(instance: string, options: MdnsQueryOptions = {}): Promise<MdnsService> {
    const srvRecords = await this.query(instance, 'SRV', options);
    const srv = srvRecords.find((record) => record.type === RECORD_TYPES.SRV && typeof record.data === 'object' && record.data !== null && 'port' in record.data);
    if (srv === undefined) throw new Error(`mdns: no SRV record for '${instance}'`);
    const data = srv.data as { port: number; name: string };
    let txtRecords = srvRecords.filter((record) => record.type === RECORD_TYPES.TXT && record.name === instance);
    if (txtRecords.length === 0) txtRecords = await this.query(instance, 'TXT', options).catch(() => []);
    let addresses = srvRecords.filter((record) => (record.type === RECORD_TYPES.A || record.type === RECORD_TYPES.AAAA) && record.name === data.name).map((record) => String(record.data));
    if (addresses.length === 0) addresses = await this.resolveHost(data.name, options).catch(() => []);
    return {
      name: instance,
      target: data.name,
      port: data.port,
      txt: txtMap(txtRecords),
      addresses,
      interfaceIndex: null
    };
  }

  /** Publish a DNS-SD service from a UDP responder.
  *
  * The responder answers PTR, SRV, TXT, A, and AAAA questions for the supplied
  * service. Multicast publication automatically joins known IPv6 interfaces
  * when no explicit `interfaceIndex` is provided. `probeAddress`,
  * `announceAddress`, and `goodbyeAddress` provide deterministic hooks for
  * conflict checks and lifecycle packets in tests.
  */
  async publish(service: MdnsPublishService, options: MdnsPublishOptions = {}): Promise<MdnsRegistration> {
    if (this.#closed) throw new Error('mdns: client is closed');
    const address = options.address ?? { family: 'ipv4' as const, ip: '0.0.0.0', port: 5353 };
    const multicast = options.multicast ?? options.address === undefined;
    const fd = sock.socket(address.family === 'ipv6' ? sock.AF_INET6 : sock.AF_INET, sock.SOCK_DGRAM, sock.IPPROTO_UDP);
    sock.setsockopt(fd, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(fd, address);
    sock.setNonblocking(fd);
    let memberships: MulticastMembership[] = [];
    if (multicast) {
      memberships = joinMdnsMulticast(fd, address.family, options);
      sock.setMulticastOptions(fd, {
        family: address.family,
        ttl: 255,
        loopback: true,
        interfaceAddress: options.interfaceAddress,
        interfaceIndex: options.interfaceIndex
      });
      sock.setsockopt(fd, address.family === 'ipv6' ? sock.IPPROTO_IPV6 : sock.IPPROTO_IP, address.family === 'ipv6' ? sock.IPV6_RECVPKTINFO : sock.IP_RECVPKTINFO, true);
    }
    const bound = sock.getsockname(fd);
    let instanceLabel = service.name;
    let instance = `${instanceLabel}.${service.serviceType}`;
    let closed = false;
    const peers = new Map<string, Address>();
    const pendingResponses = new Map<string, {
      peer: Address;
      records: Map<string, ResponseRecord>;
    }>();
    const pendingFlushes = new Set<Promise<void>>();
    const recentQuestions = new Map<string, number>();
    function peerKey(address: Address): string {
      return `${address.family}/${address.ip}/${address.port}`;
    }
    function questionKey(peer: Address, question: { name: string; type: number }): string {
      return `${peerKey(peer)}/${question.name}/${question.type}`;
    }
    function shouldSuppressQuestion(peer: Address, question: { name: string; type: number }): boolean {
      const now = Date.now();
      for (const [key, expiresAt] of [...recentQuestions]) {
        if (expiresAt <= now) recentQuestions.delete(key);
      }
      const key = questionKey(peer, question);
      const previous = recentQuestions.get(key);
      recentQuestions.set(key, now + DUPLICATE_QUESTION_SUPPRESSION_MS);
      return previous !== undefined && previous > now;
    }
    async function probeInstance(): Promise<void> {
      if (options.probeAddress === undefined) return;
      const maxAttempts = options.conflictResolution === 'rename' ? options.maxRenameAttempts ?? 5 : 0;
      for (let attempt = 0;; attempt++) {
        let conflicted = false;
        for (let probe = 0; probe < 3; probe++) {
          sock.sendto(fd, _buildQuery(0, instance, RECORD_TYPES.SRV), options.probeAddress);
          const timeout = loop.timeout(options.probeTimeoutMs ?? 250);
          const readable = await Promise.race([loop.readable(fd).then(() => true, () => false), timeout.then(() => false)]);
          timeout.cancel();
          if (!readable) {
            loop.removeRead(fd);
            continue;
          }
          const packet = multicast ? sock.recvmsgPacketInfo(fd, 9000) : sock.recvfrom(fd, 9000);
          if (typeof packet === 'number') continue;
          const response = _parseResponse(packet.data);
          const records = [...response.answers, ...response.authorities, ...response.additionals];
          if (hasConflict(records, instance, service.serviceType)) {
            conflicted = true;
            break;
          }
        }
        if (!conflicted) return;
        if (attempt >= maxAttempts) {
          sock.close(fd);
          const error = new Error(`mdns: service name conflict for '${instance}'`);
          (error as { code?: string }).code = 'EADDRINUSE';
          throw error;
        }
        instanceLabel = renamedInstanceLabel(service.name, attempt + 1);
        instance = `${instanceLabel}.${service.serviceType}`;
      }
    }
    function serviceAddresses(interfaceIndex: number | null): string[] {
      if (interfaceIndex !== null) {
        const specific = service.addressesByInterface?.[interfaceIndex];
        if (specific !== undefined) return specific;
      }
      return service.addresses ?? [];
    }
    function serviceRecords(ttl: number, ptrTtl = ttl, interfaceIndex: number | null = null): ResponseRecord[] {
      const records: ResponseRecord[] = [
        { name: service.serviceType, type: RECORD_TYPES.PTR, ttl: ptrTtl, rdata: Array.from(_encodeName(instance)) }
      ];
      const srvRdata: number[] = [];
      pushU16(srvRdata, 0);
      pushU16(srvRdata, 0);
      pushU16(srvRdata, service.port);
      srvRdata.push(..._encodeName(service.target));
      records.push({ name: instance, type: RECORD_TYPES.SRV, ttl, cacheFlush: true, rdata: srvRdata });
      records.push({ name: instance, type: RECORD_TYPES.TXT, ttl, cacheFlush: true, rdata: txtRdata(service.txt) });
      for (const ip of serviceAddresses(interfaceIndex)) {
        records.push({ name: service.target, type: addressRecordType(ip), ttl, cacheFlush: true, rdata: addressRdata(ip) });
      }
      return records;
    }
    function answersForQuestion(question: { name: string; type: number }, ttl: number, knownAnswers: DnsResourceRecord[], interfaceIndex: number | null): ResponseRecord[] {
      const all = serviceRecords(ttl, ttl, interfaceIndex);
      if (question.name === service.serviceType && question.type === RECORD_TYPES.PTR) {
        return all.filter((record) => record.type === RECORD_TYPES.PTR && !isKnownAnswer(record, knownAnswers, instance));
      }
      if (question.name === instance && question.type === RECORD_TYPES.SRV) {
        return all.filter((record) => record.type === RECORD_TYPES.SRV && !isKnownAnswer(record, knownAnswers, instance));
      }
      if (question.name === instance && question.type === RECORD_TYPES.TXT) {
        return all.filter((record) => record.type === RECORD_TYPES.TXT && !isKnownAnswer(record, knownAnswers, instance));
      }
      if (question.name === service.target && (question.type === RECORD_TYPES.A || question.type === RECORD_TYPES.AAAA)) {
        return all.filter((record) => record.name === service.target && record.type === question.type && !isKnownAnswer(record, knownAnswers, instance));
      }
      return [];
    }
    function sendAnswers(query: Uint8Array, peer: Address, answers: ResponseRecord[]): void {
      if (answers.length === 0) return;
      const delayMs = options.responseDelayMs ?? 0;
      if (delayMs <= 0) {
        sock.sendto(fd, buildResponse(query, answers), peer);
        return;
      }
      const key = peerKey(peer);
      let pending = pendingResponses.get(key);
      if (pending === undefined) {
        pending = { peer, records: new Map() };
        pendingResponses.set(key, pending);
        const flush = (async () => {
          await loop.timeout(delayMs);
          pendingFlushes.delete(flush);
          const current = pendingResponses.get(key);
          pendingResponses.delete(key);
          if (closed || current === undefined || current.records.size === 0) return;
          try {
            sock.sendto(fd, buildPacket(0, null, [...current.records.values()]), current.peer);
          } catch {}
        })();
        pendingFlushes.add(flush);
      }
      for (const answer of answers) pending.records.set(responseRecordKey(answer), answer);
    }
    await probeInstance();
    const done = (async () => {
      while (!closed) {
        const timeout = loop.timeout(20);
        const readable = await Promise.race([loop.readable(fd).then(() => true, () => false), timeout.then(() => false)]);
        timeout.cancel();
        if (!readable) loop.removeRead(fd);
        if (!readable || closed) continue;
        const packet = receivePacket(fd, multicast);
        if (typeof packet === 'number') continue;
        peers.set(peerKey(packet.addr as Address), packet.addr as Address);
        let question: { name: string; type: number };
        try {
          question = parseQuestion(packet.data);
        } catch {
          continue;
        }
        const knownAnswers = parseKnownAnswers(packet.data);
        const responseInterfaceIndex = packet.interfaceIndex ?? options.interfaceIndex ?? null;
        const answers = answersForQuestion(question, question.type === RECORD_TYPES.PTR ? 4500 : 120, knownAnswers, responseInterfaceIndex);
        if (answers.length > 0 && shouldSuppressQuestion(packet.addr as Address, question)) continue;
        sendAnswers(packet.data, packet.addr as Address, answers);
      }
    })();
    if (options.announceAddress !== undefined) {
      sock.sendto(fd, buildPacket(0, null, serviceRecords(120, 4500)), options.announceAddress);
    } else if (multicast) {
      sendMdnsPacket(fd, buildPacket(0, null, serviceRecords(120, 4500)), address.family, memberships);
    }
    return {
      address: bound as Address,
      name: instance,
      async close() {
        if (closed) return;
        const goodbye = buildPacket(0, null, serviceRecords(0));
        for (const peer of peers.values()) {
          try {
            sock.sendto(fd, goodbye, peer);
          } catch {}
        }
        if (options.goodbyeAddress !== undefined) {
          try {
            sock.sendto(fd, goodbye, options.goodbyeAddress);
          } catch {}
        } else if (multicast) {
          try {
            sendMdnsPacket(fd, goodbye, address.family, memberships);
          } catch {}
        }
        closed = true;
        if (memberships.length > 0) leaveMdnsMulticast(fd, address.family, memberships);
        sock.close(fd);
        await Promise.all([...pendingFlushes]);
        await done;
      },
      [Symbol.asyncDispose]() {
        return this.close();
      }
    };
  }

  /** Close the client.
  *
  * Query-only clients have no persistent resources today, but closed clients
  * reject future operations.
  */
  async close(): Promise<void> {
    this.#closed = true;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
