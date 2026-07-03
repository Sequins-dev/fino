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
  /** Override destination for deterministic tests or controlled relays. */
  server?: Address;
}
export interface MdnsBrowseEvent {
  /** Event kind. Query-only browse currently emits `up` events. */
  type: 'up' | 'update' | 'down';
  /** Service instance name, such as `Printer._http._tcp.local`. */
  name: string;
  /** Browsed service type, such as `_http._tcp.local`. */
  serviceType: string;
  /** Interface index when known. */
  interfaceIndex: number | null;
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
}
export interface MdnsPublishOptions {
  /** Bind address for the responder. Defaults to IPv4 mDNS port 5353. */
  address?: Address;
}
export interface MdnsRegistration {
  /** Bound UDP address for the responder. */
  readonly address: Address;
  /** Stop answering and close the UDP socket. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

const MDNS_IPV4: Address = { family: 'ipv4', ip: '224.0.0.251', port: 5353 };
const MDNS_IPV6: Address = { family: 'ipv6', ip: 'ff02::fb', port: 5353 };

function timeoutError(name: string): Error {
  const err = new Error(`mdns: query timed out for '${name}'`);
  (err as { code?: string }).code = 'ETIMEOUT';
  return err;
}

function queryAddress(server: Address | undefined, family: 'ipv4' | 'ipv6'): Address {
  if (server) return server;
  return family === 'ipv6' ? MDNS_IPV6 : MDNS_IPV4;
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

/** Query-only mDNS client.
*
* Instances currently own no long-lived sockets; `close()` is present so the
* API can grow into browse and publish lifecycles without changing callers.
*/
export class Mdns {
  #closed = false;

  /** Query records for a local-link name.
  *
  * Queries are sent over UDP and return parsed resource records from the
  * answer, authority, and additional sections. The default destination is the
  * standard mDNS multicast group for the selected family.
  */
  async query(name: string, rrtype: MdnsRecordType, options: MdnsQueryOptions = {}): Promise<DnsResourceRecord[]> {
    if (this.#closed) throw new Error('mdns: client is closed');
    const qtype = RECORD_TYPES[rrtype];
    const family = options.server?.family === 'ipv6' ? 'ipv6' : 'ipv4';
    const fd = sock.socket(family === 'ipv6' ? sock.AF_INET6 : sock.AF_INET, sock.SOCK_DGRAM, sock.IPPROTO_UDP);
    try {
      sock.bind(fd, family === 'ipv6' ? { family: 'ipv6', ip: '::', port: 0 } : { family: 'ipv4', ip: '0.0.0.0', port: 0 });
      sock.setNonblocking(fd);
      const packet = _buildQuery(0, name, qtype);
      sock.sendto(fd, packet, queryAddress(options.server, family));
      const timeout = loop.timeout(options.timeoutMs ?? 2500);
      const readable = loop.readable(fd).then(() => true);
      const ready = await Promise.race([readable, timeout.then(() => false)]);
      timeout.cancel();
      if (!ready) loop.removeRead(fd);
      if (!ready) throw timeoutError(name);
      const received = sock.recvfrom(fd, 9000);
      if (typeof received === 'number') throw timeoutError(name);
      const response = _parseResponse(received.data);
      return [...response.answers, ...response.authorities, ...response.additionals];
    } finally {
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
  * The current implementation performs one PTR query and yields `up` events
  * for returned instances. Future revisions can keep the iterator alive for
  * cache refreshes, goodbyes, and update events without changing the event
  * shape.
  */
  browse(serviceType: string, options: MdnsQueryOptions = {}): AsyncIterable<MdnsBrowseEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const records = await self.query(serviceType, 'PTR', options);
        for (const record of records) {
          if (record.type !== RECORD_TYPES.PTR || typeof record.data !== 'string') continue;
          yield {
            type: 'up' as const,
            name: record.data,
            serviceType,
            interfaceIndex: null
          };
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
    const txtRecords = await this.query(instance, 'TXT', options).catch(() => []);
    const addresses = await this.resolveHost(data.name, options).catch(() => []);
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
  * service. It is intentionally small and deterministic; full multicast
  * probing, conflict resolution, announcements, and goodbye packets remain the
  * next publication-hardening step.
  */
  async publish(service: MdnsPublishService, options: MdnsPublishOptions = {}): Promise<MdnsRegistration> {
    if (this.#closed) throw new Error('mdns: client is closed');
    const address = options.address ?? { family: 'ipv4' as const, ip: '0.0.0.0', port: 5353 };
    const fd = sock.socket(address.family === 'ipv6' ? sock.AF_INET6 : sock.AF_INET, sock.SOCK_DGRAM, sock.IPPROTO_UDP);
    sock.setsockopt(fd, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(fd, address);
    sock.setNonblocking(fd);
    const bound = sock.getsockname(fd);
    const instance = `${service.name}.${service.serviceType}`;
    let closed = false;
    const peers = new Map<string, Address>();
    function peerKey(address: Address): string {
      return `${address.family}/${address.ip}/${address.port}`;
    }
    function serviceRecords(ttl: number): ResponseRecord[] {
      const records: ResponseRecord[] = [
        { name: service.serviceType, type: RECORD_TYPES.PTR, ttl, rdata: Array.from(_encodeName(instance)) }
      ];
      const srvRdata: number[] = [];
      pushU16(srvRdata, 0);
      pushU16(srvRdata, 0);
      pushU16(srvRdata, service.port);
      srvRdata.push(..._encodeName(service.target));
      records.push({ name: instance, type: RECORD_TYPES.SRV, ttl, cacheFlush: true, rdata: srvRdata });
      records.push({ name: instance, type: RECORD_TYPES.TXT, ttl, cacheFlush: true, rdata: txtRdata(service.txt) });
      for (const ip of service.addresses ?? []) {
        records.push({ name: service.target, type: addressRecordType(ip), ttl, cacheFlush: true, rdata: addressRdata(ip) });
      }
      return records;
    }
    function answersForQuestion(question: { name: string; type: number }, ttl: number): ResponseRecord[] {
      const all = serviceRecords(ttl);
      if (question.name === service.serviceType && question.type === RECORD_TYPES.PTR) {
        return all.filter((record) => record.type === RECORD_TYPES.PTR);
      }
      if (question.name === instance && question.type === RECORD_TYPES.SRV) {
        return all.filter((record) => record.type === RECORD_TYPES.SRV);
      }
      if (question.name === instance && question.type === RECORD_TYPES.TXT) {
        return all.filter((record) => record.type === RECORD_TYPES.TXT);
      }
      if (question.name === service.target && (question.type === RECORD_TYPES.A || question.type === RECORD_TYPES.AAAA)) {
        return all.filter((record) => record.name === service.target && record.type === question.type);
      }
      return [];
    }
    const done = (async () => {
      while (!closed) {
        const timeout = loop.timeout(20);
        const readable = await Promise.race([loop.readable(fd).then(() => true, () => false), timeout.then(() => false)]);
        timeout.cancel();
        if (!readable) loop.removeRead(fd);
        if (!readable || closed) continue;
        const packet = sock.recvfrom(fd, 9000);
        if (typeof packet === 'number') continue;
        peers.set(peerKey(packet.addr as Address), packet.addr as Address);
        const question = parseQuestion(packet.data);
        const answers = answersForQuestion(question, question.type === RECORD_TYPES.PTR ? 4500 : 120);
        if (answers.length > 0) sock.sendto(fd, buildResponse(packet.data, answers), packet.addr as Address);
      }
    })();
    return {
      address: bound as Address,
      async close() {
        if (closed) return;
        for (const peer of peers.values()) {
          try {
            sock.sendto(fd, buildPacket(0, null, serviceRecords(0)), peer);
          } catch {}
        }
        closed = true;
        sock.close(fd);
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
