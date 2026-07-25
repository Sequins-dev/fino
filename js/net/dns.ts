/**
* fino:net/dns — async DNS resolution via the RFC 1035 wire protocol.
*
* DNS protocol specification: https://www.rfc-editor.org/rfc/rfc1035
*
* This module implements DNS resolution entirely in JS by speaking the DNS
* wire protocol directly over UDP sockets (from `fino:socket`) and falls back
* to DNS-over-TCP when a UDP response is marked truncated. It reads nameservers
* from `/etc/resolv.conf` via `fino:file`. No blocking libc calls are made —
* the entire resolution path is async and event-loop driven.
*
*
* ## Why not use libc getaddrinfo?
*
* `getaddrinfo(3)` is the standard libc function for DNS resolution, but it
* blocks the calling thread. Calling it from Fino would freeze the entire
* event loop for the duration of the DNS query — potentially hundreds of
* milliseconds. Using raw sockets lets us await readiness asynchronously via
* `loop.readable()` / `loop.writable()`, keeping the process responsive to
* other I/O while the query is in flight.
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
* Non-ASCII query labels are normalized to IDNA-style A-labels before wire
* encoding, so "café.example" is sent as "xn--caf-dma.example".
*
* DNS responses use **compression pointers** to avoid repeating domain names:
* a two-byte sequence starting with bits 11xxxxxx is a pointer to an earlier
* offset in the message. The internal decoder follows these pointers
* recursively, with a hop limit to prevent infinite loops from malformed
* responses.
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
* SRV, plus DNSSEC DS, DNSKEY, RRSIG, NSEC, NSEC3, and NSEC3PARAM records.
* Unknown types return raw bytes. Every parsed record also preserves exact
* `rawData` RDATA bytes for canonicalization and future validator use.
*
*
* ## DNSSEC wire support
*
* Passing `{ dnssec: true }` to `new Resolver()` or `lookup()` makes queries
* include an EDNS(0) OPT pseudo-record with the DNSSEC OK (DO) bit and a
* conservative 1232-byte UDP payload size. Responses parse EDNS metadata and
* DNSSEC record payloads locally. Signed positive answers are validated from
* embedded IANA root trust anchors. Bogus or indeterminate signed data, broken
* DS/DNSKEY chains, expired signatures, unsupported-only signatures, and
* missing denial proofs reject with `code: 'EDNSSEC'`. Provably insecure
* unsigned delegations are accepted after a signed DS-negative proof. The
* resolver never trusts upstream AD bits as proof. Unsupported DNSSEC signing
* algorithms still reject unless another supported signature validates.
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
* Search domains, `ndots`, rotate, sortlist, TTL-return APIs, and the broader
* Node `dns.Resolver` option matrix are intentionally outside this release
* baseline; this resolver sends explicit absolute names supplied by callers.
*
* Release validation keeps live resolver behavior behind an explicit
* `FINO_DNS_LIVE=1` test lane so the normal suite stays deterministic. That
* lane should exercise at least one public recursive resolver and one
* user-configured resolver from `setServers()`. The transport implementation
* intentionally speaks classic DNS over UDP with TCP fallback for truncated
* responses; DNS-over-TLS and DNS-over-HTTPS are not implemented by this
* module.
*
*
* ## TTL and cache policy
*
* Parsed resource records preserve the authoritative TTL from the packet, but
* ordinary `Resolver` lookups do not cache answers by TTL. Every `resolve()`
* call sends a fresh query unless it follows an in-response CNAME chain. The
* only cache maintained by this module is the DNSSEC delegation cache used
* while validating signed chains, and that cache stores DNSKEY/DS chain state
* separately from user-visible answer records.
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
* - Transaction IDs are generated with `crypto.getRandomValues()` and checked
*   against responses to reduce spoofing risk.
* - UDP datagrams may arrive out of order or be duplicates. We check that the
*   response ID matches the query ID and discard non-matching packets.
* - DNSSEC validation is opt-in. DNSSEC-enabled queries request validation
*   material with EDNS(0) DO, verify chains locally, and reject bogus or
*   indeterminate data with `EDNSSEC`.
*
* ```ts no_run
* import { Resolver } from 'fino:net/dns';
*
* const resolver = new Resolver({ timeout: 1_000, retries: 2 });
* resolver.setServers(['1.1.1.1', '8.8.8.8']);
* const addresses = await resolver.resolve('example.com', 'A');
* ```
*/
import * as sock from './socket.ts';
import * as loop from '../internal/runtime/loop.ts';
import { DiskFileSystem } from '../file/fs.ts';
import { decodeUtf8, encodeUtf8 } from 'internal:encoding';
import { os } from 'internal:process';
import { Scanner } from '../parsing/scanner.ts';
import { ROOT_TRUST_ANCHORS, validateDnssecResponse, type DnssecCache } from 'internal:net/dnssec';
/**
* Address family for a DNS nameserver endpoint.
*
* The resolver uses this value to choose the socket family when sending UDP
* queries or opening TCP fallback connections. `ipv4` addresses are dotted
* decimal literals, and `ipv6` addresses are numeric IPv6 literals.
*
* ```ts no_run
* import type { DnsServerFamily } from 'fino:net/dns';
*
* const family: DnsServerFamily = 'ipv4';
* ```
*/
export type DnsServerFamily = 'ipv4' | 'ipv6';
type RecordTypeName = keyof typeof RECORD_TYPES;
/**
* Parsed DNS nameserver endpoint used by `Resolver`.
*
* `Resolver.setServers()` accepts string forms such as `1.1.1.1`,
* `[2606:4700:4700::1111]:53`, or `8.8.8.8:53` and normalizes them into this
* endpoint shape internally. `Resolver.getServers()` returns the string form
* again for compatibility with familiar DNS resolver APIs.
*
* ```ts no_run
* import type { DnsServer } from 'fino:net/dns';
*
* const server: DnsServer = { ip: '1.1.1.1', family: 'ipv4', port: 53 };
* ```
*/
export interface DnsServer {
  /**
  * Numeric IPv4 or IPv6 address literal.
  *
  * Host names are not accepted here; recursive resolver endpoints must already
  * be concrete addresses.
  */
  ip: string;
  /**
  * Socket address family for `ip`.
  *
  * The family controls whether the resolver opens an IPv4 or IPv6 UDP/TCP
  * socket for this endpoint.
  */
  family: DnsServerFamily;
  /**
  * UDP and TCP DNS port.
  *
  * Classic DNS uses `53`. The same port is used for the initial UDP query and
  * TCP fallback when a response is truncated.
  */
  port: number;
}
interface DnsError extends Error {
  code?: string;
  hostname?: string;
}
/**
* Mail-exchanger DNS record payload returned for MX lookups.
*
* `priority` is the preference value from the DNS response; lower numbers are
* preferred. `exchange` is the mail host name exactly as decoded from the DNS
* packet and is not resolved to an address automatically.
*
* ```ts no_run
* import { Resolver } from 'fino:net/dns';
*
* const resolver = new Resolver();
* const [mx] = await resolver.resolve('example.com', 'MX');
* console.log(mx.priority, mx.exchange);
* ```
*/
export interface MxRecord {
  /**
  * MX preference value; lower values should be tried first.
  *
  * ```ts no_run
  * const best = records.sort((a, b) => a.priority - b.priority)[0];
  * ```
  */
  priority: number;
  /**
  * Mail exchanger host name. Resolve it separately with A or AAAA if needed.
  *
  * ```ts no_run
  * const addr = await resolver.resolve(mx.exchange, 'A');
  * ```
  */
  exchange: string;
}
/**
* Start-of-authority DNS record payload returned for SOA lookups.
*
* Timing fields are seconds from the authoritative record. Values are not
* interpreted or clamped by the resolver.
*
* ```ts no_run
* const [soa] = await new Resolver().resolve('example.com', 'SOA');
* console.log(soa.nsname, soa.serial);
* ```
*/
export interface SoaRecord {
  /** Primary authoritative nameserver for the zone.
  *
  * ```ts no_run
  * console.log(soa.nsname);
  * ```
  */
  nsname: string;
  /** Responsible mailbox encoded as a DNS name.
  *
  * ```ts no_run
  * console.log(soa.hostmaster);
  * ```
  */
  hostmaster: string;
  /** Zone serial number used by secondary nameservers.
  *
  * ```ts no_run
  * console.log(soa.serial);
  * ```
  */
  serial: number;
  /** Suggested refresh interval in seconds.
  *
  * ```ts no_run
  * console.log(soa.refresh);
  * ```
  */
  refresh: number;
  /** Suggested retry interval in seconds.
  *
  * ```ts no_run
  * console.log(soa.retry);
  * ```
  */
  retry: number;
  /** Zone expiry interval in seconds.
  *
  * ```ts no_run
  * console.log(soa.expire);
  * ```
  */
  expire: number;
  /** Minimum TTL field from the SOA record.
  *
  * ```ts no_run
  * console.log(soa.minttl);
  * ```
  */
  minttl: number;
}
/**
* Service-location DNS record payload returned for SRV lookups.
*
* The resolver returns records in wire order; callers that need RFC 2782
* selection should sort/group by priority and apply weighted selection.
*
* ```ts no_run
* const records = await new Resolver().resolve('_xmpp-server._tcp.example.com', 'SRV');
* for (const srv of records) console.log(srv.name, srv.port);
* ```
*/
export interface SrvRecord {
  /** SRV priority; lower values are preferred.
  *
  * ```ts no_run
  * const firstPriority = srv.priority;
  * ```
  */
  priority: number;
  /** SRV weight used for load distribution within a priority group.
  *
  * ```ts no_run
  * console.log(srv.weight);
  * ```
  */
  weight: number;
  /** TCP or UDP port advertised by the service.
  *
  * ```ts no_run
  * console.log(srv.port);
  * ```
  */
  port: number;
  /** Target host name for the service.
  *
  * ```ts no_run
  * const addrs = await resolver.resolve(srv.name, 'AAAA');
  * ```
  */
  name: string;
}
/**
* Delegation signer DNSSEC record payload.
*
* DS records bind a child zone DNSKEY to its parent zone. The digest is the
* raw hash from wire format; callers that display it commonly hex-encode it.
*
* ```ts no_run
* import { Resolver } from 'fino:net/dns';
*
* const [ds] = await new Resolver({ dnssec: true }).resolve('example.com', 'DS');
* const hex = Array.from(ds.digest, (b) => b.toString(16).padStart(2, '0')).join('');
* console.log(ds.keyTag, ds.algorithm, ds.digestType, hex);
* ```
*/
export interface DsRecord {
  /**
  * Key tag of the child DNSKEY this DS record identifies.
  *
  * The value is copied from the wire record and is used with `algorithm` and
  * `digestType` to select the matching DNSKEY during validation.
  */
  keyTag: number;
  /**
  * DNSSEC algorithm number for the referenced child DNSKEY.
  *
  * Algorithm numbers follow the IANA DNS Security Algorithm registry.
  */
  algorithm: number;
  /**
  * Digest algorithm number used to hash the child DNSKEY owner name and key.
  *
  * Common values include SHA-1 and SHA-256, but unsupported digest algorithms
  * remain visible here so callers can inspect the delegation.
  */
  digestType: number;
  /**
  * Raw DS digest bytes from RDATA.
  *
  * Display tools usually hex-encode this value. The resolver keeps bytes
  * unchanged for DNSSEC chain validation.
  */
  digest: Uint8Array;
}
/**
* DNSSEC DNSKEY record payload.
*
* DNSKEY records publish a zone's public signing keys. The resolver parses the
* raw key material and uses it with DS and RRSIG records when DNSSEC validation
* is enabled.
*
* ```ts no_run
* import { Resolver } from 'fino:net/dns';
*
* const keys = await new Resolver({ dnssec: true }).resolve('example.com', 'DNSKEY');
* for (const key of keys) {
*   const isKsk = (key.flags & 0x0001) !== 0;
*   console.log(key.algorithm, key.publicKey.byteLength, isKsk ? 'KSK' : 'ZSK');
* }
* ```
*/
export interface DnskeyRecord {
  /**
  * DNSKEY flags field.
  *
  * This includes bits such as Zone Key and Secure Entry Point. The resolver
  * exposes the numeric field unchanged.
  */
  flags: number;
  /**
  * DNSKEY protocol field.
  *
  * DNSSEC uses protocol value `3`; other values remain visible for malformed
  * or experimental records.
  */
  protocol: number;
  /**
  * DNSSEC algorithm number for this key.
  */
  algorithm: number;
  /**
  * Raw public key bytes from RDATA.
  *
  * The encoding is algorithm-specific and is not converted to a WebCrypto key
  * by the parser.
  */
  publicKey: Uint8Array;
}
/**
* DNSSEC RRSIG record payload.
*
* RRSIG records authenticate an RRset. Time fields are Unix epoch seconds from
* the wire record; the parser does not convert them to `Date` objects.
*
* ```ts no_run
* import { Resolver } from 'fino:net/dns';
*
* const [sig] = await new Resolver({ dnssec: true }).resolve('example.com', 'RRSIG');
* console.log(sig.typeCovered, sig.keyTag, new Date(sig.expiration * 1000).toISOString());
* ```
*/
export interface RrsigRecord {
  /**
  * Numeric record type covered by this signature.
  */
  typeCovered: number;
  /**
  * DNSSEC algorithm number used by the signing key.
  */
  algorithm: number;
  /**
  * Number of labels in the original signed owner name.
  *
  * This is used by DNSSEC wildcard handling.
  */
  labels: number;
  /**
  * Original TTL of the signed RRset in seconds.
  */
  originalTtl: number;
  /**
  * Signature expiration time as Unix epoch seconds.
  */
  expiration: number;
  /**
  * Signature inception time as Unix epoch seconds.
  */
  inception: number;
  /**
  * Key tag of the DNSKEY that produced this signature.
  */
  keyTag: number;
  /**
  * Signer name from RDATA.
  */
  signerName: string;
  /**
  * Raw signature bytes.
  *
  * The byte format depends on `algorithm`.
  */
  signature: Uint8Array;
}
/**
* DNSSEC NSEC authenticated-denial record payload.
*
* NSEC records prove non-existence by naming the next existing owner and a type
* bitmap for the current owner.
*
* ```ts no_run
* import { Resolver, RECORD_TYPES } from 'fino:net/dns';
*
* const [nsec] = await new Resolver({ dnssec: true }).resolve('example.com', 'NSEC');
* console.log(nsec.nextDomainName, nsec.types.includes(RECORD_TYPES.A));
* ```
*/
export interface NsecRecord {
  /**
  * Next existing owner name in canonical order.
  */
  nextDomainName: string;
  /**
  * Numeric RR types present at the NSEC owner name.
  */
  types: number[];
}
/**
* DNSSEC NSEC3 authenticated-denial record payload.
*
* NSEC3 records prove non-existence with hashed owner names. The parser exposes
* salt and hashed owner bytes directly so validation code can recompute the
* covered interval.
*
* ```ts no_run
* import { Resolver } from 'fino:net/dns';
*
* const [nsec3] = await new Resolver({ dnssec: true }).resolve('example.com', 'NSEC3');
* const optOut = (nsec3.flags & 0x01) !== 0;
* console.log(nsec3.hashAlgorithm, nsec3.iterations, nsec3.salt.byteLength, optOut);
* ```
*/
export interface Nsec3Record {
  /**
  * Hash algorithm number used for owner names.
  */
  hashAlgorithm: number;
  /**
  * NSEC3 flags field.
  *
  * This may include the opt-out bit for insecure delegations.
  */
  flags: number;
  /**
  * Number of additional hash iterations.
  */
  iterations: number;
  /**
  * Salt bytes used by the NSEC3 hash, or an empty array when no salt is set.
  */
  salt: Uint8Array;
  /**
  * Next hashed owner name bytes from RDATA.
  */
  nextHashedOwnerName: Uint8Array;
  /**
  * Numeric RR types present at the original owner name.
  */
  types: number[];
}
/**
* DNSSEC NSEC3PARAM record payload.
*
* NSEC3PARAM records publish the hash parameters a zone uses for NSEC3
* authenticated denial.
*
* ```ts no_run
* import { Resolver } from 'fino:net/dns';
*
* const [params] = await new Resolver({ dnssec: true }).resolve('example.com', 'NSEC3PARAM');
* console.log(params.hashAlgorithm, params.iterations, params.salt.byteLength);
* ```
*/
export interface Nsec3ParamRecord {
  /**
  * Hash algorithm number used for NSEC3 owner hashes.
  */
  hashAlgorithm: number;
  /**
  * NSEC3 parameter flags.
  */
  flags: number;
  /**
  * Number of additional hash iterations.
  */
  iterations: number;
  /**
  * Salt bytes used by the zone, or an empty array when no salt is configured.
  */
  salt: Uint8Array;
}
/**
* EDNS(0) metadata parsed from an OPT pseudo-record.
*
* EDNS extends the DNS header with a larger UDP payload size, an extended
* response code, a version, and feature flags such as DNSSEC OK. This metadata
* is present only when the response contains an OPT record, and it surfaces on
* the `edns` field of a parsed `DnsResponse`.
*
* ```ts no_run
* import type { DnsResponse } from 'fino:net/dns';
*
* function reportEdns(response: DnsResponse) {
*   if (!response.edns) return;
*   console.log(response.edns.udpPayloadSize, response.edns.dnssecOk);
* }
* ```
*/
export interface DnsEdnsMetadata {
  /**
  * UDP payload size advertised by the responder.
  */
  udpPayloadSize: number;
  /**
  * Whether the DNSSEC OK bit was set.
  *
  * A true value means the peer was willing to send DNSSEC records; it is not
  * proof that the answer was validated.
  */
  dnssecOk: boolean;
  /**
  * Extended response-code bits from the OPT record.
  */
  extendedRcode: number;
  /**
  * EDNS version number.
  */
  version: number;
  /**
  * Raw EDNS flags field.
  */
  flags: number;
}
/**
* Decoded DNS record payload for supported record types; unknown data is raw
* bytes and malformed or empty RDATA can surface as `null`.
*
* ```ts no_run
* const records = await new Resolver().resolve('example.com', 'TXT');
* for (const data of records) {
*   if (Array.isArray(data)) console.log(data.join(''));
* }
* ```
*/
export type DnsRecordData = string | string[] | MxRecord | SoaRecord | SrvRecord | DsRecord | DnskeyRecord | RrsigRecord | NsecRecord | Nsec3Record | Nsec3ParamRecord | Uint8Array | null;
/**
* Decoded DNS resource record from a response section.
*
* `type` is the numeric QTYPE, `ttl` is seconds, and `data` follows the shape
* documented by `DnsRecordData`. The resolver does not cache by TTL.
*
* ```ts no_run
* const answers = await new Resolver().resolve('example.com', 'A');
* for (const answer of answers) console.log(answer);
* ```
*/
export interface DnsResourceRecord {
  /** Owner name for this record.
  *
  * ```ts no_run
  * console.log(record.name);
  * ```
  */
  name: string;
  /** Numeric DNS record type, such as `RECORD_TYPES.A`.
  *
  * ```ts no_run
  * if (record.type === RECORD_TYPES.A) console.log(record.data);
  * ```
  */
  type: number;
  /** Record TTL in seconds.
  *
  * ```ts no_run
  * console.log(`cacheable for ${record.ttl}s`);
  * ```
  */
  ttl: number;
  /** DNS class code with protocol-specific high bits masked off.
  *
  * For ordinary IN records this is `1`. mDNS responses may set the high
  * cache-flush bit in the wire class field; this property stores only the
  * actual class value.
  */
  classCode: number;
  /** Whether the mDNS cache-flush bit was set in the RR class field. */
  cacheFlush: boolean;
  /** Exact RDATA bytes from the packet. */
  rawData: Uint8Array;
  /** Parsed record payload, or raw bytes for unsupported record types.
  *
  * ```ts no_run
  * if (record.data instanceof Uint8Array) console.log(record.data.byteLength);
  * ```
  */
  data: DnsRecordData;
}
/**
* Parsed DNS response packet.
*
* `rcode` exposes the low four bits of the DNS flags field. A non-zero value
* is converted to an error by `Resolver.resolve`, but parser tests can inspect
* it directly.
*
* ```ts no_run
* const records = await new Resolver().resolve('example.com', 'MX');
* console.log(records);
* ```
*/
export interface DnsResponse {
  /** Transaction ID copied from the DNS header.
  *
  * ```ts no_run
  * if (response.id !== queryId) throw new Error('spoofed response');
  * ```
  */
  id: number;
  /** Raw DNS flags field.
  *
  * ```ts no_run
  * const authoritative = Boolean(response.flags & 0x0400);
  * ```
  */
  flags: number;
  /** DNS response code; zero means no DNS-layer error.
  *
  * ```ts no_run
  * if (response.rcode === 3) console.log('not found');
  * ```
  */
  rcode: number;
  /** True when the DNS server marked the UDP response as truncated.
  *
  * ```ts no_run
  * if (response.truncated) console.log('retry over TCP if needed');
  * ```
  */
  truncated: boolean;
  /** Answer section records.
  *
  * ```ts no_run
  * for (const answer of response.answers) console.log(answer.data);
  * ```
  */
  answers: DnsResourceRecord[];
  /** Authority section records.
  *
  * ```ts no_run
  * console.log(response.authorities.length);
  * ```
  */
  authorities: DnsResourceRecord[];
  /** Additional section records.
  *
  * ```ts no_run
  * console.log(response.additionals.length);
  * ```
  */
  additionals: DnsResourceRecord[];
  /**
  * Parsed EDNS(0) metadata when the response contains an OPT pseudo-RR.
  *
  * Omitted for classic DNS responses without EDNS.
  */
  edns?: DnsEdnsMetadata;
}
/**
* Resolver timeout and retry controls.
*
* Defaults are `timeout: 5000` milliseconds and `retries: 2`. The timeout is
* applied per query attempt; after all servers and retries fail, resolution
* throws an `ETIMEOUT` error with the hostname attached.
*
* ```ts no_run
* const resolver = new Resolver({ timeout: 1000, retries: 1 });
* ```
*/
export interface ResolverOptions {
  /** Per-attempt timeout in milliseconds.
  *
  * ```ts no_run
  * const resolver = new Resolver({ timeout: 750 });
  * ```
  */
  timeout?: number;
  /** Number of retry rounds across the configured nameserver list.
  *
  * ```ts no_run
  * const resolver = new Resolver({ retries: 3 });
  * ```
  */
  retries?: number;
  /** Enable local DNSSEC validation and request DNSSEC records with EDNS(0) DO. */
  dnssec?: boolean;
}
/**
* Address-family preference for `lookup`.
*
* Omit `family` to prefer IPv4 first and then fall back to IPv6. Passing `4`
* or `6` queries only that family and throws if no address is found.
*
* ```ts no_run
* const result = await lookup('example.com', { family: 6 });
* ```
*/
export interface LookupOptions {
  /** Requested address family, or omitted for IPv4-then-IPv6 fallback.
  *
  * ```ts no_run
  * await lookup('example.com', { family: 4 });
  * ```
  */
  family?: 4 | 6;
  /** Enable local DNSSEC validation for this lookup. */
  dnssec?: boolean;
}
/**
* Primary address returned by `lookup`.
*
* The address string is already formatted for the family. IPv6 addresses use
* system `inet_ntop` formatting.
*
* ```ts no_run
* const { address, family } = await lookup('example.com');
* console.log(`${address} is IPv${family}`);
* ```
*/
export interface LookupResult {
  /** IP address string.
  *
  * ```ts no_run
  * console.log(result.address);
  * ```
  */
  address: string;
  /** Address family for `address`.
  *
  * ```ts no_run
  * if (result.family === 6) console.log('IPv6');
  * ```
  */
  family: 4 | 6;
}
const isDarwin = os === 'darwin';
// ---------------------------------------------------------------------------
// Record type constants
// ---------------------------------------------------------------------------
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
/**
* Map from supported DNS record type names to numeric QTYPE values.
*
* These constants are useful when building or parsing packets manually. Unknown
* record types can still be parsed, but public resolution is limited to these
* keys.
*
* ```ts no_run
* const aaaa = RECORD_TYPES.AAAA;
* console.log(aaaa);
* ```
*/
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
const RCODE_ERRORS: Partial<Record<number, {
  code: string;
  msg: string;
}>> = {
  1: {
    code: 'EFORMERR',
    msg: 'format error'
  },
  2: {
    code: 'ESERVFAIL',
    msg: 'server failure'
  },
  3: {
    code: 'ENOTFOUND',
    msg: 'domain not found'
  },
  4: {
    code: 'ENOTIMP',
    msg: 'not implemented'
  },
  5: {
    code: 'EREFUSED',
    msg: 'query refused'
  }
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
/**
* Parse resolver nameservers from `/etc/resolv.conf` text.
*
* This internal helper recognizes `nameserver` lines, ignores comments and
* unrelated directives, accepts IPv4 and IPv6 literals, and returns the
* built-in fallback list when no valid nameservers are present.
*
* @internal
*/
function _parseResolvConf(text: string): DnsServer[] {
  const servers: DnsServer[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/#.*/, '').trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[0] !== 'nameserver' || !parts[1]) continue;
    const ip = parts[1];
    if (isIpv4Literal(ip)) {
      servers.push({
        ip,
        family: 'ipv4',
        port: 53
      });
    } else if (isIpv6Literal(ip)) {
      servers.push({
        ip,
        family: 'ipv6',
        port: 53
      });
    }
  }
  return servers.length > 0 ? servers : DEFAULT_SERVERS.map((server) => ({ ...server }));
}
/**
* Return a cryptographically random DNS transaction ID in the range 1..65535.
*
* DNS permits zero on the wire, but the resolver keeps IDs non-zero to preserve
* the local helper contract used by tests and packet fixtures.
*
* @internal
*/
function _randomQueryId(): number {
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
// ---------------------------------------------------------------------------
// DNS wire protocol — encoder
// ---------------------------------------------------------------------------
/**
* Encode a domain name into DNS wire format (length-prefixed labels).
*
* A trailing root dot is accepted and stripped. Empty labels are skipped, and
* labels longer than 63 bytes throw. The returned buffer includes the terminal
* zero root label.
*
* ```ts no_run
* import { _encodeName } from 'fino:net/dns';
*
* const encoded = _encodeName('example.com.');
* console.log(encoded[0]); // 7
* ```
*
* Exported for unit testing.
*/
function _encodeName(name: string): Uint8Array {
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
  // out[pos] is 0 (already zeroed)
  return out;
}
/**
* Build a complete DNS query packet.
*
* The packet is a standard recursive IN query with one question and no answer,
* authority, or additional sections. `id` is written as a 16-bit field; callers
* should provide a random value and match it against the response.
*
* ```ts no_run
* import { _buildQuery, RECORD_TYPES } from 'fino:net/dns';
*
* const packet = _buildQuery(0x1234, 'example.com', RECORD_TYPES.A);
* ```
*
* Exported for unit testing.
*/
function _buildQuery(id: number, name: string, qtype: number, options: {
  dnssec?: boolean;
  udpPayloadSize?: number;
} = {}): Uint8Array {
  const encodedName = _encodeName(name);
  const addOpt = options.dnssec === true;
  const totalLen = 12 + encodedName.length + 4 + (addOpt ? 11 : 0);
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  // DNS header (12 bytes, big-endian)
  view.setUint16(0, id, false);
  view.setUint16(2, 256, false);
  view.setUint16(4, 1, false);
  if (addOpt) view.setUint16(10, 1, false);
  // ANCOUNT, NSCOUNT, ARCOUNT = 0 (already zero)
  // Question section
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
// ---------------------------------------------------------------------------
// DNS wire protocol — decoder
// ---------------------------------------------------------------------------
/**
* Decode a DNS name from wire format, following compression pointers.
*
* `nextOffset` is the byte immediately after the encoded name in the original
* stream. Compression pointer loops, out-of-range pointers, and truncated names
* throw `Error`.
*
* ```ts no_run
* import { _decodeName } from 'fino:net/dns';
*
* const { name, nextOffset } = _decodeName(message, 12);
* console.log(name, nextOffset);
* ```
*
* Exported for unit testing.
*/
function _decodeName(msg: Uint8Array, startOffset: number): {
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
      // Compression pointer (2 bytes): remaining 14 bits = offset into msg
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
      // Root label — end of name
      if (endOffset === -1) endOffset = scanner.offset;
      break;
    }
    if (scanner.remainingBytes < len) throw new Error('DNS: truncated label');
    parts.push(scanner.eatText(len, 'utf-8'));
  }
  return {
    name: parts.join('.'),
    nextOffset: endOffset
  };
}
/**
* Parse one DNS resource record from msg starting at offset.
* Returns { record, nextOffset } where nextOffset points past the record.
*/
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
  const classCode = rawClass & 32767;
  const cacheFlush = (rawClass & 32768) !== 0;
  const ttl = scanner.readU32BEField('resource record ttl');
  const rdlength = scanner.readU16BEField('resource record data length');
  const rdataStart = scanner.offset;
  const rdataEnd = rdataStart + rdlength;
  if (rdataEnd > msg.length) throw new Error('DNS: truncated resource record data');
  const rawData = msg.slice(rdataStart, rdataEnd);
  let data: DnsRecordData;
  switch (type) {
    case QTYPE_A: {
      if (rdlength !== 4) throw new Error('DNS: invalid A record length');
      data = `${msg[rdataStart]}.${msg[rdataStart + 1]}.${msg[rdataStart + 2]}.${msg[rdataStart + 3]}`;
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
      const exchange = _decodeName(msg, rdataStart + 2).name;
      data = {
        priority,
        exchange
      };
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
      data = {
        priority,
        weight,
        port,
        name: target
      };
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
      data = {
        typeCovered,
        algorithm,
        labels,
        originalTtl,
        expiration,
        inception,
        keyTag,
        signerName,
        signature: msg.slice(afterSigner, rdataEnd)
      };
      break;
    }
    case QTYPE_NSEC: {
      const { name: nextDomainName, nextOffset: afterNext } = _decodeName(msg, rdataStart);
      if (afterNext > rdataEnd) throw new Error('DNS: truncated NSEC record data');
      data = {
        nextDomainName,
        types: decodeTypeBitmap(msg.subarray(afterNext, rdataEnd))
      };
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
      data = {
        hashAlgorithm,
        flags,
        iterations,
        salt: rdata.eatBytes(saltLength)
      };
      break;
    }
    case QTYPE_OPT: {
      data = rawData;
      break;
    }
    default: {
      // Unknown type — return raw bytes
      data = msg.slice(rdataStart, rdataEnd);
      break;
    }
  }
  return {
    record: {
      name,
      type,
      classCode,
      cacheFlush,
      ttl,
      rawData,
      data
    },
    nextOffset: rdataEnd
  };
}
/**
* Parse a complete DNS response packet.
*
* This validates packet bounds and decodes supported RDATA shapes, but it does
* not verify that the response ID or question matches a query. Callers that use
* raw UDP should check `id` before trusting the records.
*
* ```ts no_run
* import { _parseResponse } from 'fino:net/dns';
*
* const parsed = _parseResponse(responseBytes);
* console.log(parsed.rcode, parsed.answers.length);
* ```
*
* Exported for unit testing.
*/
function _parseResponse(msg: Uint8Array): DnsResponse {
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
  // Skip question section (we trust the response matches our query)
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
  // Closure advances the shared response scanner past each RR.
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
  return {
    id,
    flags,
    rcode,
    truncated,
    answers,
    authorities,
    additionals,
    edns
  };
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
  const buf = new ArrayBuffer(SOCKADDR_IN6_SIZE);
  const view = new DataView(buf);
  if (isDarwin) {
    view.setUint8(0, SOCKADDR_IN6_SIZE);
    view.setUint8(1, sock.AF_INET6);
  } else {
    view.setUint16(0, sock.AF_INET6, true);
  }
  // bytes 2-3: port = 0 | bytes 4-7: flowinfo = 0
  new Uint8Array(buf, 8, 16).set(bytes16.subarray(0, 16));
  // bytes 24-27: scope_id = 0
  const addr = sock.decodeAddr(buf);
  if ('ip' in addr && typeof addr.ip === 'string') {
    return addr.ip;
  }
  return '';
}
/**
* Convert an IP address string to its PTR query name.
*
* IPv4 addresses become `in-addr.arpa` names. IPv6 addresses are expanded and
* nibble-reversed into `ip6.arpa` names. This helper does not validate IPv4
* octets or IPv6 syntax beyond the simple formatting logic.
*
* ```ts no_run
* import { _reverseIP } from 'fino:net/dns';
*
* console.log(_reverseIP('1.2.3.4')); // 4.3.2.1.in-addr.arpa
* ```
*
* Exported for unit testing.
*/
function _reverseIP(ip: string): string {
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
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - left.length - right.length;
    groups = [
      ...left,
      ...Array(fill).fill('0'),
      ...right
    ];
  } else {
    groups = ip.split(':');
  }
  const hex = groups.map((g) => g.padStart(4, '0')).join('');
  return hex.split('').reverse().join('.') + '.ip6.arpa';
}
// ---------------------------------------------------------------------------
// Result formatting per record type
// ---------------------------------------------------------------------------
function isStringRecord(record: DnsResourceRecord): record is DnsResourceRecord & {
  data: string;
} {
  return typeof record.data === 'string';
}
function isMxRecord(record: DnsResourceRecord): record is DnsResourceRecord & {
  data: MxRecord;
} {
  return record.data !== null && typeof record.data === 'object' && 'exchange' in record.data && 'priority' in record.data;
}
function formatRecords(records: DnsResourceRecord[], rrtype: RecordTypeName): DnsRecordData[] {
  switch (rrtype) {
    case 'A':
    case 'AAAA':
    case 'CNAME':
    case 'NS':
    case 'PTR': return records.filter(isStringRecord).map((r) => r.data);
    case 'MX': return records.filter(isMxRecord).map((r) => r.data);
    case 'TXT': return records.map((r) => r.data);
    case 'SOA': return records.length > 0 && records[0] ? [records[0].data] : [];
    case 'SRV': return records.map((r) => r.data);
    default: return records.map((r) => r.data);
  }
}
// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------
/**
* DNS resolver with configurable nameservers, timeout, and retries.
*
* The resolver lazily reads `/etc/resolv.conf` on first use, falls back to
* public IPv4 DNS servers if none are found, follows CNAME chains for A and
* AAAA lookups up to a fixed hop limit, and retries over TCP when a UDP
* response has the DNS truncated bit set. Set `dnssec: true` to request DNSSEC
* records with EDNS(0) DO and validate signed answers from the root trust
* anchor before returning them.
*
* ```ts no_run
* import { Resolver } from 'fino:net/dns';
*
* const resolver = new Resolver({ timeout: 1500 });
* const addrs = await resolver.resolve('example.com', 'A');
* ```
*/
export class Resolver {
  /**
  * Private property `#servers` used by `Resolver`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #servers = undefined;
  *
  *   readInternalState() {
  *     return this.#servers;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #servers: DnsServer[] | null;
  /**
  * Private property `#serversLoaded` used by `Resolver`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #serversLoaded = undefined;
  *
  *   readInternalState() {
  *     return this.#serversLoaded;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #serversLoaded: Promise<void> | null;
  /**
  * Private property `#timeout` used by `Resolver`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #timeout = undefined;
  *
  *   readInternalState() {
  *     return this.#timeout;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #timeout: number;
  /**
  * Private property `#retries` used by `Resolver`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #retries = undefined;
  *
  *   readInternalState() {
  *     return this.#retries;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #retries: number;
  #dnssec: boolean;
  #dnssecCache: DnssecCache;
  /**
  * Create a resolver.
  *
  * `timeout` defaults to 5000 ms and `retries` defaults to 2. Nameservers are
  * loaded lazily, so constructing a resolver performs no I/O.
  *
  * ```ts no_run
  * const resolver = new Resolver({ timeout: 1000, retries: 1 });
  * ```
  */
  constructor(opts: ResolverOptions = {}) {
    this.#servers = null;
    this.#serversLoaded = null;
    this.#timeout = opts.timeout ?? 5e3;
    this.#retries = opts.retries ?? 2;
    this.#dnssec = opts.dnssec === true;
    this.#dnssecCache = {
      entries: new Map(),
      maxEntries: 256
    };
  }
  // -------------------------------------------------------------------------
  // Nameserver management
  // -------------------------------------------------------------------------
  /**
  * Return the current list of nameserver IP addresses.
  *
  * If `setServers()` has not been called and `/etc/resolv.conf` has not been
  * loaded yet, this returns the built-in fallback server list. Non-default
  * ports are formatted as `ip:port` for IPv4 or `[ip]:port` for IPv6.
  *
  * ```ts no_run
  * const resolver = new Resolver();
  * console.log(resolver.getServers());
  * ```
  */
  getServers(): string[] {
    return (this.#servers ?? DEFAULT_SERVERS).map((s) => s.port !== 53 ? s.family === 'ipv6' ? `[${s.ip}]:${s.port}` : `${s.ip}:${s.port}` : s.ip);
  }
  /**
  * Override the nameserver list. Each entry is an IPv4 or IPv6 address string,
  * optionally with a port: '1.1.1.1', '1.1.1.1:5353', '[::1]:5353'.
  *
  * Passing an empty array throws. The entries are trusted as IP literals and
  * used for future queries; existing in-flight queries are not cancelled.
  *
  * ```ts no_run
  * const resolver = new Resolver();
  * resolver.setServers(['1.1.1.1', '[2606:4700:4700::1111]:53']);
  * ```
  */
  setServers(servers: string[]): void {
    if (!Array.isArray(servers) || servers.length === 0) {
      throw new Error('dns.setServers: expected a non-empty array of IP addresses');
    }
    this.#servers = servers.map((entry) => {
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
      return {
        ip,
        port,
        family: ip.includes(':') ? 'ipv6' as const : 'ipv4' as const
      };
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
  * Supported record names are the keys of `RECORD_TYPES`. A and AAAA lookups
  * follow CNAME chains up to 10 hops. DNS-layer errors throw with `code` and
  * `hostname` properties; no-answer responses resolve to an empty array.
  *
  * ```ts no_run
  * const resolver = new Resolver();
  * const addresses = await resolver.resolve('example.com', 'A');
  * ```
  */
  async resolve(hostname: string, rrtype: RecordTypeName = 'A'): Promise<DnsRecordData[]> {
    const qtypeNum = RECORD_TYPES[rrtype];
    // For A/AAAA, follow CNAME chains up to 10 hops
    const followCname = rrtype === 'A' || rrtype === 'AAAA';
    let name = hostname;
    for (let hop = 0; hop <= 10; hop++) {
      const response = await this.#sendQuery(name, qtypeNum);
      const direct = response.answers.filter((r) => r.type === qtypeNum);
      if (direct.length > 0) {
        return formatRecords(direct, rrtype);
      }
      if (followCname) {
        const cname = response.answers.find((r) => r.type === QTYPE_CNAME);
        if (cname && typeof cname.data === 'string') {
          name = cname.data;
          continue;
        }
      }
      return [];
    }
    const err: DnsError = new Error(`dns: too many CNAME hops for '${hostname}'`);
    err.code = 'ENODATA';
    err.hostname = hostname;
    throw err;
  }
  /**
  * Resolve IPv4 A records for a hostname.
  *
  * Returns an empty array when the name exists but has no A records. Throws on
  * DNS errors, timeout, malformed packets, or excessive CNAME hops.
  *
  * ```ts no_run
  * const addrs = await new Resolver().resolve4('example.com');
  * ```
  */
  async resolve4(hostname: string) {
    return this.resolve(hostname, 'A');
  }
  /**
  * Resolve IPv6 AAAA records for a hostname.
  *
  * The returned strings are formatted through `inet_ntop`; no zone IDs are
  * added. Throws on DNS errors or timeout.
  *
  * ```ts no_run
  * const addrs = await new Resolver().resolve6('example.com');
  * ```
  */
  async resolve6(hostname: string) {
    return this.resolve(hostname, 'AAAA');
  }
  /**
  * Resolve MX records for a hostname.
  *
  * Records are returned in DNS response order, not sorted by priority.
  *
  * ```ts no_run
  * const mx = await new Resolver().resolveMx('example.com');
  * ```
  */
  async resolveMx(hostname: string) {
    return this.resolve(hostname, 'MX');
  }
  /**
  * Resolve TXT records for a hostname.
  *
  * Each DNS TXT record is returned as an array of character strings because a
  * single TXT record can contain multiple length-prefixed strings.
  *
  * ```ts no_run
  * const txt = await new Resolver().resolveTxt('example.com');
  * ```
  */
  async resolveTxt(hostname: string) {
    return this.resolve(hostname, 'TXT');
  }
  /**
  * Resolve authoritative nameserver records for a hostname.
  *
  * ```ts no_run
  * const ns = await new Resolver().resolveNs('example.com');
  * ```
  */
  async resolveNs(hostname: string) {
    return this.resolve(hostname, 'NS');
  }
  /**
  * Resolve SRV service-location records.
  *
  * The resolver does not perform weighted target selection; callers should
  * apply SRV priority and weight rules themselves.
  *
  * ```ts no_run
  * const srv = await new Resolver().resolveSrv('_xmpp-server._tcp.example.com');
  * ```
  */
  async resolveSrv(hostname: string) {
    return this.resolve(hostname, 'SRV');
  }
  /**
  * Resolve SOA records for a zone name.
  *
  * Most zones return one SOA record, but the return shape is still an array to
  * match the generic resolver API.
  *
  * ```ts no_run
  * const [soa] = await new Resolver().resolveSoa('example.com');
  * ```
  */
  async resolveSoa(hostname: string) {
    return this.resolve(hostname, 'SOA');
  }
  /**
  * Resolve CNAME records for a hostname.
  *
  * This returns only CNAME answers; it does not follow the target to A or AAAA
  * addresses.
  *
  * ```ts no_run
  * const aliases = await new Resolver().resolveCname('www.example.com');
  * ```
  */
  async resolveCname(hostname: string) {
    return this.resolve(hostname, 'CNAME');
  }
  /**
  * Reverse DNS lookup.
  *
  * Converts IPv4 or IPv6 addresses to the appropriate PTR query name and
  * resolves PTR records. Invalid IP strings are not fully validated before the
  * query name is built.
  *
  * ```ts no_run
  * const names = await new Resolver().reverse('8.8.8.8');
  * ```
  */
  async reverse(ip: string): Promise<DnsRecordData[]> {
    return this.resolve(_reverseIP(ip), 'PTR');
  }
  // -------------------------------------------------------------------------
  // Private: nameserver loading
  // -------------------------------------------------------------------------
  /**
  * Private method `#ensureServers` used by `Resolver`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #ensureServers() {
  *     return 'ensureServers';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#ensureServers();
  *   }
  * }
  * ```
  *
  * @internal
  */
  async #ensureServers() {
    if (this.#servers !== null) return;
    if (!this.#serversLoaded) {
      this.#serversLoaded = this.#loadServers();
    }
    await this.#serversLoaded;
  }
  /**
  * Private method `#loadServers` used by `Resolver`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #loadServers() {
  *     return 'loadServers';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#loadServers();
  *   }
  * }
  * ```
  *
  * @internal
  */
  async #loadServers() {
    try {
      const fs = new DiskFileSystem();
      const text = new TextDecoder().decode(await fs.readFile('/etc/resolv.conf'));
      this.#servers = _parseResolvConf(text);
    } catch {
      this.#servers = DEFAULT_SERVERS;
    }
  }
  // -------------------------------------------------------------------------
  // Private: query execution
  // -------------------------------------------------------------------------
  /**
  * Send a DNS query and return the parsed response.
  * Tries each nameserver in order, with up to #retries total rounds.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #sendQuery() {
  *     return 'sendQuery';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#sendQuery();
  *   }
  * }
  * ```
  */
  async #sendQuery(name: string, qtype: number, validateDnssec = true): Promise<DnsResponse> {
    await this.#ensureServers();
    const id = _randomQueryId();
    const packet = _buildQuery(id, name, qtype, { dnssec: this.#dnssec });
    const TIMED_OUT = Symbol('timeout');
    const servers = this.#servers ?? DEFAULT_SERVERS;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      for (const server of servers) {
        const af = server.family === 'ipv6' ? sock.AF_INET6 : sock.AF_INET;
        let fd;
        try {
          fd = sock.socket(af, sock.SOCK_DGRAM, 0);
        } catch {
          continue;
        }
        sock.setNonblocking(fd);
        const bytesSent = sock.sendto(fd, packet, {
          family: server.family,
          ip: server.ip,
          port: server.port
        });
        if (bytesSent < 0) {
          sock.close(fd);
          continue;
        }
        // Race the fd becoming readable against a timeout
        const dnsTimer = loop.timeout(this.#timeout);
        const result = await Promise.race([loop.readable(fd).then(function dnsReady() {
          dnsTimer.cancel();
          return 'ready';
        }), dnsTimer.then(function dnsTimedOut() {
          return TIMED_OUT;
        })]);
        if (result === TIMED_OUT) {
          loop.removeRead(fd);
          sock.close(fd);
          continue;
        }
        // fd is readable — receive the UDP datagram
        const recvResult = sock.recvfrom(fd, this.#dnssec ? 1232 : 4096);
        sock.close(fd);
        if (typeof recvResult === 'number' || recvResult === null) {
          continue;
        }
        let response;
        try {
          response = _parseResponse(recvResult.data);
        } catch {
          continue;
        }
        // Discard responses with wrong transaction ID
        if (response.id !== id) continue;
        if (response.truncated) {
          const tcpResponse = await this.#sendTcpQuery(server, packet, id, name);
          if (tcpResponse === null) continue;
          response = tcpResponse;
        }
        if (this.#dnssec && validateDnssec) {
          await validateDnssecResponse(response, name, qtype, {
            trustAnchors: ROOT_TRUST_ANCHORS,
            cache: this.#dnssecCache,
            fetch: async (fetchName, fetchType) => {
              try {
                return await this.#sendQuery(fetchName, fetchType, false);
              } catch (err) {
                if ((err as {
                  code?: string;
                })?.code === 'EDNSSEC') throw err;
                const dnssecErr: DnsError = new Error(`dnssec: validation fetch failed for '${fetchName}'`);
                dnssecErr.code = 'EDNSSEC';
                dnssecErr.hostname = fetchName;
                throw dnssecErr;
              }
            }
          });
        }
        if (!this.#handleResponseCode(response, name)) continue;
        return response;
      }
    }
    const err: DnsError = new Error(`dns: query timed out for '${name}'`);
    err.code = 'ETIMEOUT';
    err.hostname = name;
    throw err;
  }
  async #sendTcpQuery(server: DnsServer, packet: Uint8Array, id: number, name: string): Promise<DnsResponse | null> {
    const fd = sock.socket(server.family === 'ipv6' ? sock.AF_INET6 : sock.AF_INET, sock.SOCK_STREAM, 0);
    try {
      sock.setNonblocking(fd);
      const rc = sock.connect(fd, {
        family: server.family,
        ip: server.ip,
        port: server.port
      });
      if (rc !== 0) {
        const ready = await this.#waitForFd(fd, 'write');
        if (!ready) return null;
        const errBuf = sock.getsockopt(fd, sock.SOL_SOCKET, sock.SO_ERROR);
        const errno = new DataView(errBuf).getInt32(0, true);
        if (errno !== 0) return null;
      }
      const framedQuery = new Uint8Array(packet.byteLength + 2);
      new DataView(framedQuery.buffer).setUint16(0, packet.byteLength, false);
      framedQuery.set(packet, 2);
      if (!await this.#sendAll(fd, framedQuery)) return null;
      const lenBytes = await this.#recvExact(fd, 2);
      if (lenBytes === null) return null;
      const responseLength = new DataView(lenBytes.buffer, lenBytes.byteOffset, lenBytes.byteLength).getUint16(0, false);
      if (responseLength < 12) return null;
      const responseBytes = await this.#recvExact(fd, responseLength);
      if (responseBytes === null) return null;
      let response;
      try {
        response = _parseResponse(responseBytes);
      } catch {
        return null;
      }
      if (response.id !== id) return null;
      return response;
    } finally {
      loop.removeRead(fd);
      loop.removeWrite(fd);
      sock.close(fd);
    }
  }
  async #sendAll(fd: number, bytes: Uint8Array): Promise<boolean> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const sent = sock.send(fd, bytes.slice(offset));
      if (sent > 0) {
        offset += sent;
        continue;
      }
      if (!await this.#waitForFd(fd, 'write')) return false;
    }
    return true;
  }
  async #recvExact(fd: number, length: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = sock.recv(fd, length - offset);
      if (chunk === null) return null;
      if (typeof chunk === 'number') {
        if (!await this.#waitForFd(fd, 'read')) return null;
        continue;
      }
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  async #waitForFd(fd: number, direction: 'read' | 'write'): Promise<boolean> {
    const dnsTimer = loop.timeout(this.#timeout);
    const result = await Promise.race([(direction === 'read' ? loop.readable(fd) : loop.writable(fd)).then(function dnsReady() {
      dnsTimer.cancel();
      return true;
    }), dnsTimer.then(function dnsTimedOut() {
      return false;
    })]);
    if (!result) {
      if (direction === 'read') loop.removeRead(fd);
      else loop.removeWrite(fd);
    }
    return result;
  }
  #handleResponseCode(response: DnsResponse, name: string): boolean {
    if (response.rcode === 0) return true;
    const rcodeInfo = RCODE_ERRORS[response.rcode];
    if (!rcodeInfo) return false;
    const err: DnsError = new Error(`dns: ${rcodeInfo.msg} for '${name}'`);
    err.code = rcodeInfo.code;
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
* This module-level helper lazily creates a shared `Resolver`. IP literals are
* returned without DNS I/O. When `family` is omitted, this implementation
* queries IPv4. Missing records throw `ENOTFOUND`; malformed address responses
* throw `ENODATA`.
*
* ```ts no_run
* import { lookup } from 'fino:net/dns';
*
* const { address, family } = await lookup('example.com', { family: 4 });
* ```
*/
export async function lookup(hostname: string, opts: LookupOptions = {}): Promise<LookupResult> {
  const family = opts.family ?? 4;
  const normalizedHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (normalizedHostname.toLowerCase() === 'localhost') {
    return family === 6 ? {
      address: '::1',
      family: 6
    } : {
      address: '127.0.0.1',
      family: 4
    };
  }
  // If hostname is already an IP literal, return it directly without DNS lookup.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return {
      address: hostname,
      family: 4
    };
  }
  if (hostname.includes(':')) {
    // IPv6 address literal (e.g. "::1", "2001:db8::1")
    return {
      address: hostname,
      family: 6
    };
  }
  const resolver = opts.dnssec ? new Resolver({ dnssec: true }) : _defaultResolver ??= new Resolver();
  const rrtype = family === 6 ? 'AAAA' : 'A';
  const addresses = await resolver.resolve(hostname, rrtype);
  if (addresses.length === 0) {
    const err: DnsError = new Error(`dns: no ${rrtype} record for '${hostname}'`);
    err.code = 'ENOTFOUND';
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
  return {
    address,
    family
  };
}
export default {
  Resolver,
  lookup,
  RECORD_TYPES
};
