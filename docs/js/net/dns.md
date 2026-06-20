# js/net/dns

fino:dns — async DNS resolution via the RFC 1035 wire protocol.

This module implements DNS resolution entirely in JS by speaking the DNS
wire protocol directly over UDP sockets (from `fino:socket`) and falls back
to DNS-over-TCP when a UDP response is marked truncated. It reads nameservers
from `/etc/resolv.conf` via `fino:file`. No blocking libc calls are made —
the entire resolution path is async and event-loop driven.

## Why not use libc getaddrinfo?

`getaddrinfo(3)` is the standard libc function for DNS resolution, but it
blocks the calling thread. Calling it from Fino would freeze the entire
event loop for the duration of the DNS query — potentially hundreds of
milliseconds. Using raw sockets lets us await readiness asynchronously via
`loop.readable()` / `loop.writable()`, keeping the process responsive to
other I/O while the query is in flight.

## DNS wire protocol overview (RFC 1035)

A DNS query packet is:

  Header (12 bytes, big-endian):
    [0-1]  ID      — 16-bit transaction ID (random per query)
    [2-3]  Flags   — 0x0100 = standard query with recursion desired
    [4-5]  QDCOUNT — number of questions (always 1)
    [6-7]  ANCOUNT — answer count (0 in queries)
    [8-9]  NSCOUNT — authority count (0 in queries)
    [10-11] ARCOUNT — additional count (0 in queries)

  Question section:
    QNAME   — domain name in wire format (length-prefixed labels, null-terminated)
    QTYPE   — record type (A=1, AAAA=28, MX=15, etc.)
    QCLASS  — always IN=1 (Internet)

Wire-format domain names encode each label (dot-separated part) as a length
byte followed by the label's bytes. "example.com" becomes:
  [7] 'e','x','a','m','p','l','e'  [3] 'c','o','m'  [0]

DNS responses use **compression pointers** to avoid repeating domain names:
a two-byte sequence starting with bits 11xxxxxx is a pointer to an earlier
offset in the message. `_decodeName()` follows these pointers recursively,
with a hop limit to prevent infinite loops from malformed responses.

## Resource record parsing

Each answer/authority/additional record is:
  NAME    — domain name (may use compression)
  TYPE    — u16 big-endian
  CLASS   — u16 big-endian (always 1)
  TTL     — u32 big-endian (seconds)
  RDLENGTH— u16 big-endian (length of RDATA)
  RDATA   — variable; format depends on TYPE

`parseResourceRecord()` handles A, AAAA, CNAME, NS, PTR, MX, TXT, SOA, and
SRV, plus DNSSEC DS, DNSKEY, RRSIG, NSEC, NSEC3, and NSEC3PARAM records.
Unknown types return raw bytes. Every parsed record also preserves exact
`rawData` RDATA bytes for canonicalization and future validator use.

## DNSSEC wire support

Passing `{ dnssec: true }` to `new Resolver()` or `lookup()` makes queries
include an EDNS(0) OPT pseudo-record with the DNSSEC OK (DO) bit and a
conservative 1232-byte UDP payload size. Responses parse EDNS metadata and
DNSSEC record payloads locally. Signed positive answers are validated from
embedded IANA root trust anchors. Bogus or indeterminate signed data, broken
DS/DNSKEY chains, expired signatures, unsupported-only signatures, and
missing denial proofs reject with `code: 'EDNSSEC'`. Provably insecure
unsigned delegations are accepted after a signed DS-negative proof. The
resolver never trusts upstream AD bits as proof. Unsupported DNSSEC signing
algorithms still reject unless another supported signature validates.

## CNAME chain following

For A and AAAA queries, `resolve()` follows CNAME chains automatically (up
to 10 hops) by re-querying the CNAME target if the response contains no
direct A/AAAA records. This is how most real resolvers work — the CNAME
leads to the actual IP.

## Nameserver discovery

On first use, `#loadServers()` reads `/etc/resolv.conf` and parses
`nameserver <ip>` lines. If the file is unreadable or has no nameserver
lines, it falls back to Google's public DNS servers (8.8.8.8, 8.8.4.4).
Callers can override nameservers with `resolver.setServers(['1.1.1.1'])`.

## IPv6 formatting via sock.decodeAddr

Rather than implementing IPv6 string formatting from scratch (handling `::`,
leading zeros, etc.), `formatIPv6()` builds a synthetic `sockaddr_in6`
buffer and passes it to `sock.decodeAddr()`, which calls `inet_ntop(3)`.
This gives correct RFC 5952 compressed output (e.g. `2001:db8::1`) without
extra code.

## Query timeout and retry

Each query races `loop.readable(lp, fd)` against `loop.timeout(lp, ms)`.
If the timeout fires first, we close the socket and try the next nameserver.
After all servers have been tried `retries` times without a valid response,
we throw an `ETIMEOUT` error.

## Contributing

- DNS packets are big-endian. All header fields and record metadata use the
  `readU16()` / `readU32()` big-endian helpers defined at the top of the file.
- Transaction IDs are generated with `crypto.getRandomValues()` and checked
  against responses to reduce spoofing risk.
- UDP datagrams may arrive out of order or be duplicates. We check that the
  response ID matches the query ID and discard non-matching packets.
- DNSSEC validation is opt-in. DNSSEC-enabled queries request validation
  material with EDNS(0) DO, verify chains locally, and reject bogus or
  indeterminate data with `EDNSSEC`.

```ts
import { Resolver } from 'fino:dns';

const resolver = new Resolver({ timeout: 1_000, retries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);
const addresses = await resolver.resolve('example.com', 'A');
```

## DnsServer

```ts
interface DnsServer {
```

Parsed DNS nameserver endpoint used internally by the resolver.

### ip

```ts
ip: string
```

Numeric IPv4 or IPv6 address literal.

### family

```ts
family: DnsServerFamily
```

Socket address family for `ip`.

### port

```ts
port: number
```

UDP/TCP DNS port, normally 53.

## MxRecord

```ts
interface MxRecord {
```

Mail-exchanger DNS record payload returned for MX lookups.

`priority` is the preference value from the DNS response; lower numbers are
preferred. `exchange` is the mail host name exactly as decoded from the DNS
packet and is not resolved to an address automatically.

```ts
import { Resolver } from 'fino:net/dns';

const resolver = new Resolver();
const [mx] = await resolver.resolve('example.com', 'MX');
console.log(mx.priority, mx.exchange);
```

### priority

```ts
priority: number
```

MX preference value; lower values should be tried first.

```ts
const best = records.sort((a, b) => a.priority - b.priority)[0];
```

### exchange

```ts
exchange: string
```

Mail exchanger host name. Resolve it separately with A or AAAA if needed.

```ts
const addr = await resolver.resolve(mx.exchange, 'A');
```

## SoaRecord

```ts
interface SoaRecord {
```

Start-of-authority DNS record payload returned for SOA lookups.

Timing fields are seconds from the authoritative record. Values are not
interpreted or clamped by the resolver.

```ts
const [soa] = await new Resolver().resolve('example.com', 'SOA');
console.log(soa.nsname, soa.serial);
```

### nsname

```ts
nsname: string
```

Primary authoritative nameserver for the zone.

```ts
console.log(soa.nsname);
```

### hostmaster

```ts
hostmaster: string
```

Responsible mailbox encoded as a DNS name.

```ts
console.log(soa.hostmaster);
```

### serial

```ts
serial: number
```

Zone serial number used by secondary nameservers.

```ts
console.log(soa.serial);
```

### refresh

```ts
refresh: number
```

Suggested refresh interval in seconds.

```ts
console.log(soa.refresh);
```

### retry

```ts
retry: number
```

Suggested retry interval in seconds.

```ts
console.log(soa.retry);
```

### expire

```ts
expire: number
```

Zone expiry interval in seconds.

```ts
console.log(soa.expire);
```

### minttl

```ts
minttl: number
```

Minimum TTL field from the SOA record.

```ts
console.log(soa.minttl);
```

## SrvRecord

```ts
interface SrvRecord {
```

Service-location DNS record payload returned for SRV lookups.

The resolver returns records in wire order; callers that need RFC 2782
selection should sort/group by priority and apply weighted selection.

```ts
const records = await new Resolver().resolve('_xmpp-server._tcp.example.com', 'SRV');
for (const srv of records) console.log(srv.name, srv.port);
```

### priority

```ts
priority: number
```

SRV priority; lower values are preferred.

```ts
const firstPriority = srv.priority;
```

### weight

```ts
weight: number
```

SRV weight used for load distribution within a priority group.

```ts
console.log(srv.weight);
```

### port

```ts
port: number
```

TCP or UDP port advertised by the service.

```ts
console.log(srv.port);
```

### name

```ts
name: string
```

Target host name for the service.

```ts
const addrs = await resolver.resolve(srv.name, 'AAAA');
```

## DsRecord

```ts
interface DsRecord {
```

Delegation signer DNSSEC record payload.

DS records bind a child zone DNSKEY to its parent zone. The digest is the
raw hash from wire format; callers that display it commonly hex-encode it.

### keyTag

```ts
keyTag: number
```

### algorithm

```ts
algorithm: number
```

### digestType

```ts
digestType: number
```

### digest

```ts
digest: Uint8Array
```

## DnskeyRecord

```ts
interface DnskeyRecord {
```

DNSSEC DNSKEY record payload.

### flags

```ts
flags: number
```

### protocol

```ts
protocol: number
```

### algorithm

```ts
algorithm: number
```

### publicKey

```ts
publicKey: Uint8Array
```

## RrsigRecord

```ts
interface RrsigRecord {
```

DNSSEC RRSIG record payload.

### typeCovered

```ts
typeCovered: number
```

### algorithm

```ts
algorithm: number
```

### labels

```ts
labels: number
```

### originalTtl

```ts
originalTtl: number
```

### expiration

```ts
expiration: number
```

### inception

```ts
inception: number
```

### keyTag

```ts
keyTag: number
```

### signerName

```ts
signerName: string
```

### signature

```ts
signature: Uint8Array
```

## NsecRecord

```ts
interface NsecRecord {
```

DNSSEC NSEC authenticated-denial record payload.

### nextDomainName

```ts
nextDomainName: string
```

### types

```ts
types: number[]
```

## Nsec3Record

```ts
interface Nsec3Record {
```

DNSSEC NSEC3 authenticated-denial record payload.

### hashAlgorithm

```ts
hashAlgorithm: number
```

### flags

```ts
flags: number
```

### iterations

```ts
iterations: number
```

### salt

```ts
salt: Uint8Array
```

### nextHashedOwnerName

```ts
nextHashedOwnerName: Uint8Array
```

### types

```ts
types: number[]
```

## Nsec3ParamRecord

```ts
interface Nsec3ParamRecord {
```

DNSSEC NSEC3PARAM record payload.

### hashAlgorithm

```ts
hashAlgorithm: number
```

### flags

```ts
flags: number
```

### iterations

```ts
iterations: number
```

### salt

```ts
salt: Uint8Array
```

## DnsRecordData

```ts
type DnsRecordData = string | string[] | MxRecord | SoaRecord | SrvRecord | DsRecord | DnskeyRecord | RrsigRecord | NsecRecord | Nsec3Record | Nsec3ParamRecord | Uint8Array | null
```

Decoded DNS record payload for supported record types; unknown data is raw
bytes and malformed or empty RDATA can surface as `null`.

```ts
const records = await new Resolver().resolve('example.com', 'TXT');
for (const data of records) {
  if (Array.isArray(data)) console.log(data.join(''));
}
```

## DnsResourceRecord

```ts
interface DnsResourceRecord {
```

Decoded DNS resource record from a response section.

`type` is the numeric QTYPE, `ttl` is seconds, and `data` follows the shape
documented by `DnsRecordData`. The resolver does not cache by TTL.

```ts
const response = dns._parseResponse(packet);
for (const rr of response.answers) console.log(rr.name, rr.ttl, rr.data);
```

### name

```ts
name: string
```

Owner name for this record.

```ts
console.log(record.name);
```

### type

```ts
type: number
```

Numeric DNS record type, such as `RECORD_TYPES.A`.

```ts
if (record.type === RECORD_TYPES.A) console.log(record.data);
```

### ttl

```ts
ttl: number
```

Record TTL in seconds.

```ts
console.log(`cacheable for ${record.ttl}s`);
```

### rawData

```ts
rawData: Uint8Array
```

Exact RDATA bytes from the packet.

### data

```ts
data: DnsRecordData
```

Parsed record payload, or raw bytes for unsupported record types.

```ts
if (record.data instanceof Uint8Array) console.log(record.data.byteLength);
```

## DnsResponse

```ts
interface DnsResponse {
```

Parsed DNS response packet.

`rcode` exposes the low four bits of the DNS flags field. A non-zero value
is converted to an error by `Resolver.resolve`, but parser tests can inspect
it directly.

```ts
const parsed = _parseResponse(responseBytes);
if (!parsed.truncated) console.log(parsed.answers);
```

### id

```ts
id: number
```

Transaction ID copied from the DNS header.

```ts
if (response.id !== queryId) throw new Error('spoofed response');
```

### flags

```ts
flags: number
```

Raw DNS flags field.

```ts
const authoritative = Boolean(response.flags & 0x0400);
```

### rcode

```ts
rcode: number
```

DNS response code; zero means no DNS-layer error.

```ts
if (response.rcode === 3) console.log('not found');
```

### truncated

```ts
truncated: boolean
```

True when the DNS server marked the UDP response as truncated.

```ts
if (response.truncated) console.log('retry over TCP if needed');
```

### answers

```ts
answers: DnsResourceRecord[]
```

Answer section records.

```ts
for (const answer of response.answers) console.log(answer.data);
```

### authorities

```ts
authorities: DnsResourceRecord[]
```

Authority section records.

```ts
console.log(response.authorities.length);
```

### additionals

```ts
additionals: DnsResourceRecord[]
```

Additional section records.

```ts
console.log(response.additionals.length);
```

### edns

```ts
edns?: {
  udpPayloadSize: number;
  dnssecOk: boolean;
  extendedRcode: number;
  version: number;
  flags: number;
}
```

Parsed EDNS(0) metadata when the response contains an OPT pseudo-RR.

## ResolverOptions

```ts
interface ResolverOptions {
```

Resolver timeout and retry controls.

Defaults are `timeout: 5000` milliseconds and `retries: 2`. The timeout is
applied per query attempt; after all servers and retries fail, resolution
throws an `ETIMEOUT` error with the hostname attached.

```ts
const resolver = new Resolver({ timeout: 1000, retries: 1 });
```

### timeout

```ts
timeout?: number
```

Per-attempt timeout in milliseconds.

```ts
const resolver = new Resolver({ timeout: 750 });
```

### retries

```ts
retries?: number
```

Number of retry rounds across the configured nameserver list.

```ts
const resolver = new Resolver({ retries: 3 });
```

### dnssec

```ts
dnssec?: boolean
```

Enable local DNSSEC validation and request DNSSEC records with EDNS(0) DO.

## LookupOptions

```ts
interface LookupOptions {
```

Address-family preference for `lookup`.

Omit `family` to prefer IPv4 first and then fall back to IPv6. Passing `4`
or `6` queries only that family and throws if no address is found.

```ts
const result = await lookup('example.com', { family: 6 });
```

### family

```ts
family?: 4 | 6
```

Requested address family, or omitted for IPv4-then-IPv6 fallback.

```ts
await lookup('example.com', { family: 4 });
```

### dnssec

```ts
dnssec?: boolean
```

Enable local DNSSEC validation for this lookup.

## LookupResult

```ts
interface LookupResult {
```

Primary address returned by `lookup`.

The address string is already formatted for the family. IPv6 addresses use
system `inet_ntop` formatting.

```ts
const { address, family } = await lookup('example.com');
console.log(`${address} is IPv${family}`);
```

### address

```ts
address: string
```

IP address string.

```ts
console.log(result.address);
```

### family

```ts
family: 4 | 6
```

Address family for `address`.

```ts
if (result.family === 6) console.log('IPv6');
```

## RECORD_TYPES

```ts
const RECORD_TYPES
```

Map from supported DNS record type names to numeric QTYPE values.

These constants are useful when building or parsing packets manually. Unknown
record types can still be parsed, but public resolution is limited to these
keys.

```ts
const query = _buildQuery(1, 'example.com', RECORD_TYPES.AAAA);
```

### DS

```ts
DS
```

DNSSEC DS record type constant.

### RRSIG

```ts
RRSIG
```

DNSSEC RRSIG record type constant.

### NSEC

```ts
NSEC
```

DNSSEC NSEC record type constant.

### DNSKEY

```ts
DNSKEY
```

DNSSEC DNSKEY record type constant.

### NSEC3

```ts
NSEC3
```

DNSSEC NSEC3 record type constant.

### NSEC3PARAM

```ts
NSEC3PARAM
```

DNSSEC NSEC3PARAM record type constant.

## _encodeName

```ts
function _encodeName(name: string): Uint8Array
```

Encode a domain name into DNS wire format (length-prefixed labels).

A trailing root dot is accepted and stripped. Empty labels are skipped, and
labels longer than 63 bytes throw. The returned buffer includes the terminal
zero root label.

```ts
import { _encodeName } from 'fino:net/dns';

const encoded = _encodeName('example.com.');
console.log(encoded[0]); // 7
```

Exported for unit testing.

## _buildQuery

```ts
function _buildQuery(id: number, name: string, qtype: number, options: {
  dnssec?: boolean;
  udpPayloadSize?: number;
} = {}): Uint8Array
```

Build a complete DNS query packet.

The packet is a standard recursive IN query with one question and no answer,
authority, or additional sections. `id` is written as a 16-bit field; callers
should provide a random value and match it against the response.

```ts
import { _buildQuery, RECORD_TYPES } from 'fino:net/dns';

const packet = _buildQuery(0x1234, 'example.com', RECORD_TYPES.A);
```

Exported for unit testing.

## _decodeName

```ts
function _decodeName(msg: Uint8Array, startOffset: number): {
  name: string;
  nextOffset: number;
}
```

Decode a DNS name from wire format, following compression pointers.

`nextOffset` is the byte immediately after the encoded name in the original
stream. Compression pointer loops, out-of-range pointers, and truncated names
throw `Error`.

```ts
import { _decodeName } from 'fino:net/dns';

const { name, nextOffset } = _decodeName(message, 12);
console.log(name, nextOffset);
```

Exported for unit testing.

## _parseResponse

```ts
function _parseResponse(msg: Uint8Array): DnsResponse
```

Parse a complete DNS response packet.

This validates packet bounds and decodes supported RDATA shapes, but it does
not verify that the response ID or question matches a query. Callers that use
raw UDP should check `id` before trusting the records.

```ts
import { _parseResponse } from 'fino:net/dns';

const parsed = _parseResponse(responseBytes);
console.log(parsed.rcode, parsed.answers.length);
```

Exported for unit testing.

## _reverseIP

```ts
function _reverseIP(ip: string): string
```

Convert an IP address string to its PTR query name.

IPv4 addresses become `in-addr.arpa` names. IPv6 addresses are expanded and
nibble-reversed into `ip6.arpa` names. This helper does not validate IPv4
octets or IPv6 syntax beyond the simple formatting logic.

```ts
import { _reverseIP } from 'fino:net/dns';

console.log(_reverseIP('1.2.3.4')); // 4.3.2.1.in-addr.arpa
```

Exported for unit testing.

## Resolver

```ts
class Resolver {
```

DNS resolver with configurable nameservers, timeout, and retries.

The resolver lazily reads `/etc/resolv.conf` on first use, falls back to
public IPv4 DNS servers if none are found, follows CNAME chains for A and
AAAA lookups up to a fixed hop limit, and retries over TCP when a UDP
response has the DNS truncated bit set. Set `dnssec: true` to request DNSSEC
records with EDNS(0) DO and validate signed answers from the root trust
anchor before returning them.

```ts
import { Resolver } from 'fino:net/dns';

const resolver = new Resolver({ timeout: 1500 });
const addrs = await resolver.resolve('example.com', 'A');
```

### constructor

```ts
constructor(opts: ResolverOptions = {})
```

Create a resolver.

`timeout` defaults to 5000 ms and `retries` defaults to 2. Nameservers are
loaded lazily, so constructing a resolver performs no I/O.

```ts
const resolver = new Resolver({ timeout: 1000, retries: 1 });
```

### getServers

```ts
getServers(): string[]
```

Return the current list of nameserver IP addresses.

If `setServers()` has not been called and `/etc/resolv.conf` has not been
loaded yet, this returns the built-in fallback server list. Non-default
ports are formatted as `ip:port` for IPv4 or `[ip]:port` for IPv6.

```ts
const resolver = new Resolver();
console.log(resolver.getServers());
```

### setServers

```ts
setServers(servers: string[]): void
```

Override the nameserver list. Each entry is an IPv4 or IPv6 address string,
optionally with a port: '1.1.1.1', '1.1.1.1:5353', '[::1]:5353'.

Passing an empty array throws. The entries are trusted as IP literals and
used for future queries; existing in-flight queries are not cancelled.

```ts
const resolver = new Resolver();
resolver.setServers(['1.1.1.1', '[2606:4700:4700::1111]:53']);
```

### resolve

```ts
async resolve(hostname: string, rrtype: RecordTypeName = 'A'): Promise<DnsRecordData[]>
```

Resolve a hostname for the given record type.

Supported record names are the keys of `RECORD_TYPES`. A and AAAA lookups
follow CNAME chains up to 10 hops. DNS-layer errors throw with `code` and
`hostname` properties; no-answer responses resolve to an empty array.

```ts
const resolver = new Resolver();
const addresses = await resolver.resolve('example.com', 'A');
```

### resolve4

```ts
async resolve4(hostname: string)
```

Resolve IPv4 A records for a hostname.

Returns an empty array when the name exists but has no A records. Throws on
DNS errors, timeout, malformed packets, or excessive CNAME hops.

```ts
const addrs = await new Resolver().resolve4('example.com');
```

### resolve6

```ts
async resolve6(hostname: string)
```

Resolve IPv6 AAAA records for a hostname.

The returned strings are formatted through `inet_ntop`; no zone IDs are
added. Throws on DNS errors or timeout.

```ts
const addrs = await new Resolver().resolve6('example.com');
```

### resolveMx

```ts
async resolveMx(hostname: string)
```

Resolve MX records for a hostname.

Records are returned in DNS response order, not sorted by priority.

```ts
const mx = await new Resolver().resolveMx('example.com');
```

### resolveTxt

```ts
async resolveTxt(hostname: string)
```

Resolve TXT records for a hostname.

Each DNS TXT record is returned as an array of character strings because a
single TXT record can contain multiple length-prefixed strings.

```ts
const txt = await new Resolver().resolveTxt('example.com');
```

### resolveNs

```ts
async resolveNs(hostname: string)
```

Resolve authoritative nameserver records for a hostname.

```ts
const ns = await new Resolver().resolveNs('example.com');
```

### resolveSrv

```ts
async resolveSrv(hostname: string)
```

Resolve SRV service-location records.

The resolver does not perform weighted target selection; callers should
apply SRV priority and weight rules themselves.

```ts
const srv = await new Resolver().resolveSrv('_xmpp-server._tcp.example.com');
```

### resolveSoa

```ts
async resolveSoa(hostname: string)
```

Resolve SOA records for a zone name.

Most zones return one SOA record, but the return shape is still an array to
match the generic resolver API.

```ts
const [soa] = await new Resolver().resolveSoa('example.com');
```

### resolveCname

```ts
async resolveCname(hostname: string)
```

Resolve CNAME records for a hostname.

This returns only CNAME answers; it does not follow the target to A or AAAA
addresses.

```ts
const aliases = await new Resolver().resolveCname('www.example.com');
```

### reverse

```ts
async reverse(ip: string): Promise<DnsRecordData[]>
```

Reverse DNS lookup.

Converts IPv4 or IPv6 addresses to the appropriate PTR query name and
resolves PTR records. Invalid IP strings are not fully validated before the
query name is built.

```ts
const names = await new Resolver().reverse('8.8.8.8');
```

## lookup

```ts
async function lookup(hostname: string, opts: LookupOptions = {}): Promise<LookupResult>
```

Look up the primary address for a hostname.

This module-level helper lazily creates a shared `Resolver`. IP literals are
returned without DNS I/O. When `family` is omitted, this implementation
queries IPv4. Missing records throw `ENOTFOUND`; malformed address responses
throw `ENODATA`.

```ts
import { lookup } from 'fino:net/dns';

const { address, family } = await lookup('example.com', { family: 4 });
```
