/**
 * Real HTTP OpenTelemetry integration coverage.
 *
 * This suite exercises the actual `serveHttp()` and `fetch()` runtime path rather
 * than publishing runtime topics directly.
 */

import { describe, it } from 'fino:test/test';
import { serveHttp } from 'fino:net/http/server';
import {
  BatchSpanProcessor,
  DnsInstrumentation,
  FetchInstrumentation,
  HttpServerInstrumentation,
  InMemoryExporter,
  OtelSDK,
  SocketInstrumentation,
} from 'fino:opentelemetry';

function mark(_message: string): void {
  // no-op; set FINO_NETWORK_TESTS_DEBUG=1 and add console.log here to debug
}

function startServer(handler: Parameters<typeof serve>[1]) {
  const ports = [19981, 19982, 19983, 19984, 19985];
  let lastError: unknown = null;
  for (const port of ports) {
    try {
      return serveHttp({ port, hostname: '127.0.0.1' }, handler);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('unable to bind test server port');
}

describe('OpenTelemetry HTTP Integration', () => {
  it('exports spans for real serveHttp() and fetch() HTTP traffic', async (t) => {
    mark('starting sdk');
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [
        new HttpServerInstrumentation(),
        new FetchInstrumentation(),
        new DnsInstrumentation(),
        new SocketInstrumentation(),
      ],
    }).start();

    mark('starting server');
    const server = startServer(async (req) => {
      return Response.json({
        method: req.method,
        path: new URL(req.url).pathname,
      });
    });

    try {
      const url = `http://127.0.0.1:${server.port}/items/42`;
      mark(`fetching ${url}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      t.equal(response.status, 200, 'real HTTP request succeeded');
      t.deepEqual(await response.json(), { method: 'GET', path: '/items/42' }, 'server handled real request');

      mark('flushing sdk');
      await sdk.flush();

      const spans = exporter.getFinishedSpans();
      const clientSpan = spans.find((span) => span.kind === 'client' && span.attributes?.['url.full'] === url);
      const serverSpan = spans.find((span) => span.kind === 'server' && span.attributes?.['http.route'] === '/items/42');
      const dnsSpan = spans.find((span) => span.name === 'DNS 127.0.0.1');
      const socketSpan = spans.find((span) => span.name === `CONNECT 127.0.0.1:${server.port}`);

      t.ok(clientSpan, 'real fetch() produced a client span');
      t.ok(serverSpan, 'real serveHttp() produced a server span');
      t.ok(dnsSpan, 'real fetch() produced a DNS span');
      t.ok(socketSpan, 'real fetch() produced a socket connect span');
      if (!clientSpan || !serverSpan) throw new Error('expected both client and server spans');
      t.equal(clientSpan.attributes?.['http.request.method'], 'GET', 'client span recorded method');
      t.equal(serverSpan.attributes?.['http.request.method'], 'GET', 'server span recorded method');
      t.equal(serverSpan.attributes?.['http.route'], '/items/42', 'server span recorded path route');
      t.equal(clientSpan.attributes?.['http.response.status_code'], 200, 'client span recorded status');
      t.equal(serverSpan.attributes?.['http.response.status_code'], 200, 'server span recorded status');
      t.equal(serverSpan.parentSpanId, clientSpan.spanId, 'server span extracted the propagated client context');
      t.equal(serverSpan.traceId, clientSpan.traceId, 'server and client spans share a trace');
      t.equal(dnsSpan?.attributes?.['dns.question.name'], '127.0.0.1', 'DNS span records lookup host');
      t.equal(socketSpan?.attributes?.['net.peer.port'], server.port, 'socket span records target port');
    } finally {
      mark('closing server');
      await server.close();
      mark('shutting down sdk');
      await sdk.shutdown();
      mark('done');
    }
  });
});
