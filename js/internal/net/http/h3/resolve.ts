/**
 * internal:net/http/h3/resolve - HTTP/3 client target resolution.
 *
 * Resolves a URL host into the concrete QUIC socket address required by the
 * transport while preserving the original URL hostname as the default TLS SNI
 * name. This is shared by the public direct H3 helper and `HttpClient` but is
 * not part of the application-facing HTTP API.
 *
 * @internal
 */

import { lookup } from 'fino:net/dns';
import type { LookupOptions, LookupResult } from 'fino:net/dns';
import type { QuicConnectOptions } from '../../../../net/quic.ts';

export interface H3ConnectTarget {
  /** QUIC socket address to connect to. */
  address: QuicConnectOptions['address'];
  /** TLS SNI host derived from the original URL hostname. */
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
 * @internal
 */
export async function resolveH3ConnectAddress(url: URL, resolve: H3Lookup = lookup): Promise<H3ConnectTarget> {
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
