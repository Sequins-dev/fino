# js/net/dns

fino:dns — async DNS resolution via the RFC 1035 wire protocol over UDP.

This module implements DNS resolution entirely in JS by speaking the DNS
wire protocol directly over UDP sockets (from `fino:socket`). It reads
nameservers from `/etc/resolv.conf` via `fino:file`. No blocking libc
calls are made — the entire resolution path is async and event-loop driven.

## Why not use libc getaddrinfo?

`getaddrinfo(3)` is the standard libc function for DNS resolution, but it
blocks the calling thread. Calling it from Fino would freeze the entire
event loop for the duration of the DNS query — potentially hundreds of
milliseconds. Using raw UDP lets us await the response asynchronously via
`loop.readable()`, keeping the process responsive to other I/O while the
query is in flight.

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
SRV. Unknown types return raw bytes.

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
- Transaction IDs should be random per query to prevent response spoofing.
  The current implementation uses `Math.random()`. A production resolver
  would use `getpid()` XOR'd with a counter to reduce collision probability.
- UDP datagrams may arrive out of order or be duplicates. We check that the
  response ID matches the query ID and discard non-matching packets.
- DNSSEC validation is not implemented. Responses are trusted at face value.

## MxRecord

```ts
interface MxRecord {
```

Mail-exchanger DNS record data.

### priority

```ts
priority: number
```

### exchange

```ts
exchange: string
```

## SoaRecord

```ts
interface SoaRecord {
```

Start-of-authority DNS record data.

### nsname

```ts
nsname: string
```

### hostmaster

```ts
hostmaster: string
```

### serial

```ts
serial: number
```

### refresh

```ts
refresh: number
```

### retry

```ts
retry: number
```

### expire

```ts
expire: number
```

### minttl

```ts
minttl: number
```

## SrvRecord

```ts
interface SrvRecord {
```

Service-location DNS record data.

### priority

```ts
priority: number
```

### weight

```ts
weight: number
```

### port

```ts
port: number
```

### name

```ts
name: string
```

## DnsRecordData

```ts
type DnsRecordData = string | string[] | MxRecord | SoaRecord | SrvRecord | Uint8Array | null
```

Decoded DNS record payload for supported record types; unknown data is raw bytes.

## DnsResourceRecord

```ts
interface DnsResourceRecord {
```

Decoded DNS resource record from a response section.

### name

```ts
name: string
```

### type

```ts
type: number
```

### ttl

```ts
ttl: number
```

### data

```ts
data: DnsRecordData
```

## DnsResponse

```ts
interface DnsResponse {
```

Parsed DNS response packet.

### id

```ts
id: number
```

### flags

```ts
flags: number
```

### rcode

```ts
rcode: number
```

### truncated

```ts
truncated: boolean
```

### answers

```ts
answers: DnsResourceRecord[]
```

### authorities

```ts
authorities: DnsResourceRecord[]
```

### additionals

```ts
additionals: DnsResourceRecord[]
```

## ResolverOptions

```ts
interface ResolverOptions {
```

Resolver timeout and retry controls.

### timeout

```ts
timeout?: number
```

### retries

```ts
retries?: number
```

## LookupOptions

```ts
interface LookupOptions {
```

Address-family preference for `lookup`.

### family

```ts
family?: 4 | 6
```

## LookupResult

```ts
interface LookupResult {
```

Primary address returned by `lookup`.

### address

```ts
address: string
```

### family

```ts
family: 4 | 6
```

## RECORD_TYPES

```ts
const RECORD_TYPES
```

Map from DNS record type name to numeric QTYPE value.

### A

```ts
A
```

### NS

```ts
NS
```

### CNAME

```ts
CNAME
```

### SOA

```ts
SOA
```

### PTR

```ts
PTR
```

### MX

```ts
MX
```

### TXT

```ts
TXT
```

### AAAA

```ts
AAAA
```

### SRV

```ts
SRV
```

## _encodeName

```ts
function _encodeName(name: string): Uint8Array
```

Encode a domain name into DNS wire format (length-prefixed labels).
"example.com" → Uint8Array [7, 'e','x','a','m','p','l','e', 3, 'c','o','m', 0]

Exported for unit testing.

## _buildQuery

```ts
function _buildQuery(id: number, name: string, qtype: number): Uint8Array
```

Build a complete DNS query packet.

Exported for unit testing.

## _decodeName

```ts
function _decodeName(msg: Uint8Array, startOffset: number): { name: string; nextOffset: number }
```

Decode a DNS name from wire format, following compression pointers.

  nextOffset is the offset of the first byte after this name in the stream.

Exported for unit testing.

## _parseResponse

```ts
function _parseResponse(msg: Uint8Array): DnsResponse
```

Parse a complete DNS response packet.

Exported for unit testing.

## _reverseIP

```ts
function _reverseIP(ip: string): string
```

Convert an IP address string to its PTR query name.
  "1.2.3.4"  → "4.3.2.1.in-addr.arpa"
  "2001:db8::1" → nibble-reversed + ".ip6.arpa"

Exported for unit testing.

## Resolver

```ts
class Resolver {
```

UDP DNS resolver with configurable nameservers, timeout, and retries.

### constructor

```ts
constructor(opts: ResolverOptions = {})
```

### getServers

```ts
getServers(): string[]
```

Return the current list of nameserver IP addresses.

### setServers

```ts
setServers(servers: string[]): void
```

Override the nameserver list. Each entry is an IPv4 or IPv6 address string,
optionally with a port: '1.1.1.1', '1.1.1.1:5353', '[::1]:5353'.

### resolve

```ts
async resolve(hostname: string, rrtype: RecordTypeName = 'A'): Promise<DnsRecordData[]>
```

Resolve a hostname for the given record type.

### resolve4

```ts
async resolve4(hostname: string)
```

Resolve IPv4 addresses.

### resolve6

```ts
async resolve6(hostname: string)
```

Resolve IPv6 addresses.

### resolveMx

```ts
async resolveMx(hostname: string)
```

Resolve MX records.

### resolveTxt

```ts
async resolveTxt(hostname: string)
```

Resolve TXT records.

### resolveNs

```ts
async resolveNs(hostname: string)
```

Resolve NS records.

### resolveSrv

```ts
async resolveSrv(hostname: string)
```

Resolve SRV records.

### resolveSoa

```ts
async resolveSoa(hostname: string)
```

Resolve SOA record.

### resolveCname

```ts
async resolveCname(hostname: string)
```

Resolve CNAME records.

### reverse

```ts
async reverse(ip: string): Promise<DnsRecordData[]>
```

Reverse DNS lookup.

## lookup

```ts
async function lookup(hostname: string, opts: LookupOptions = {}): Promise<LookupResult>
```

Look up the primary address for a hostname.
