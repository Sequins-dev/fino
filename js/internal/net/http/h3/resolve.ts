/**
 * internal:net/http/h3/resolve - HTTP/3 client target resolution.
 *
 * QUIC connects to a numeric socket address, but a URL carries a hostname and,
 * separately, the identity that TLS must certify. This module bridges the two:
 * it performs a DNS lookup to turn the URL host into a concrete IP address and
 * port for the transport, while carrying the original hostname forward as the
 * default TLS SNI (server name) so certificate validation checks the name the
 * caller typed rather than the resolved IP.
 *
 * The lookup requests an IPv6 address when the hostname contains a colon (an
 * IPv6 literal) and IPv4 otherwise, and defaults to port 443 when the URL omits
 * one. Bracketed IPv6 literals (`[::1]`) are unwrapped before lookup so the
 * returned SNI is the bare address. The DNS resolver is injectable purely so
 * tests can supply a deterministic stub; production callers rely on the
 * default `fino:net/dns` lookup.
 *
 * Both the public direct H3 helper (`fino:net/http/h3`) and the pooled
 * `HttpClient` call this to build their QUIC connect target. It is not part of
 * the application-facing HTTP API.
 *
 * ```ts no_run
 *   import { resolveH3ConnectAddress } from 'internal:net/http/h3/resolve';
 *   import { QuicEndpoint } from 'fino:net/quic';
 *
 *   const target = await resolveH3ConnectAddress(new URL('https://example.com/'));
 *   const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
 *   const conn = await endpoint.connect({
 *     address: target.address,        // { family, ip, port } for QUIC
 *     alpnProtocols: ['h3'],
 *     serverName: target.serverName   // original hostname, used as TLS SNI
 *   });
 * ```
 *
 * @internal
 */
import { lookup } from 'fino:net/dns';
import type { LookupOptions, LookupResult } from 'fino:net/dns';
import type { QuicConnectOptions } from '../../../../net/quic/index.ts';
/**
 * The resolved connect coordinates for an HTTP/3 request.
 *
 * Splits a URL into the two pieces a QUIC handshake needs separately: the
 * numeric `address` the datagram socket dials, and the `serverName` that TLS
 * presents as SNI and validates the peer certificate against. Keeping them
 * apart is what lets a connection to a resolved IP still authenticate the
 * original hostname.
 *
 * ```ts no_run
 *   import { resolveH3ConnectAddress } from 'internal:net/http/h3/resolve';
 *
 *   const t = await resolveH3ConnectAddress(new URL('https://[::1]:8443/'));
 *   t.address;     // { family: 'ipv6', ip: '::1', port: 8443 }
 *   t.serverName;  // '::1'  (brackets stripped, used for SNI)
 * ```
 */
export interface H3ConnectTarget {
  /**
   * QUIC socket address to connect to: the family (`'ipv4'`/`'ipv6'`), the
   * IP produced by the DNS lookup, and the port (the URL's port, or 443).
   */
  address: QuicConnectOptions['address'];
  /**
   * TLS SNI host, taken from the original URL hostname before resolution.
   * Pass this as the QUIC `serverName` so the certificate is checked against
   * the name the caller requested rather than the resolved IP.
   */
  serverName: string;
}
type H3Lookup = (hostname: string, opts: LookupOptions) => Promise<LookupResult>;
function urlHostname(url: URL): string {
  const hostname = url.hostname;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}
/**
 * Resolve an HTTP/3 URL host into the QUIC connect address.
 *
 * Reads the hostname and port from `url`, unwraps a bracketed IPv6 literal,
 * runs a DNS lookup (IPv6 when the hostname contains a colon, IPv4 otherwise),
 * and returns both the numeric QUIC `address` and the `serverName` to use for
 * TLS SNI. When the URL has no port, 443 is assumed. The returned `family`
 * reflects what the resolver actually returned, not what was requested.
 *
 * The `resolve` parameter overrides the DNS resolver and exists for testing;
 * it defaults to the `fino:net/dns` `lookup`. It rejects if the underlying
 * lookup rejects (for example, an unresolvable host).
 *
 * ```ts no_run
 *   import { resolveH3ConnectAddress } from 'internal:net/http/h3/resolve';
 *
 *   // Default resolver
 *   const target = await resolveH3ConnectAddress(new URL('https://example.com/'));
 *
 *   // Injected stub, e.g. in a test
 *   const stub = async () => ({ address: '203.0.113.7', family: 4 });
 *   const local = await resolveH3ConnectAddress(new URL('https://host:9443/'), stub);
 *   local.address; // { family: 'ipv4', ip: '203.0.113.7', port: 9443 }
 * ```
 *
 * @internal
 */
export async function resolveH3ConnectAddress(
  url: URL,
  resolve: H3Lookup = lookup,
): Promise<H3ConnectTarget> {
  const hostname = urlHostname(url);
  const port = url.port ? Number(url.port) : 443;
  const result = await resolve(hostname, { family: hostname.includes(':') ? 6 : 4 });
  return {
    address: {
      family: result.family === 6 ? 'ipv6' : 'ipv4',
      ip: result.address,
      port,
    },
    serverName: hostname,
  };
}
