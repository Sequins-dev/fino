/**
 * Tests for fino:load and the `fino load` command.
 */
import { describe, it } from 'fino:test/test';
import { formatLoadResult, runLoad } from 'fino:load';
import type { LoadResult } from 'fino:load';
import loadCommand from 'internal:commands/load';
import { runClosedLoopPhase } from 'internal:load';
import { LogHistogram } from 'internal:statistics';
import { serveHttp } from 'fino:net/http/server';
import { h2Available } from '../js/net/http/h2.ts';
import { h3Available, serve as h3Serve } from 'internal:net/http/h3';
import { quicAvailable } from 'fino:net/quic';
import { DiskFileSystem } from 'fino:file';

const CERT_PATH = new URL('./net/fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH = new URL('./net/fixtures/test.key', import.meta.url).pathname;
const tlsAvailable = (
  globalThis as typeof globalThis & {
    tlsAvailable?: boolean;
  }
).tlsAvailable;
const skipH2 = (!h2Available || !tlsAvailable) && 'requires libnghttp2 + OpenSSL';
const skipH3 = (!quicAvailable || !h3Available) && 'requires QUIC + libnghttp3';

describe('load scheduler and metrics', () => {
  it('claims an exact request count across concurrent workers', async (t) => {
    const controller = new AbortController();
    let active = 0;
    let maxActive = 0;
    const claimed = await runClosedLoopPhase(
      {
        concurrency: 3,
        requestLimit: 17,
        deadline: null,
        signal: controller.signal,
        now: () => 0,
      },
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
      },
    );
    t.equal(claimed, 17);
    t.equal(maxActive, 3);
  });

  it('stops at a monotonic deadline under a fake clock', async (t) => {
    const controller = new AbortController();
    let now = 0;
    const claimed = await runClosedLoopPhase(
      {
        concurrency: 1,
        requestLimit: null,
        deadline: 5,
        signal: controller.signal,
        now: () => now,
      },
      async () => {
        now++;
      },
    );
    t.equal(claimed, 5);
  });

  it('summarizes latency without retaining observations', (t) => {
    const histogram = new LogHistogram();
    for (let value = 1; value <= 100; value++) histogram.record(value);
    t.equal(histogram.count, 100);
    t.equal(histogram.min, 1);
    t.equal(histogram.mean, 50.5);
    t.ok(histogram.quantile(0.5)! >= 49 && histogram.quantile(0.5)! <= 52);
    t.ok(histogram.quantile(0.99)! >= 97 && histogram.quantile(0.99)! <= 101);
    t.equal(histogram.max, 100);
    t.equal(new LogHistogram().quantile(0.5), null);
  });
});

describe('HTTP load generation', () => {
  it('streams and black-holes exact-count H1 responses', async (t) => {
    let count = 0;
    const server = serveHttp({ port: 0 }, async () => {
      const status = ++count % 2 === 0 ? 503 : 200;
      return new Response(
        {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode('he');
            yield new TextEncoder().encode('llo');
          },
        } as never,
        { status },
      );
    });
    try {
      const result = await runLoad({
        url: `http://127.0.0.1:${server.port}/`,
        connections: 2,
        requests: 12,
      });
      t.equal(result.schemaVersion, 1);
      t.equal(result.counters.offered, 12);
      t.equal(result.counters.started, 12);
      t.equal(result.counters.completed, 12);
      t.equal(result.counters.successful, 6);
      t.equal(result.counters.statusFailed, 6);
      t.equal(result.counters.responseBytes, 60);
      t.equal(result.counters.headersOnly, 0);
      t.equal(result.statusCodes['200'], 6);
      t.equal(result.statusCodes['503'], 6);
      t.equal(result.protocols['http/1.1'], 12);
      t.ok(result.connections.unique <= 2);
      t.ok(result.connections.reusedResponses >= 10);
      t.equal(result.connections.maxActiveOperations, 2);
      t.equal(result.latency.total.count, 12);
      t.ok(formatLoadResult(result).includes('response=consume'));
    } finally {
      await server.close();
    }
  });

  it('excludes warmup traffic and carries its H1 connection into measurement', async (t) => {
    let serverRequests = 0;
    const server = serveHttp({ port: 0 }, async () => {
      serverRequests++;
      return new Response('ok');
    });
    try {
      const result = await runLoad({
        url: `http://127.0.0.1:${server.port}/`,
        connections: 1,
        warmupMs: 20,
        requests: 2,
      });
      t.equal(result.counters.offered, 2);
      t.equal(result.counters.completed, 2);
      t.ok(serverRequests > 2, 'warmup requests reached the server but were not measured');
      t.equal(result.connections.unique, 1);
      t.equal(result.connections.reusedResponses, 2, 'measurement reused the warmed connection');
    } finally {
      await server.close();
    }
  });

  it('stops a real duration run at its measured deadline', async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    try {
      const result = await runLoad({
        url: `http://127.0.0.1:${server.port}/`,
        connections: 1,
        durationMs: 30,
      });
      t.ok(result.counters.offered > 0);
      t.equal(result.config.durationMs, 30);
      t.ok(result.durationMs >= 20 && result.durationMs < 250);
    } finally {
      await server.close();
    }
  });

  it('labels headers-only H1 cancellation and does not count body bytes', async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = serveHttp(
      { port: 0 },
      async () =>
        new Response({
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode('started');
            await gate;
            yield new TextEncoder().encode('-late');
          },
        } as never),
    );
    try {
      const result = await runLoad({
        url: `http://127.0.0.1:${server.port}/`,
        connections: 2,
        requests: 4,
        responsePolicy: 'cancel',
      });
      t.equal(result.counters.completed, 4);
      t.equal(result.counters.successful, 4);
      t.equal(result.counters.headersOnly, 4);
      t.equal(result.counters.responseBytes, 0);
      t.equal(result.config.responsePolicy, 'cancel');
      t.equal(result.connections.unique, 4, 'every cancelled H1 response replaces its connection');
      t.equal(result.connections.reconnects, 2);
    } finally {
      release();
      await server.close();
    }
  });

  it('classifies final-header deadlines without failing the whole run', async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = serveHttp({ port: 0 }, async () => {
      await gate;
      return new Response('late');
    });
    try {
      const result = await runLoad({
        url: `http://127.0.0.1:${server.port}/`,
        connections: 1,
        requests: 2,
        timeouts: { headers: 10, total: 100 },
      });
      t.equal(result.counters.completed, 0);
      t.equal(result.counters.timedOut, 2);
      t.equal(result.counters.transportFailed, 0);
      t.equal(result.errors['Error'], 2);
    } finally {
      release();
      await server.close();
    }
  });

  it('runs multiplexed H2 workers on bounded physical connections', { skip: skipH2 }, async (t) => {
    const server = serveHttp(
      {
        port: 0,
        tls: { cert: CERT_PATH, key: KEY_PATH },
      },
      async () => new Response('h2'),
    );
    try {
      const result = await runLoad({
        url: `https://127.0.0.1:${server.port}/`,
        protocol: 'h2',
        connections: 2,
        streams: 2,
        requests: 12,
        tls: { rejectUnauthorized: false },
      });
      t.equal(result.counters.completed, 12);
      t.equal(result.counters.responseBytes, 24);
      t.equal(result.protocols.h2, 12);
      t.ok(result.connections.unique <= 2);
      t.ok(result.connections.maxActiveOperations <= 4);
    } finally {
      await server.close();
    }
  });

  it('runs multiplexed H3 workers on bounded QUIC connections', { skip: skipH3 }, async (t) => {
    const server = await h3Serve(
      {
        port: 0,
        hostname: '127.0.0.1',
        certificateFile: CERT_PATH,
        privateKeyFile: KEY_PATH,
      },
      () => new Response('h3'),
    );
    try {
      const result = await runLoad({
        url: `https://127.0.0.1:${server.port}/`,
        protocol: 'h3',
        connections: 2,
        streams: 2,
        requests: 8,
        tls: { rejectUnauthorized: false },
      });
      t.equal(result.counters.completed, 8);
      t.equal(result.counters.responseBytes, 16);
      t.equal(result.protocols.h3, 8);
      t.equal(result.config.tls.rejectUnauthorized, false);
      t.ok(result.connections.unique <= 2);
      t.ok(result.connections.maxActiveOperations <= 4);
    } finally {
      await server.close();
    }
  });

  it('rejects workload shapes that would change protocol semantics', async (t) => {
    await t.rejects(
      () =>
        runLoad({
          url: 'http://127.0.0.1/',
          durationMs: 1,
          requests: 1,
        }),
      /mutually exclusive/,
    );
    await t.rejects(
      () => runLoad({ url: 'http://127.0.0.1/', protocol: 'http/1.1', streams: 2, requests: 1 }),
      /HTTP\/1\.1 requires streams to be 1/,
    );
    await t.rejects(
      () => runLoad({ url: 'http://127.0.0.1/', protocol: 'h2', requests: 1 }),
      /H2 requires an https: URL/,
    );
    await t.rejects(
      () => runLoad({ url: 'http://127.0.0.1/', protocol: 'h3', requests: 1 }),
      /H3 requires an https: URL/,
    );
    await t.rejects(
      () =>
        runLoad({
          url: 'http://127.0.0.1/',
          method: 'POST',
          body: { oneShot: true } as never,
          requests: 1,
        }),
      /body must be a replayable/,
    );
  });
});

describe('load command', () => {
  it('parses CLI options and emits the versioned JSON result', async (t) => {
    const server = serveHttp(
      { port: 0 },
      async (request) => new Response(request.headers.get('x-load') ?? 'missing', { status: 201 }),
    );
    let written: unknown;
    try {
      const result = (await loadCommand.parse(
        [
          '--json',
          '-c',
          '1',
          '-n',
          '3',
          '-H',
          'x-load: command',
          '--expect-status',
          '201',
          `http://127.0.0.1:${server.port}/`,
        ],
        {
          writer: {
            mode: 'json',
            writeJson(value) {
              written = value;
            },
          },
        },
      )) as LoadResult;
      t.equal(result.schemaVersion, 1);
      t.equal(result.counters.completed, 3);
      t.equal(result.counters.successful, 3);
      t.equal(result.counters.responseBytes, 21);
      t.deepEqual(result.config.headerNames, ['x-load']);
      t.equal(result.config.requestBodyBytes, 0);
      t.equal(written, result);
    } finally {
      await server.close();
    }
  });

  it('uses the default status range when --expect-status is omitted', async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response(null, { status: 204 }));
    try {
      const result = (await loadCommand.parse(
        ['--json', '-c', '1', '-n', '1', `http://127.0.0.1:${server.port}/`],
        {
          writer: {
            mode: 'json',
            writeJson() {},
          },
        },
      )) as LoadResult;
      t.equal(result.counters.successful, 1);
      t.equal(result.config.expectedStatus, null);
    } finally {
      await server.close();
    }
  });

  it('reads --body-file once and replays it for every request', async (t) => {
    const fs = new DiskFileSystem();
    const path = `/tmp/fino-load-body-${Math.floor(Math.random() * 1e9)}.txt`;
    await fs.writeFile(path, new TextEncoder().encode('payload'));
    const server = serveHttp({ port: 0 }, async (request) => new Response(await request.text()));
    try {
      const result = (await loadCommand.parse(
        [
          '--json',
          '-c',
          '1',
          '-n',
          '2',
          '-X',
          'POST',
          '--body-file',
          path,
          `http://127.0.0.1:${server.port}/`,
        ],
        {
          writer: {
            mode: 'json',
            writeJson() {},
          },
        },
      )) as LoadResult;
      t.equal(result.counters.completed, 2);
      t.equal(result.counters.responseBytes, 14);
      t.equal(result.config.requestBodyBytes, 7);
    } finally {
      await server.close();
      await fs.unlink(path);
    }
  });

  it('rejects malformed durations before sending traffic', async (t) => {
    await t.rejects(
      async () => await loadCommand.parse(['--duration', 'ten', 'http://127.0.0.1/']),
      /must be a duration/,
    );
  });
});
