/**
 * internal:net/dns-provider — Abstract DnsProvider interface.
 *
 * Defines the contract all DNS providers must satisfy. Concrete
 * implementations include:
 *   - SystemDnsProvider — resolves via /etc/resolv.conf over UDP (fino:net/dns)
 *   - StaticDnsProvider — configurable static hostname→IP mapping (future)
 *   - VirtualDnsProvider — resolves Realm names within a VirtualNetwork (future)
 *   - RestrictedDnsProvider — hostname allowlist/blocklist (future)
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface LookupResult {
  address: string;
  family: 4 | 6;
}

export interface MxRecord   { priority: number; exchange: string; }
export interface SoaRecord  { nsname: string; hostmaster: string; serial: number; refresh: number; retry: number; expire: number; minttl: number; }
export interface SrvRecord  { priority: number; weight: number; port: number; name: string; }

export type DnsRecordData = string | string[] | MxRecord | SoaRecord | SrvRecord | Uint8Array | null;

export type RRType = 'A' | 'NS' | 'CNAME' | 'SOA' | 'PTR' | 'MX' | 'TXT' | 'AAAA' | 'SRV';

// ---------------------------------------------------------------------------
// DnsProvider — abstract base
// ---------------------------------------------------------------------------

/**
 * Abstract base class for DNS providers.
 *
 * Providers resolve hostnames to IP addresses and perform reverse lookups.
 * The system provider queries real nameservers over UDP; virtual providers
 * may resolve Realm names within a VirtualNetwork routing table.
 */
export abstract class DnsProvider {
  /**
   * Resolve a hostname to an IP address (equivalent to getaddrinfo).
   * @param hostname  The hostname to resolve.
   * @param opts      Optional: { family: 4 | 6 } to restrict address family.
   */
  abstract lookup(hostname: string, opts?: { family?: 4 | 6 }): Promise<LookupResult>;

  /**
   * Query DNS records of the given type.
   * @param hostname  The hostname to query.
   * @param rrtype    Record type: 'A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'SRV', 'PTR'
   */
  abstract resolve(hostname: string, rrtype?: RRType): Promise<DnsRecordData[]>;

  /** Reverse-resolve an IP address to hostnames. */
  abstract reverse(ip: string): Promise<string[]>;

  /** Return the current list of nameserver addresses. */
  abstract getServers(): string[];

  /** Override the nameserver list. */
  abstract setServers(servers: string[]): void;
}
