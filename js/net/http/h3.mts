import { QuicEndpoint, QuicConnectionEvent } from '../quic.mts';
import { H3ServerDriver } from '../../internal/net/http/h3/server.mts';
import { H3ClientSession } from '../../internal/net/http/h3/client.mts';
import { h3Available as _h3Available, requireH3 as _requireH3 } from '../../internal/net/http/h3/bindings.mts';
import type { QuicListenOptions } from '../quic.mts';

export { _h3Available as h3Available, _requireH3 as requireH3 };

export interface H3TlsOptions {
  cert: string;
  key: string;
}

export interface H3ServeOptions extends Partial<QuicListenOptions> {
  port: number;
  hostname?: string;
  tls: H3TlsOptions;
}

export interface H3Server {
  readonly port: number;
  readonly hostname: string;
  close(): Promise<void>;
}

export type H3Handler = (request: Request) => Response | Promise<Response>;

export async function serve(options: H3ServeOptions, handler: H3Handler): Promise<H3Server> {
  _requireH3();

  const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'], tls: options.tls });
  try {
    const listener = await endpoint.listen({ port: options.port, hostname: options.hostname ?? '127.0.0.1' });

    endpoint.addEventListener('connection', (event) => {
      const conn = (event as QuicConnectionEvent).connection;
      const driver = new H3ServerDriver();
      void driver.run(conn, handler).catch(() => {});
    });

    return {
      get port()     { return listener.address.port; },
      get hostname() { return listener.address.ip; },
      close()        { return endpoint.close(); },
    };
  } catch (e) {
    await endpoint.close();
    throw e;
  }
}

export async function fetch(url: string | URL, init?: RequestInit): Promise<Response> {
  _requireH3();

  const parsed = typeof url === 'string' ? new URL(url) : url;
  const port   = parsed.port ? Number(parsed.port) : 443;

  const family = parsed.hostname.includes(':') ? 'ipv6' : 'ipv4';
  const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });
  try {
    const conn = await endpoint.connect({
      address: { family, ip: parsed.hostname, port },
      serverName: parsed.hostname,
    });

    using session = await H3ClientSession.create(conn);
    const response = await session.request(url, init);

    // Materialise the body and trailers before closing the connection.
    const body = await response.arrayBuffer();
    const trailers = await (response as any).trailers as Headers | undefined;
    return new Response(body, { status: response.status, headers: response.headers, trailers } as any);
  } finally {
    await endpoint.close();
  }
}
