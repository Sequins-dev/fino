# mDNS and DNS-SD Support Research

> Status: research and implementation-shaping note. This document describes
> what it would take to add Multicast DNS and DNS-Based Service Discovery to
> Fino. It is not an implementation commitment and does not freeze exact
> TypeScript names.

## 1. Goal

Add local-link discovery support so Fino applications can resolve `.local`
hosts, browse DNS-SD service types, resolve service instances into connection
targets, and eventually advertise services on the local network.

The recommended scope is **full discovery with phased delivery**:

- Phase 1: socket multicast primitives needed by mDNS.
- Phase 2: query-only `.local` and DNS record lookups over mDNS.
- Phase 3: DNS-SD browse and resolve helpers for PTR, SRV, TXT, A, and AAAA.
- Phase 4: responder/publisher support with probing, announcement, goodbye,
  cache-flush, and conflict handling.

## 2. Authoritative Requirements

Primary references:

- Multicast DNS: https://www.rfc-editor.org/rfc/rfc6762
- DNS-Based Service Discovery: https://www.rfc-editor.org/rfc/rfc6763
- DNS message format inherited by mDNS: https://www.rfc-editor.org/rfc/rfc1035

Important mDNS constraints from RFC 6762:

- mDNS is DNS-like UDP query/response over multicast on UDP port `5353`.
- The IPv4 multicast group is `224.0.0.251`; the IPv6 multicast group is
  `FF02::FB`.
- One-shot queries for names in mDNS domains are sent to
  `224.0.0.251:5353` or `[FF02::FB]:5353`, commonly with a shorter timeout of
  two or three seconds.
- Responses to link-local mDNS queries must be accepted only when they originate
  from the local link; packets that fail that check are discarded.
- Resource-record TTLs drive cache coherency. Hostname-related records normally
  use a 120-second TTL; other records commonly use 75 minutes.
- A responder that publishes unique records needs probing and conflict
  resolution before it starts answering queries.
- Goodbye packets use an RR TTL of zero to retire records.
- Unique RRsets in multicast responses use the cache-flush bit; receivers must
  mask that bit before storing the class.
- Multiple interfaces matter. The same host may publish different records on
  different links, and multicast membership has to be managed per interface.

Important DNS-SD constraints from RFC 6763:

- Browsing a service type is a PTR lookup for names such as
  `_http._tcp.local.`.
- Resolving a service instance uses the PTR target plus SRV and TXT records.
- The SRV record owns the target host and port. TXT key/value data must not
  duplicate the target host or port.
- DNS-SD TXT records are one or more length-prefixed strings. Each string is
  normally `key=value`; strings without `=` are boolean attributes.
- TXT keys are case-insensitive. Duplicate keys are ignored after the first.
- TXT records should stay small in practice, ideally a few hundred bytes.

## 3. Current Repo State

Useful existing pieces:

- `js/net/dns.mts` already has a DNS wire-format resolver and parser, including
  A, AAAA, PTR, TXT, SRV, MX, SOA, NS, CNAME, OPT, DS, DNSKEY, RRSIG, NSEC, and
  NSEC3 handling.
- `js/internal/net/dns-provider.mts` has a provider abstraction with common
  record types including PTR, TXT, SRV, A, and AAAA.
- `tests/net/dns.test.mts` has a local UDP/TCP DNS fixture and parser coverage
  that can be extended for mDNS packet cases.
- `js/net/socket.mts` exposes raw UDP `sendto()` and `recvfrom()`, `setsockopt()`
  with raw buffers, and IP family constants.
- The socket module currently has unicast TTL constants (`IP_TTL`,
  `IPV6_UNICAST_HOPS`) and basic reuse options (`SO_REUSEADDR`,
  `SO_REUSEPORT`).

Main gaps:

- No exported multicast socket constants or helpers were found for
  `IP_ADD_MEMBERSHIP`, `IP_DROP_MEMBERSHIP`, `IP_MULTICAST_TTL`,
  `IP_MULTICAST_LOOP`, `IP_MULTICAST_IF`, `IPV6_JOIN_GROUP`,
  `IPV6_LEAVE_GROUP`, `IPV6_MULTICAST_HOPS`, `IPV6_MULTICAST_LOOP`, or
  `IPV6_MULTICAST_IF`.
- IPv6 addresses in the public socket shape do not expose a scope ID, which is
  important for link-local IPv6 and interface-specific multicast.
- `recvfrom()` only returns source address and data. Full mDNS validation and
  multi-interface behavior may need destination/interface ancillary data, such
  as packet info, not just source address.
- The DNS resolver assumes unicast DNS request/response behavior. mDNS needs
  multicast timing, duplicate suppression, known-answer handling, cache
  coherency, and unsolicited responses.
- No responder or service registry exists for published records.

## 4. Recommended Design

### 4.1 Socket foundation

Add portable multicast support to `fino:socket` before building the mDNS layer.
This keeps protocol code out of platform-specific socket layout details.

Candidate low-level additions:

```ts
joinMulticastGroup(fd, {
  group: '224.0.0.251',
  interfaceAddress?: '192.168.1.20',
  interfaceIndex?: number,
});

setMulticastOptions(fd, {
  ttl?: number,
  loopback?: boolean,
  interfaceAddress?: string,
  interfaceIndex?: number,
});
```

The implementation should still expose the raw constants for advanced callers
because `fino:socket` already has a low-level POSIX style.

Open design point: interface enumeration. A robust responder needs to discover
eligible network interfaces. That can be a separate API if Fino does not
already expose one.

### 4.2 mDNS packet layer

Reuse the DNS packet codec where possible, but introduce an mDNS-specific
layer for semantics that differ from unicast DNS:

- destination groups and port;
- query ID handling;
- QU and cache-flush bits in the class field;
- known-answer lists;
- duplicate question/answer suppression;
- response aggregation and randomized delay windows;
- local-link source validation;
- per-interface cache keys;
- goodbye packet handling.

Do not fork the entire DNS parser unless the shared parser becomes too hard to
reason about. The record decoding work in `js/net/dns.mts` is directly useful.

### 4.3 Public discovery API

Prefer a dedicated module over overloading the unicast DNS resolver:

```ts
import { Mdns } from 'fino:net/mdns';

const mdns = new Mdns();
const addrs = await mdns.resolveHost('printer.local');
for await (const service of mdns.browse('_http._tcp.local')) {
  const target = await mdns.resolveService(service);
}
await mdns.close();
```

Candidate concepts:

- `resolveHost(name, options)` returns A/AAAA results for `.local` names.
- `query(name, rrtype, options)` exposes lower-level record lookup.
- `browse(serviceType, options)` returns an async iterator of service instances.
- `resolveService(instance, options)` returns SRV target, port, TXT attributes,
  and address records.
- `publish(service, options)` starts a responder-owned registration and returns
  a disposable registration handle.

Keep publication out of the first user-visible milestone unless socket and
query behavior has already stabilized. Publication is where conflict handling
and cache coherency become correctness-critical.

### 4.4 Cache model

mDNS needs a cache separate from unicast DNS:

- key by interface, name, rrtype, rrclass, and rdata where needed;
- honor RR TTLs and refresh active queries around 80% of lifetime;
- delay deletion of goodbye records briefly to avoid races;
- handle cache-flush records as RRset replacement, not whole-name deletion;
- avoid mixing answers from different local links.

Phase 2 can start with a short-lived query cache. Long-lived browse and publish
support should use a durable cache tied to the `Mdns` instance.

## 5. Implementation Effort

Estimated complexity is medium-high because the DNS codec exists but the socket
and protocol lifecycle pieces do not.

Likely work items:

- Add portable multicast constants and helper functions for macOS and Linux.
- Add IPv6 scope/interface support, or explicitly gate IPv6 mDNS until the
  address model can represent it.
- Add mDNS packet helpers for class bits, response validation, and cache keys.
- Add one-shot `.local` querying using UDP multicast and short timeouts.
- Add DNS-SD TXT decoding/encoding helpers with RFC 6763 key rules.
- Add browse/resolve APIs over PTR, SRV, TXT, A, and AAAA.
- Add responder registry, probe/announce state machine, goodbye handling, and
  conflict callbacks for publishing.
- Add docs that distinguish mDNS from unicast DNS and explain local-link trust
  boundaries.

The riskiest areas are multicast portability, interface handling, duplicate
suppression timing, and publishing conflict resolution.

## 6. Test Plan

Socket foundation:

- Unit-test multicast option buffer encoding on macOS and Linux constants where
  feasible.
- Integration-test UDP multicast join/send/receive behind a platform gate.
- Verify `SO_REUSEADDR`/`SO_REUSEPORT` behavior for multiple sockets bound to
  `5353` where the platform allows it.

Packet and query behavior:

- Add parser tests for QU and cache-flush class bits.
- Add DNS-SD TXT parser tests for empty TXT, boolean keys, duplicate keys,
  case-insensitive keys, binary values, and oversize records.
- Add one-shot `.local` query tests with a local UDP fixture that returns mDNS
  packets.
- Verify non-local or invalid source responses are rejected where source
  validation can be simulated.

Discovery behavior:

- Browse test: PTR response yields service instances.
- Resolve test: PTR target plus SRV/TXT/address records yields a connectable
  target.
- Cache test: TTL expiry removes records and goodbye packets retire records.
- Duplicate suppression test: repeated answers do not produce repeated browse
  events unless the record changes.

Publication behavior:

- Probe succeeds when no conflict is observed.
- Conflict during probing rejects or renames according to the chosen API.
- Announce sends the full unique RRset with cache-flush.
- Dispose sends goodbye records and closes multicast memberships.

Commands once implemented:

- `./target/release/fino --test tests/net/socket.test.mts`
- `./target/release/fino --test tests/net/dns.test.mts`
- New focused `tests/net/mdns.test.mts`, with multicast tests gated when the
  local platform or CI network does not support multicast.

## 7. Assumptions and Defaults

- Treat full DNS-SD discovery as the product goal, but do not implement service
  publication until query and browse behavior is stable.
- Keep mDNS separate from the unicast resolver internally so local-link caching
  and trust rules do not leak into normal DNS.
- Support IPv4 first if IPv6 scope IDs require a broader public socket-address
  change.
- Prefer spec-conformant behavior over compatibility shortcuts, especially for
  responder publication and conflict handling.
