/**
 * Tests for fino:load and the `fino load` command.
 */
import { describe, it } from 'fino:test/test';
import { formatLoadResult, runLoad, runLoadScenario } from 'fino:load';
import type { LoadResult, LoadScenarioResult } from 'fino:load';
import loadCommand from 'internal:commands/load';
import { runArrivalPhase, runClosedLoopPhase } from 'internal:load';
import { LogHistogram } from 'internal:statistics';
import { serve, serveHttp } from 'fino:net/http/server';
import { App } from 'fino:net/http/app';
import { h2Available } from '../js/net/http/h2.ts';
import { h3Available, serve as h3Serve } from 'internal:net/http/h3';
import { QuicEndpoint, quicAvailable } from 'fino:net/quic';
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

  it('preserves intended timestamps for fixed-rate arrivals', async (t) => {
    const controller = new AbortController();
    const scheduled: number[] = [];
    let now = 0;
    const offered = await runArrivalPhase(
      {
        concurrency: 1,
        maxQueued: 1,
        requestLimit: 3,
        deadline: null,
        signal: controller.signal,
        now: () => now,
        sleep: async (delay) => {
          now += delay;
        },
        rateAt: () => 10,
        offer() {},
        drop() {},
      },
      async (_signal, scheduledAt) => {
        scheduled.push(scheduledAt);
      },
    );
    t.equal(offered, 3);
    t.deepEqual(scheduled, [0, 100, 200]);
  });

  it('drops arrivals when the bounded open-loop queue is full', async (t) => {
    const controller = new AbortController();
    let now = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dropped = 0;
    const running = runArrivalPhase(
      {
        concurrency: 1,
        maxQueued: 1,
        requestLimit: 5,
        deadline: null,
        signal: controller.signal,
        now: () => now,
        sleep: async (delay) => {
          now += delay;
          await Promise.resolve();
        },
        rateAt: () => 100,
        offer() {},
        drop() {
          dropped++;
        },
      },
      async () => await gate,
    );
    for (let index = 0; index < 10; index++) await Promise.resolve();
    release();
    t.equal(await running, 5);
    t.ok(dropped > 0);
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
      t.equal(result.schemaVersion, 2);
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

  it('schedules bounded open-loop arrivals and reports dropped work', async (t) => {
    const server = serveHttp({ port: 0 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response('ok');
    });
    try {
      const result = await runLoad({
        url: `http://127.0.0.1:${server.port}/`,
        connections: 1,
        durationMs: 35,
        rate: 1000,
        maxQueuedOperations: 0,
      });
      t.ok(result.counters.offered >= 15);
      t.ok(result.counters.schedulerDropped > 0);
      t.equal(result.counters.offered, result.counters.started + result.counters.schedulerDropped);
      t.equal(result.config.rate, 1000);
      t.ok(result.latency.total.min! >= result.latency.ttfb.min!);
    } finally {
      await server.close();
    }
  });

  it('selects weighted targets reproducibly and substitutes sequence data', async (t) => {
    const seen: string[] = [];
    const server = serveHttp({ port: 0 }, async (request) => {
      seen.push(new URL(request.url).pathname);
      return new Response('ok');
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const options = {
        targets: [
          { url: `${base}/a/{{sequence}}`, weight: 1 },
          { url: `${base}/b/{{sequence}}`, weight: 3 },
        ],
        connections: 1,
        requests: 12,
        seed: 42,
      } as const;
      const first = await runLoad(options);
      const firstSeen = seen.splice(0);
      const second = await runLoad(options);
      t.deepEqual(seen, firstSeen);
      t.equal(first.config.targetCount, 2);
      t.equal(first.counters.completed, 12);
      t.equal(second.counters.completed, 12);
      t.ok(firstSeen.some((path) => path.startsWith('/a/')));
      t.ok(firstSeen.some((path) => path.startsWith('/b/')));
      t.deepEqual(
        firstSeen.map((path) => Number(path.slice(3))).sort((a, b) => a - b),
        Array.from({ length: 12 }, (_, index) => index),
      );
    } finally {
      await server.close();
    }
  });

  it('matches expected bodies while streaming and can bail out on failures', async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('actual'));
    try {
      const result = await runLoad({
        url: `http://127.0.0.1:${server.port}/`,
        connections: 1,
        requests: 10,
        expectedBody: 'expected',
        bailout: { failures: 2 },
      });
      t.equal(result.counters.bodyFailed, 2);
      t.equal(result.counters.successful, 0);
      t.equal(result.bailout, 'failure threshold 2 reached');
      t.ok(result.counters.started < 10);
    } finally {
      await server.close();
    }
  });

  it('recreates pooled sessions at the configured cadence', async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    try {
      const result = await runLoad({
        url: `http://127.0.0.1:${server.port}/`,
        connections: 1,
        requests: 5,
        reconnectAfter: 2,
      });
      t.equal(result.counters.completed, 5);
      t.equal(result.config.reconnectAfter, 2);
      t.ok(result.connections.unique >= 3);
      t.ok(result.connections.reconnects >= 2);
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
    await t.rejects(
      () => runLoad({ url: 'http://127.0.0.1/', requests: 1, rate: 0 }),
      /rate must be greater than zero/,
    );
    await t.rejects(
      () =>
        runLoad({
          url: 'http://127.0.0.1/',
          requests: 1,
          responsePolicy: 'cancel',
          expectedBody: 'no body is consumed',
        }),
      /expectedBody requires responsePolicy consume/,
    );
    await t.rejects(
      () => runLoad({ targets: [], requests: 1 }),
      /url or at least one target is required/,
    );
  });
});

describe('scripted load scenarios', () => {
  it('runs bounded HTTP sessions with deterministic metrics and cleanup', async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('hello'));
    try {
      const result = await runLoadScenario(
        {
          protocol: 'http',
          async session(client, context) {
            const started = performance.now();
            const response = await client.request(`http://127.0.0.1:${server.port}/`);
            const bytes = await response.discard();
            context.bytes('received', bytes);
            context.messages('received');
            context.metric('round_trip', performance.now() - started);
          },
        },
        { users: 2, sessions: 4, seed: 7 },
      );
      t.equal(result.schemaVersion, 1);
      t.equal(result.offered, 4);
      t.equal(result.completed, 4);
      t.equal(result.failed, 0);
      t.equal(result.bytes.received, 20);
      t.equal(result.messages.received, 4);
      t.equal(result.metrics.round_trip!.count, 4);
      t.ok(result.maxActive <= 2);
    } finally {
      await server.close();
    }
  });

  it('serializes sessions assigned to the same virtual user', async (t) => {
    const activeUsers = new Set<number>();
    let overlaps = 0;
    const result = await runLoadScenario(
      {
        protocol: 'http',
        async session(_client, context) {
          if (activeUsers.has(context.userId)) overlaps++;
          activeUsers.add(context.userId);
          await new Promise((resolve) => setTimeout(resolve, context.sequence === 0 ? 20 : 1));
          activeUsers.delete(context.userId);
        },
      },
      { users: 2, sessions: 6 },
    );
    t.equal(result.completed, 6);
    t.equal(overlaps, 0);
  });

  it('bounds custom metric names and diagnostic logs', async (t) => {
    const result = await runLoadScenario(
      {
        protocol: 'http',
        session(_client, context) {
          context.metric('first', 1);
          context.log('accepted');
          context.log('dropped');
          context.metric('second', 2);
        },
      },
      { sessions: 1, maxMetrics: 1, maxLogs: 1 },
    );
    t.equal(result.completed, 0);
    t.equal(result.failed, 1);
    t.equal(result.errors.RangeError, 1);
    t.equal(result.logs.accepted, 1);
    t.equal(result.logs.dropped, 1);
    t.equal(result.metrics.first!.count, 1);
  });

  it('ends open-loop scenario sessions through the measured-phase signal', async (t) => {
    const result = await runLoadScenario(
      {
        protocol: 'sse',
        async session(_client, context) {
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      },
      { users: 1, durationMs: 35, rate: 1000, maxQueuedSessions: 0 },
    );
    t.ok(result.offered >= 15);
    t.equal(result.started, 1);
    t.equal(result.completed, 1);
    t.equal(result.dropped, result.offered - 1);
    t.ok(result.durationMs >= 25 && result.durationMs < 250);
  });

  it('owns SSE and WebSocket resources opened by scenarios', async (t) => {
    const sse = serveHttp(
      { port: 0 },
      async () =>
        new Response('data: hello\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    );
    const websocket = serve({ port: 0 }, async (incoming) => {
      if (incoming.kind !== 'websocket') return incoming.reject(new Response('upgrade required'));
      const socket = await incoming.accept();
      socket.addEventListener('message', (event) => {
        void socket.send(`echo:${(event as MessageEvent).data}`);
      });
    });
    try {
      const sseResult = await runLoadScenario(
        {
          protocol: 'sse',
          async session(client, context) {
            const source = client.sse(`http://127.0.0.1:${sse.port}/`);
            const message = await new Promise<MessageEvent>((resolve) => {
              source.addEventListener('message', (event) => resolve(event as MessageEvent), {
                once: true,
              });
            });
            context.messages('received');
            context.bytes('received', String(message.data).length);
            source.close();
          },
        },
        { sessions: 1 },
      );
      const wsResult = await runLoadScenario(
        {
          protocol: 'websocket',
          async session(client, context) {
            const socket = await client.websocket(`ws://127.0.0.1:${websocket.port}/`);
            const received = new Promise<MessageEvent>((resolve) => {
              socket.addEventListener('message', (event) => resolve(event as MessageEvent), {
                once: true,
              });
            });
            await socket.send('hi');
            context.messages('sent');
            const message = await received;
            context.messages('received');
            context.bytes('received', String(message.data).length);
            await socket.close();
          },
        },
        { sessions: 1 },
      );
      t.equal(sseResult.completed, 1);
      t.equal(sseResult.messages.received, 1);
      t.equal(wsResult.completed, 1);
      t.equal(wsResult.messages.sent, 1);
      t.equal(wsResult.messages.received, 1);
    } finally {
      await sse.close();
      await websocket.close();
    }
  });

  it('owns WebTransport sessions opened by scenarios', { skip: skipH3 }, async (t) => {
    const app = new App();
    app.route('/load').webtransport(() => {});
    const server = app.listen({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: CERT_PATH, key: KEY_PATH },
      h3: true,
    } as never);
    try {
      await (server as unknown as { ready: Promise<void> }).ready;
      const result = await runLoadScenario(
        {
          protocol: 'webtransport',
          async session(client, context) {
            const transport = await client.webtransport(`https://127.0.0.1:${server.port}/load`, {
              tls: { rejectUnauthorized: false },
            });
            context.metric('session_setup', 1);
            transport.close();
          },
        },
        { sessions: 1 },
      );
      t.equal(result.completed, 1);
      t.equal(result.metrics.session_setup!.count, 1);
    } finally {
      await server.close();
    }
  });

  it('owns raw QUIC connections opened by scenarios', { skip: !quicAvailable }, async (t) => {
    const server = new QuicEndpoint({ alpnProtocols: ['fino-load'] });
    const listener = await server.listen({
      address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
      certificateFile: CERT_PATH,
      privateKeyFile: KEY_PATH,
      alpnProtocols: ['fino-load'],
    });
    const serving = (async () => {
      const connection = await server.accept();
      const stream = await connection.acceptStream();
      const request = await stream.reader.read();
      await stream.writer.write(request!);
      await stream.writer.close();
    })();
    try {
      const result = await runLoadScenario(
        {
          protocol: 'quic',
          async session(client, context) {
            const connection = await client.quic({
              endpoint: { alpnProtocols: ['fino-load'] },
              connect: { address: listener.address, alpnProtocols: ['fino-load'] },
            });
            const stream = await connection.openBidirectionalStream();
            const payload = new TextEncoder().encode('ping');
            await stream.writer.write(payload);
            await stream.writer.close();
            const echoed = await stream.reader.read();
            context.bytes('sent', payload.byteLength);
            context.bytes('received', echoed!.byteLength);
          },
        },
        { sessions: 1 },
      );
      await serving;
      t.equal(result.completed, 1);
      t.equal(result.bytes.sent, 4);
      t.equal(result.bytes.received, 4);
    } finally {
      await server.close();
    }
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
      t.equal(result.schemaVersion, 2);
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

  it('imports and runs a TypeScript scenario without a URL positional', async (t) => {
    let written: unknown;
    const result = (await loadCommand.parse(
      [
        '--json',
        '--scenario',
        new URL('./fixtures/load-scenario.ts', import.meta.url).pathname,
        '--users',
        '2',
        '--sessions',
        '3',
      ],
      {
        writer: {
          mode: 'json',
          writeJson(value) {
            written = value;
          },
        },
      },
    )) as LoadScenarioResult;
    t.equal(result.protocol, 'http');
    t.equal(result.completed, 3);
    t.equal(result.metrics.fixture!.count, 3);
    t.equal(written, result);
  });

  it('parses weighted targets and a deterministic arrival-rate ramp', async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      const result = (await loadCommand.parse(
        [
          '--json',
          '--target',
          `3:${url}read`,
          '--target',
          `1:${url}write`,
          '--rate',
          '100',
          '--rate-to',
          '200',
          '--requests',
          '4',
          '--seed',
          '42',
        ],
        {
          writer: { mode: 'json', writeJson() {} },
        },
      )) as LoadResult;
      t.equal(result.counters.completed, 4);
      t.deepEqual(result.config.rate, { start: 100, end: 200 });
      t.equal(result.config.seed, 42);
      t.equal(result.config.targets[0]!.weight, 3);
      t.equal(result.config.targets[1]!.weight, 1);
    } finally {
      await server.close();
    }
  });
});
