/**
 * internal:net/dns-provider - Abstract DnsProvider interface.
 *
 * Defines the contract all DNS providers must satisfy. The system resolver in
 * `fino:net/dns` is the production provider; static, virtual-network, and
 * restricted providers are possible future implementations of the same shape.
 *
 * ## Example
 *
 * ```ts no_run
 * import { DnsProvider, type LookupResult } from 'internal:net/dns-provider';
 *
 * class StaticDnsProvider extends DnsProvider {
 *   async lookup(hostname: string): Promise<LookupResult> {
 *     if (hostname !== 'service.local') throw new Error('not found');
 *     return { address: '127.0.0.1', family: 4 };
 *   }
 *
 *   async resolve() { return ['127.0.0.1']; }
 *   async reverse() { return ['service.local']; }
 * }
 * ```
 *
 * @internal
 */
// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
/**
 * Primary address returned by `DnsProvider.lookup()`.
 *
 * The shape mirrors getaddrinfo-style lookup results: one address string and
 * the numeric IP family that produced it. Providers choose ordering and may
 * prefer IPv4 or IPv6 according to resolver policy unless `family` is supplied.
 *
 * ```ts no_run
 * import type { DnsProvider, LookupResult } from 'internal:net/dns-provider';
 *
 * async function connectHost(provider: DnsProvider, host: string) {
 *   const result: LookupResult = await provider.lookup(host, { family: 4 });
 *   return `${result.address}:443`;
 * }
 * ```
 *
 * @internal
 */
export interface LookupResult {
  /**
   * Numeric IP address returned by the resolver.
   *
   * The value is not a hostname. Failed lookups reject at the provider method
   * rather than returning an empty address.
   *
   * ```ts
   * const result = { address: '::1', family: 6 };
   * result.address;
   * ```
   */
  address: string;
  /**
   * IP family for `address`.
   *
   * `4` indicates IPv4 and `6` indicates IPv6. The value should match the
   * caller's requested family when one was provided.
   *
   * ```ts
   * const result = { address: '127.0.0.1', family: 4 };
   * result.family;
   * ```
   */
  family: 4 | 6;
}
/**
 * Mail-exchanger DNS record data.
 *
 * Lower `priority` values are preferred by SMTP clients. Providers return the
 * exchange hostname as it appears after DNS decoding.
 *
 * ```ts no_run
 * import type { DnsProvider, MxRecord } from 'internal:net/dns-provider';
 *
 * async function primaryMx(provider: DnsProvider, domain: string) {
 *   const records = (await provider.resolve(domain, 'MX')) as MxRecord[];
 *   return records.sort((a, b) => a.priority - b.priority)[0]?.exchange;
 * }
 * ```
 *
 * @internal
 */
export interface MxRecord {
  /**
   * MX preference value.
   *
   * Lower values are more preferred. Providers do not sort records unless their
   * concrete implementation documents that behavior.
   *
   * ```ts
   * const mx = { priority: 10, exchange: 'mail.example.com' };
   * mx.priority;
   * ```
   */
  priority: number;
  /**
   * Hostname of the mail exchanger.
   *
   * The value may be absolute or relative according to the DNS response parser.
   *
   * ```ts
   * const mx = { priority: 10, exchange: 'mail.example.com' };
   * mx.exchange;
   * ```
   */
  exchange: string;
}
/**
 * Start-of-authority DNS record data.
 *
 * SOA records describe authority and timing metadata for a zone. Time fields
 * are expressed in seconds as decoded from the DNS response.
 *
 * A successful `resolve(name, 'SOA')` returns a single-element array, since a
 * zone has exactly one SOA record at its apex.
 *
 * ```ts no_run
 * import type { DnsProvider, SoaRecord } from 'internal:net/dns-provider';
 *
 * async function zoneSerial(provider: DnsProvider, zone: string) {
 *   const [soa] = (await provider.resolve(zone, 'SOA')) as SoaRecord[];
 *   return soa.serial;
 * }
 * ```
 *
 * @internal
 */
export interface SoaRecord {
  /**
   * Primary authoritative nameserver.
   *
   * ```ts
   * const soa = { nsname: 'ns.example.com', hostmaster: 'hostmaster.example.com', serial: 1, refresh: 1, retry: 1, expire: 1, minttl: 1 };
   * soa.nsname;
   * ```
   *
   */
  nsname: string;
  /**
   * Responsible mailbox encoded as a DNS hostname.
   *
   * ```ts
   * const soa = { nsname: 'ns.example.com', hostmaster: 'hostmaster.example.com', serial: 1, refresh: 1, retry: 1, expire: 1, minttl: 1 };
   * soa.hostmaster;
   * ```
   *
   */
  hostmaster: string;
  /**
   * Zone serial number used by secondary servers.
   *
   * ```ts
   * const soa = { nsname: 'ns.example.com', hostmaster: 'hostmaster.example.com', serial: 42, refresh: 1, retry: 1, expire: 1, minttl: 1 };
   * soa.serial;
   * ```
   *
   */
  serial: number;
  /**
   * Refresh interval in seconds.
   *
   * ```ts
   * const soa = { nsname: 'ns.example.com', hostmaster: 'hostmaster.example.com', serial: 1, refresh: 3600, retry: 1, expire: 1, minttl: 1 };
   * soa.refresh;
   * ```
   *
   */
  refresh: number;
  /**
   * Retry interval in seconds.
   *
   * ```ts
   * const soa = { nsname: 'ns.example.com', hostmaster: 'hostmaster.example.com', serial: 1, refresh: 1, retry: 600, expire: 1, minttl: 1 };
   * soa.retry;
   * ```
   *
   */
  retry: number;
  /**
   * Expire interval in seconds.
   *
   * ```ts
   * const soa = { nsname: 'ns.example.com', hostmaster: 'hostmaster.example.com', serial: 1, refresh: 1, retry: 1, expire: 86400, minttl: 1 };
   * soa.expire;
   * ```
   *
   */
  expire: number;
  /**
   * Minimum TTL in seconds.
   *
   * ```ts
   * const soa = { nsname: 'ns.example.com', hostmaster: 'hostmaster.example.com', serial: 1, refresh: 1, retry: 1, expire: 1, minttl: 60 };
   * soa.minttl;
   * ```
   *
   */
  minttl: number;
}
/**
 * Service-location DNS record data.
 *
 * SRV records identify a service target host and port plus selection metadata.
 * Providers return decoded records; client-side priority/weight selection is
 * left to higher layers.
 *
 * ```ts no_run
 * import type { DnsProvider, SrvRecord } from 'internal:net/dns-provider';
 *
 * async function locateService(provider: DnsProvider, name: string) {
 *   const records = (await provider.resolve(name, 'SRV')) as SrvRecord[];
 *   const target = records.sort((a, b) => a.priority - b.priority)[0];
 *   return target ? `${target.name}:${target.port}` : null;
 * }
 * ```
 *
 * @internal
 */
export interface SrvRecord {
  /**
   * SRV priority; lower values are preferred.
   *
   * ```ts
   * const srv = { priority: 0, weight: 10, port: 443, name: 'api.example.com' };
   * srv.priority;
   * ```
   *
   */
  priority: number;
  /**
   * SRV weight used to balance records with the same priority.
   *
   * ```ts
   * const srv = { priority: 0, weight: 10, port: 443, name: 'api.example.com' };
   * srv.weight;
   * ```
   *
   */
  weight: number;
  /**
   * Target service port.
   *
   * ```ts
   * const srv = { priority: 0, weight: 10, port: 443, name: 'api.example.com' };
   * srv.port;
   * ```
   *
   */
  port: number;
  /**
   * Target service hostname.
   *
   * ```ts
   * const srv = { priority: 0, weight: 10, port: 443, name: 'api.example.com' };
   * srv.name;
   * ```
   *
   */
  name: string;
}
/**
 * Decoded DNS record payload used by provider implementations.
 *
 * The concrete member depends on the requested RR type: address-like records
 * (`A`, `AAAA`, `NS`, `CNAME`, `PTR`) are strings, `TXT` is `string[]`, `MX`,
 * `SOA`, and `SRV` are their record objects, binary or unknown data may be a
 * `Uint8Array`, and explicitly empty records may be `null`. Callers narrow the
 * union based on the `rrtype` they passed to `resolve()`.
 *
 * ```ts no_run
 * import type { DnsProvider, DnsRecordData } from 'internal:net/dns-provider';
 *
 * async function firstAddress(provider: DnsProvider, host: string) {
 *   const records: DnsRecordData[] = await provider.resolve(host, 'A');
 *   return records.find((r): r is string => typeof r === 'string');
 * }
 * ```
 *
 * @internal
 */
export type DnsRecordData =
  | string
  | string[]
  | MxRecord
  | SoaRecord
  | SrvRecord
  | Uint8Array
  | null;
/**
 * DNS resource-record types accepted by `DnsProvider.resolve()`.
 *
 * The default record type is provider-defined by the abstract signature and is
 * currently `A` in concrete callers that omit it. Each value maps to a standard
 * DNS resource-record type: address (`A`, `AAAA`), delegation (`NS`), aliasing
 * (`CNAME`, `PTR`), zone authority (`SOA`), mail (`MX`), text (`TXT`), and
 * service location (`SRV`).
 *
 * ```ts no_run
 * import type { DnsProvider, RRType } from 'internal:net/dns-provider';
 *
 * async function queryAll(provider: DnsProvider, host: string, types: RRType[]) {
 *   return Promise.all(types.map((t) => provider.resolve(host, t)));
 * }
 * ```
 *
 * @internal
 */
export type RRType = 'A' | 'NS' | 'CNAME' | 'SOA' | 'PTR' | 'MX' | 'TXT' | 'AAAA' | 'SRV';
// ---------------------------------------------------------------------------
// DnsProvider - abstract base
// ---------------------------------------------------------------------------
/**
 * Abstract base class for DNS providers.
 *
 * Providers resolve hostnames to IP addresses and perform reverse lookups.
 * The system provider queries real nameservers over UDP; virtual providers
 * may resolve Realm names within a VirtualNetwork routing table. Concrete
 * subclasses must implement all five methods; the base class supplies no
 * default behavior and exists only to fix the shared contract.
 *
 * Subclass this to interpose a custom resolution policy — for example a static
 * host table for tests, or a routing layer that maps logical names to in-process
 * Realms — while keeping the same surface the rest of the runtime consumes.
 *
 * ```ts no_run
 * import { DnsProvider, type LookupResult, type DnsRecordData, type RRType } from 'internal:net/dns-provider';
 *
 * class HostsFileProvider extends DnsProvider {
 *   #table: Map<string, string>;
 *   #servers: string[] = [];
 *
 *   constructor(entries: Record<string, string>) {
 *     super();
 *     this.#table = new Map(Object.entries(entries));
 *   }
 *
 *   async lookup(hostname: string): Promise<LookupResult> {
 *     const address = this.#table.get(hostname);
 *     if (!address) throw new Error(`no entry for ${hostname}`);
 *     return { address, family: address.includes(':') ? 6 : 4 };
 *   }
 *
 *   async resolve(hostname: string, _rrtype: RRType = 'A'): Promise<DnsRecordData[]> {
 *     const address = this.#table.get(hostname);
 *     return address ? [address] : [];
 *   }
 *
 *   async reverse(ip: string): Promise<string[]> {
 *     return [...this.#table].filter(([, v]) => v === ip).map(([k]) => k);
 *   }
 *
 *   getServers(): string[] { return [...this.#servers]; }
 *   setServers(servers: string[]): void { this.#servers = [...servers]; }
 * }
 *
 * const provider = new HostsFileProvider({ 'service.local': '127.0.0.1' });
 * const { address } = await provider.lookup('service.local');
 * ```
 */
export abstract class DnsProvider {
  /**
   * Resolve a hostname to a single IP address, equivalent to getaddrinfo.
   *
   * Pass `opts.family` as `4` or `6` to restrict the address family; when it is
   * omitted the provider selects a family according to its own policy. The
   * promise resolves with exactly one selected address or rejects on resolver,
   * timeout, unsupported-family, or not-found errors. No empty result shape is
   * returned for failed lookups — callers should expect a rejection instead.
   *
   * ```ts no_run
   * const result = await provider.lookup('example.com', { family: 4 });
   * const socket = await connect(result.address, 443);
   * ```
   */
  abstract lookup(
    hostname: string,
    opts?: {
      family?: 4 | 6;
    },
  ): Promise<LookupResult>;
  /**
   * Query DNS records of a given resource-record type.
   *
   * The `rrtype` selects which records to return and defaults according to the
   * concrete provider, generally `A`. The element type of the resolved array
   * depends on `rrtype`, as documented by `DnsRecordData`. Successful queries may
   * return an empty array when the name exists but carries no matching records;
   * the promise rejects only on resolver or transport errors.
   *
   * ```ts no_run
   * const records = await provider.resolve('example.com', 'MX');
   * for (const mx of records as MxRecord[]) console.log(mx.priority, mx.exchange);
   * ```
   */
  abstract resolve(hostname: string, rrtype?: RRType): Promise<DnsRecordData[]>;
  /**
   * Reverse-resolve an IP address to hostnames.
   *
   * The promise resolves with zero or more PTR names, or rejects on resolver
   * errors. The provider does not validate that the returned names resolve back
   * to the original address.
   *
   * ```ts no_run
   * const names = await provider.reverse('127.0.0.1');
   * names.length;
   * ```
   */
  abstract reverse(ip: string): Promise<string[]>;
  /**
   * Return the current list of nameserver addresses.
   *
   * The returned array should be a snapshot; mutating it must not change the
   * provider until `setServers()` is called.
   *
   * ```ts no_run
   * const servers = provider.getServers();
   * servers.length;
   * ```
   */
  abstract getServers(): string[];
  /**
   * Override the nameserver list.
   *
   * Providers may validate server address syntax immediately or on the next
   * query. Passing an empty array requests provider-specific fallback behavior
   * or no available nameservers.
   *
   * ```ts no_run
   * provider.setServers(['1.1.1.1', '8.8.8.8']);
   * ```
   */
  abstract setServers(servers: string[]): void;
}
