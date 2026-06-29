/**
* net/http/h3 — internal HTTP/3 client and server helpers.
*
* This module exposes the HTTP/3 integration built on Fino's QUIC transport
* and libnghttp3 bindings for internal wiring, conformance tests, and
* interoperability experiments. Applications should reach HTTP/3 through
* global `fetch`, `fino:net/http/server`, or `fino:net/http/client`.
*
* HTTP/3 requires QUIC support, TLS certificate material for servers, and a
* local libnghttp3 installation. When libnghttp3 is unavailable, `requireH3()`,
* `serve()`, and `fetch()` fail before opening sockets. That fail-fast path is
* release-supported: builds without libnghttp3 may skip HTTP/3 behavior, while
* builds that enable libnghttp3 must pass the local simulated and loopback H3
* tests in `tests/net/quic-h3.test.ts`.
*
* Current release scope is request/response HTTP/3 over QUIC. This helper's
* `fetch()` resolves URL hostnames through `fino:net/dns` before connecting
* while keeping the URL host as the default TLS SNI name. Connection reuse,
* WebTransport/Capsule, H3 DATAGRAM, CONNECT tunnels, and external H3 interop
* lanes are intentionally deferred and documented in the QUIC/H3 research
* notes.
*
* ```ts no_run
* import { h3Available, serve } from '../../js/net/http/h3.ts';
*
* if (h3Available) {
*   const server = await serve({
*     port: 4433,
*     certificateFile: './cert.pem',
*     privateKeyFile: './key.pem',
*   }, () => new Response('ok'));
*   await server.close();
* }
* ```
*
* Learn more:
* - HTTP/3: https://www.rfc-editor.org/rfc/rfc9114
* - QUIC: https://www.rfc-editor.org/rfc/rfc9000
*
* @internal
*/
import { QuicEndpoint, QuicConnectionEvent } from '../quic.ts';
import { H3ServerDriver } from '../../internal/net/http/h3/server.ts';
import type { H3ServerDriverOptions } from '../../internal/net/http/h3/server.ts';
import { H3ClientSession } from '../../internal/net/http/h3/client.ts';
import type { H3RequestInit } from '../../internal/net/http/h3/client.ts';
import { h3Available as _h3Available, requireH3 as _requireH3 } from '../../internal/net/http/h3/bindings.ts';
import { resolveH3ConnectAddress } from '../../internal/net/http/h3/resolve.ts';
import type { QuicConnectOptions, QuicListenOptions } from '../quic.ts';
/**
* Whether libnghttp3 was loaded successfully.
*
* This flag only reports the HTTP/3 library binding state. Callers that need a
* full server or client path should also account for QUIC availability,
* certificate configuration, and network errors. `false` is a supported
* release configuration when HTTP/3 is optional.
*/
export const h3Available = _h3Available;
/**
* Return the loaded libnghttp3 binding or throw an installation hint.
*
* Use this during startup when HTTP/3 is mandatory. Optional HTTP/3 features
* should usually check `h3Available` and choose a fallback instead. The throw
* path is intentionally early so missing libnghttp3 does not open sockets or
* partially initialize QUIC state.
*
* @returns The loaded libnghttp3 dynamic-library handle.
* @throws When libnghttp3 cannot be loaded on this system.
*/
export function requireH3(): ReturnType<typeof _requireH3> {
  return _requireH3();
}
/**
* Options for `serve()`.
*
* `port` is required. `hostname` defaults to `127.0.0.1`; pass an explicit
* address to listen elsewhere. Certificate options match `fino:net/quic` and
* are file paths read by the QUIC TLS layer.
*/
export interface H3ServeOptions extends Omit<QuicListenOptions, 'address' | 'alpnProtocols' | 'certificateFile' | 'privateKeyFile'> {
  /** UDP port for the QUIC listener. Use `0` to request an ephemeral port. */
  port: number;
  /** Local bind address. Defaults to `127.0.0.1`. */
  hostname?: string;
  /** PEM certificate chain file presented by the HTTP/3 server. */
  certificateFile: string;
  /** PEM private key file matching `certificateFile`. */
  privateKeyFile: string;
}
/**
* Running HTTP/3 server handle returned by `serve()`.
*/
export interface H3Server {
  /** Bound UDP port. */
  readonly port: number;
  /** Bound local address. */
  readonly hostname: string;
  /** Close the underlying QUIC endpoint and stop accepting new connections. */
  close(): Promise<void>;
}
/**
* Fetch-compatible HTTP/3 request handler.
*
* Handlers receive a standard `Request` and return a standard `Response`.
* Thrown errors are converted to server-side failures by the H3 driver.
*/
export type H3Handler = (request: Request) => Response | Promise<Response>;
/**
* Options for one-shot HTTP/3 `fetch()`.
*
* `quic` supplies connection-level QUIC options such as `verifyPeer`, `ca`,
* client certificates, transport tuning, or key logging. The URL determines
* the remote address and ALPN is always forced to `h3`.
*/
export interface H3FetchInit extends H3RequestInit {
  quic?: Omit<QuicConnectOptions, 'address' | 'alpnProtocols'>;
}
/**
* Resolved connect target for internal HTTP/3 `fetch()`.
*
* @internal
*/
/**
* Start an HTTP/3 server.
*
* The server listens with ALPN `h3`, accepts QUIC connections, and dispatches
* each request to `handler`. If listener setup fails, the underlying endpoint
* is closed before the error is rethrown.
*
* @param options H3 listener and TLS options.
* @param handler Fetch-compatible request handler.
* @returns A server handle exposing the bound address and close operation.
* @throws When libnghttp3 is unavailable or the QUIC listener cannot start.
*/
export async function serve(options: H3ServeOptions, handler: H3Handler, driverOptions: H3ServerDriverOptions = {}): Promise<H3Server> {
  requireH3();
  const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
  try {
    const { port, hostname = '127.0.0.1', certificateFile, privateKeyFile, ...quicOptions } = options;
    const listener = await endpoint.listen({
      ...quicOptions,
      address: {
        family: hostname.includes(':') ? 'ipv6' : 'ipv4',
        ip: hostname,
        port
      },
      alpnProtocols: ['h3'],
      certificateFile,
      privateKeyFile
    });
    endpoint.addEventListener('connection', (event) => {
      const conn = (event as QuicConnectionEvent).connection;
      const driver = new H3ServerDriver();
      void driver.run(conn, handler, driverOptions).catch(() => {});
    });
    return {
      get port() {
        return listener.address.port;
      },
      get hostname() {
        return listener.address.ip;
      },
      close() {
        return endpoint.close();
      }
    };
  } catch (e) {
    await endpoint.close();
    throw e;
  }
}
/**
* Perform a one-shot HTTP/3 request.
*
* The helper opens a temporary QUIC endpoint, resolves the URL host to a QUIC
* socket address, connects with ALPN `h3`, sends the request, materializes the
* response body and trailers, then closes the endpoint. Use lower-level
* QUIC/H3 session APIs for connection reuse. Automatic H3 origin pooling is
* deferred for this release.
*
* @param url Absolute HTTP/3 URL as a string or `URL`.
* @param init Standard Fetch request options.
* @returns A standard `Response` with body bytes already materialized.
* @throws When libnghttp3 is unavailable, connection setup fails, or the H3
* request is rejected.
*/
export async function fetch(url: string | URL, init: H3FetchInit = {}): Promise<Response> {
  requireH3();
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const { quic, ...requestInit } = init;
  const target = await resolveH3ConnectAddress(parsed);
  const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
  try {
    const conn = await endpoint.connect({
      ...quic,
      address: target.address,
      alpnProtocols: ['h3'],
      serverName: quic?.serverName ?? target.serverName
    });
    using session = await H3ClientSession.create(conn);
    const response = await session.request(url, requestInit);
    // Materialise the body and trailers before closing the connection.
    const body = await response.arrayBuffer();
    const trailers = await (response as any).trailers as Headers | undefined;
    return new Response(body, {
      status: response.status,
      headers: response.headers,
      trailers
    } as any);
  } finally {
    await endpoint.close();
  }
}
