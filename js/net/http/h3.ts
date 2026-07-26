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
 * import { h3Available, serve } from 'internal:net/http/h3';
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
import { QuicEndpoint, QuicConnectionEvent } from '../quic/index.ts';
import { H3ServerDriver } from '../../internal/net/http/h3/server.ts';
import type { H3ServerDriverOptions } from '../../internal/net/http/h3/server.ts';
import { H3ClientSession } from '../../internal/net/http/h3/client.ts';
import type { H3RequestInit } from '../../internal/net/http/h3/client.ts';
import {
  h3Available as _h3Available,
  requireH3 as _requireH3,
} from '../../internal/net/http/h3/bindings.ts';
import { resolveH3ConnectAddress } from '../../internal/net/http/h3/resolve.ts';
import type { QuicConnectOptions, QuicListenOptions } from '../quic/index.ts';
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
 * Use this during startup when HTTP/3 is mandatory, so a missing library fails
 * immediately rather than partway through the first request. Optional HTTP/3
 * features should instead check `h3Available` and fall back to HTTP/2 or
 * HTTP/1. The throw path is intentionally early: it runs before any socket is
 * opened or QUIC state is initialized, so a failed call leaves nothing to tear
 * down.
 *
 * The return value is the loaded libnghttp3 dynamic-library handle, the same
 * one used internally by `serve()` and `fetch()`. Throws when libnghttp3
 * cannot be loaded on this system; the error carries an install hint for the
 * current platform.
 *
 * ```ts no_run
 * import { requireH3, h3Available } from 'internal:net/http/h3';
 *
 * if (!h3Available) {
 *   throw new Error('this deployment requires HTTP/3');
 * }
 * const nghttp3 = requireH3(); // throws with an install hint if missing
 * ```
 */
export function requireH3(): ReturnType<typeof _requireH3> {
  return _requireH3();
}
/**
 * Options for `serve()`.
 *
 * `port` is required; use `0` to request an ephemeral port and read the actual
 * value back from the returned `H3Server`. `hostname` defaults to `127.0.0.1`,
 * so pass an explicit address (for example `::` or `0.0.0.0`) to listen on
 * other interfaces. `certificateFile` and `privateKeyFile` are PEM file paths
 * read by the QUIC TLS layer and match the corresponding `fino:net/quic`
 * options; the remaining QUIC listen options are inherited unchanged, while
 * `address`, `alpnProtocols`, and the certificate fields are managed by
 * `serve()` itself.
 *
 * ```ts no_run
 * import { serve, H3ServeOptions } from 'internal:net/http/h3';
 *
 * const options: H3ServeOptions = {
 *   port: 0,
 *   hostname: '::',
 *   certificateFile: './cert.pem',
 *   privateKeyFile: './key.pem',
 * };
 * const server = await serve(options, () => new Response('ok'));
 * ```
 */
export interface H3ServeOptions extends Omit<
  QuicListenOptions,
  'address' | 'alpnProtocols' | 'certificateFile' | 'privateKeyFile'
> {
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
 *
 * `port` and `hostname` reflect the address the QUIC endpoint actually bound,
 * which matters when `serve()` was called with `port: 0`. `close()` shuts the
 * endpoint down and stops accepting new connections; in-flight connections are
 * torn down by the endpoint.
 *
 * ```ts no_run
 * import { serve } from 'internal:net/http/h3';
 *
 * const server = await serve(
 *   { port: 0, certificateFile: './cert.pem', privateKeyFile: './key.pem' },
 *   () => new Response('ok'),
 * );
 * try {
 *   console.log(`bound to ${server.hostname}:${server.port}`);
 * } finally {
 *   await server.close();
 * }
 * ```
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
 * A handler receives a standard `Request` and returns a `Response`, or a
 * promise of one. Any error it throws is caught by the H3 server driver and
 * turned into a server-side failure on that request's stream rather than
 * crashing the listener, so throwing is a safe way to signal an error.
 *
 * ```ts no_run
 * import { serve, H3Handler } from 'internal:net/http/h3';
 *
 * const handler: H3Handler = async (request) => {
 *   if (request.method !== 'GET') {
 *     return new Response('method not allowed', { status: 405 });
 *   }
 *   return Response.json({ path: new URL(request.url).pathname });
 * };
 * await serve(
 *   { port: 4433, certificateFile: './cert.pem', privateKeyFile: './key.pem' },
 *   handler,
 * );
 * ```
 */
export type H3Handler = (request: Request) => Response | Promise<Response>;
/**
 * Options for one-shot HTTP/3 `fetch()`.
 *
 * Extends the standard H3 request init (method, headers, body) with a `quic`
 * field that supplies connection-level QUIC options such as `verifyPeer`,
 * `ca`, client certificates, transport tuning, or key logging. The `address`
 * and `alpnProtocols` QUIC fields are managed by `fetch()` — the remote address
 * is derived from the URL and ALPN is always forced to `h3` — so they cannot be
 * set here.
 *
 * ```ts no_run
 * import { fetch, H3FetchInit } from 'internal:net/http/h3';
 *
 * const init: H3FetchInit = {
 *   method: 'POST',
 *   body: JSON.stringify({ hello: 'world' }),
 *   headers: { 'content-type': 'application/json' },
 *   quic: { verifyPeer: true, ca: './ca.pem' },
 * };
 * const response = await fetch('https://example.test:4433/echo', init);
 * ```
 */
export interface H3FetchInit extends H3RequestInit {
  /** Connection-level QUIC options for the temporary endpoint. `address` and `alpnProtocols` are set by `fetch()` and cannot be overridden. */
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
 * Opens a QUIC endpoint advertising ALPN `h3`, binds it to the address in
 * `options`, and dispatches every accepted request to `handler`. Each incoming
 * QUIC connection is served by its own `H3ServerDriver`, so a failure while
 * handling one connection is isolated and never tears down the listener.
 * `driverOptions` forwards advanced server-driver tuning and is rarely needed.
 *
 * If the listener cannot bind — an in-use port, an invalid certificate, or
 * missing libnghttp3 — the underlying endpoint is closed before the error is
 * rethrown, so a failed `serve()` never leaks a socket. Throws when libnghttp3
 * is unavailable or the QUIC listener cannot start.
 *
 * The returned handle reports the address that was actually bound, which is how
 * you recover the concrete port after passing `port: 0`.
 *
 * ```ts no_run
 * import { serve } from 'internal:net/http/h3';
 *
 * const server = await serve(
 *   { port: 4433, certificateFile: './cert.pem', privateKeyFile: './key.pem' },
 *   async (request) => Response.json({ path: new URL(request.url).pathname }),
 * );
 * console.log(`listening on https://${server.hostname}:${server.port}`);
 * await server.close();
 * ```
 */
export async function serve(
  options: H3ServeOptions,
  handler: H3Handler,
  driverOptions: H3ServerDriverOptions = {},
): Promise<H3Server> {
  requireH3();
  const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
  try {
    const {
      port,
      hostname = '127.0.0.1',
      certificateFile,
      privateKeyFile,
      ...quicOptions
    } = options;
    const listener = await endpoint.listen({
      ...quicOptions,
      address: {
        family: hostname.includes(':') ? 'ipv6' : 'ipv4',
        ip: hostname,
        port,
      },
      alpnProtocols: ['h3'],
      certificateFile,
      privateKeyFile,
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
      },
    };
  } catch (e) {
    await endpoint.close();
    throw e;
  }
}
/**
 * Perform a one-shot HTTP/3 request.
 *
 * Accepts an absolute HTTP/3 URL as a string or `URL` plus standard Fetch
 * request options. Opens a temporary QUIC endpoint, resolves the URL host to a
 * QUIC socket address through `fino:net/dns`, connects with ALPN `h3` (keeping
 * the URL host as the default TLS SNI name), sends the request, fully
 * materializes the response body and trailers, then closes the endpoint before
 * resolving. Connection-level QUIC settings — peer verification, a custom CA,
 * client certificates, key logging — go through `init.quic`.
 *
 * Because the endpoint is discarded after each call there is no connection
 * reuse; drive `H3ClientSession` directly when issuing many requests to one
 * origin. Automatic H3 origin pooling is deferred for this release.
 *
 * Resolves to a standard `Response` whose body bytes are already in memory, so
 * a following `arrayBuffer()`, `json()`, or `text()` never blocks on the
 * network. Throws when libnghttp3 is unavailable, connection setup fails, or
 * the server rejects the request.
 *
 * ```ts no_run
 * import { fetch } from 'internal:net/http/h3';
 *
 * const response = await fetch('https://localhost:4433/health', {
 *   headers: { accept: 'application/json' },
 *   quic: { verifyPeer: false },
 * });
 * console.log(response.status, await response.json());
 * ```
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
      serverName: quic?.serverName ?? target.serverName,
    });
    using session = await H3ClientSession.create(conn);
    const response = await session.request(url, requestInit);
    // Materialise the body and trailers before closing the connection.
    const body = await response.arrayBuffer();
    const trailers = (await (response as any).trailers) as Headers | undefined;
    return new Response(body, {
      status: response.status,
      headers: response.headers,
      trailers,
    } as any);
  } finally {
    await endpoint.close();
  }
}
