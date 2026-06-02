/**
 * internal:net/dns-provider - Abstract DnsProvider interface.
 *
 * Defines the contract all DNS providers must satisfy. Concrete
 * implementations include:
 *   - SystemDnsProvider - resolves via /etc/resolv.conf over UDP (fino:net/dns)
 *   - StaticDnsProvider - configurable static hostname->IP mapping (future)
 *   - VirtualDnsProvider - resolves Realm names within a VirtualNetwork (future)
 *   - RestrictedDnsProvider - hostname allowlist/blocklist (future)
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
 * ```ts
 * const result = { address: '127.0.0.1', family: 4 };
 * result.family;
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
 * ```ts
 * const mx = { priority: 10, exchange: 'mail.example.com' };
 * mx.exchange;
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
 * ```ts
 * const soa = { nsname: 'ns.example.com', hostmaster: 'hostmaster.example.com', serial: 1, refresh: 3600, retry: 600, expire: 86400, minttl: 60 };
 * soa.serial;
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
 * ```ts
 * const srv = { priority: 0, weight: 10, port: 443, name: 'api.example.com' };
 * srv.port;
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
 * are strings, TXT is `string[]`, binary/unknown data may be `Uint8Array`, and
 * explicitly empty records may be `null`.
 *
 * ```ts
 * const data = '127.0.0.1';
 * data;
 * ```
 *
 * @internal
 */
export type DnsRecordData = string | string[] | MxRecord | SoaRecord | SrvRecord | Uint8Array | null;

/**
 * DNS resource-record types accepted by `DnsProvider.resolve()`.
 *
 * The default record type is provider-defined by the abstract signature and is
 * currently `A` in concrete callers that omit it.
 *
 * ```ts
 * const rrtype = 'AAAA';
 * rrtype;
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
 * may resolve Realm names within a VirtualNetwork routing table.
 *
 * @example
 * ```ts no_run
 * const documentedClass = 'DnsProvider';
 * console.log(documentedClass);
 * ```
 */
export abstract class DnsProvider {
  /**
   * Resolve a hostname to an IP address (equivalent to getaddrinfo).
   * @param hostname  The hostname to resolve.
   * @param opts      Optional: { family: 4 | 6 } to restrict address family.
   *
   * The promise resolves with one selected address or rejects on resolver,
   * timeout, unsupported-family, or not-found errors. No empty result shape is
   * returned for failed lookups.
   *
   * ```ts no_run
   * const result = await provider.lookup('example.com', { family: 4 });
   * result.address;
   * ```
   */
  abstract lookup(hostname: string, opts?: { family?: 4 | 6 }): Promise<LookupResult>;

  /**
   * Query DNS records of the given type.
   * @param hostname  The hostname to query.
   * @param rrtype    Record type: 'A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'SRV', 'PTR'
   *
   * `rrtype` defaults according to the concrete provider, generally `A`.
   * Successful queries may return an empty array when the name exists but no
   * matching records are present.
   *
   * ```ts no_run
   * const records = await provider.resolve('example.com', 'MX');
   * records.length;
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
