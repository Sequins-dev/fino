import { after, describe, it } from 'fino:test/test';
import { mockFetch } from 'fino:test/mock';
import type { MockFetchCall } from 'fino:test/mock';
import { topic } from 'fino:context/topic';
import {
  Baggage,
  BatchLogRecordProcessor,
  BatchSpanProcessor,
  Counter,
  DnsInstrumentation,
  FetchInstrumentation,
  HttpServerInstrumentation,
  Histogram,
  HistogramInstrument,
  InMemoryExporter,
  LogRecordBuilder,
  LoggerProvider,
  ManualMetricReader,
  PeriodicMetricReader,
  PeriodicExportingMetricReader,
  MeterProvider,
  OTEL_SCHEMA_VERSION,
  OTEL_TOPIC_SUFFIXES,
  OTLPHttpJsonExporter,
  OtelSDK,
  Propagation,
  Resource,
  Sampler,
  SocketInstrumentation,
  Span,
  TlsInstrumentation,
  TraceTopicInstrumentation,
  TracerProvider,
  SeverityNumber,
  W3CTraceContextPropagator,
  gaugeFromSignal,
  getActiveSpan,
  getActiveBaggage,
  getLoggerProvider,
  getMeterProvider,
  getActiveSpanContext,
  getTracerProvider,
  metricsSignal,
  otelTopic,
  otelRuntimeEvent,
  otelRuntimeTopic,
  runWithActiveSpan,
  runWithActiveContext,
  runWithBaggage,
  runWithLoggerProvider,
  runWithMeterProvider,
  runWithTracerProvider,
  setLoggerProvider,
  setMeterProvider,
  setTracerProvider,
} from 'fino:opentelemetry';
import type {
  CarrierApi,
  Instrumentation,
  LogRecord,
  LogRecordProcessor,
  MetricRecord,
  SpanRecord,
} from 'fino:opentelemetry';
import {
  getTracerProvider as getTraceProviderFromTraces,
  Span as SplitSpan,
} from 'fino:opentelemetry/traces';
import {
  getMeterProvider as getMeterProviderFromMetrics,
  Counter as SplitCounter,
} from 'fino:opentelemetry/metrics';
import {
  getLoggerProvider as getLoggerProviderFromLogs,
  SeverityNumber as SplitSeverityNumber,
} from 'fino:opentelemetry/logs';
import {
  OtelSDK as SplitOtelSDK,
  InMemoryExporter as SplitInMemoryExporter,
} from 'fino:opentelemetry/sdk';
import { createSignal } from 'fino:signals';
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
interface CapturedFetchCall {
  url: string;
  init: unknown;
  request: Request;
}
interface CapturedFetchRecord {
  method: string;
  path: string;
  headers: {
    contentType: string | null;
    custom: string | null;
    encoding: string | null;
  };
  body: Uint8Array;
  text: string;
}
interface HookEvent {
  type: string;
  message?: string;
  result?: {
    rejectedSpans?: number;
  };
}
function containsBytes(haystack: Uint8Array, needle: Uint8Array) {
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
async function readBytes(body: AsyncIterable<Uint8Array | ArrayBuffer>) {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    parts.push(bytes);
    total += bytes.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
function assertPresent<T>(
  value: T,
  message = 'expected value to be present',
): asserts value is NonNullable<T> {
  if (value == null) throw new Error(message);
}
function captureFetchCall(
  received: CapturedFetchRecord[],
  fetchCalls: CapturedFetchCall[],
  responseFactory: (call: MockFetchCall, callCount: number) => Response | Promise<Response> = () =>
    new Response('ok'),
): (call: MockFetchCall) => Promise<Response> {
  return async (call: MockFetchCall): Promise<Response> => {
    fetchCalls.push({
      url: call.url.href,
      init: call.init,
      request: call.request,
    });
    received.push({
      method: call.method,
      path: call.url.pathname,
      headers: {
        contentType: call.headers.get('content-type'),
        custom: call.headers.get('x-test-header'),
        encoding: call.headers.get('content-encoding'),
      },
      body: call.body,
      text: call.text,
    });
    return await responseFactory(call, fetchCalls.length);
  };
}
async function readBody(
  body: string | Uint8Array | AsyncIterable<ArrayBuffer | Uint8Array>,
): Promise<string | Uint8Array> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  return readBytes(body);
}
describe('fino:opentelemetry', () => {
  const originalTracerProvider = getTracerProvider();
  const originalLoggerProvider = getLoggerProvider();
  const originalMeterProvider = getMeterProvider();
  after(() => {
    setTracerProvider(originalTracerProvider);
    setLoggerProvider(originalLoggerProvider);
    setMeterProvider(originalMeterProvider);
  });
  it('exposes signal-specific public modules and keeps the root facade compatible', (t) => {
    t.equal(
      getTraceProviderFromTraces(),
      getTracerProvider(),
      'traces module shares root tracer provider',
    );
    t.equal(SplitSpan, Span, 'traces module exports the public Span class');
    t.equal(
      getMeterProviderFromMetrics(),
      getMeterProvider(),
      'metrics module shares root meter provider',
    );
    t.equal(SplitCounter, Counter, 'metrics module exports the public Counter class');
    t.equal(
      getLoggerProviderFromLogs(),
      getLoggerProvider(),
      'logs module shares root logger provider',
    );
    t.equal(
      SplitSeverityNumber.INFO,
      SeverityNumber.INFO,
      'logs module exports the public severity numbers',
    );
    t.equal(SplitOtelSDK, OtelSDK, 'sdk module exports the public SDK class');
    t.equal(
      SplitInMemoryExporter,
      InMemoryExporter,
      'sdk module exports the public in-memory exporter',
    );
  });
  it('stores provider defaults globally and supports async-scoped overrides', async (t) => {
    const tracerProvider = new TracerProvider();
    const loggerProvider = new LoggerProvider();
    const meterProvider = new MeterProvider();
    setTracerProvider(tracerProvider);
    setLoggerProvider(loggerProvider);
    setMeterProvider(meterProvider);
    t.equal(getTracerProvider(), tracerProvider, 'global tracer provider updated');
    t.equal(getLoggerProvider(), loggerProvider, 'global logger provider updated');
    t.equal(getMeterProvider(), meterProvider, 'global meter provider updated');
    const scopedTracerProvider = new TracerProvider();
    const scopedLoggerProvider = new LoggerProvider();
    const scopedMeterProvider = new MeterProvider();
    await runWithTracerProvider(scopedTracerProvider, async () => {
      await runWithLoggerProvider(scopedLoggerProvider, async () => {
        await runWithMeterProvider(scopedMeterProvider, async () => {
          await delay(0);
          t.equal(
            getTracerProvider(),
            scopedTracerProvider,
            'scoped tracer provider visible through async boundary',
          );
          t.equal(
            getLoggerProvider(),
            scopedLoggerProvider,
            'scoped logger provider visible through async boundary',
          );
          t.equal(
            getMeterProvider(),
            scopedMeterProvider,
            'scoped meter provider visible through async boundary',
          );
        });
      });
    });
    t.equal(getTracerProvider(), tracerProvider, 'scoped tracer provider restored');
    t.equal(getLoggerProvider(), loggerProvider, 'scoped logger provider restored');
    t.equal(getMeterProvider(), meterProvider, 'scoped meter provider restored');
  });
  it('builds scope-based topic names with stable lifecycle suffixes', (t) => {
    t.equal(
      otelTopic('trace', { name: 'mysql' }, 'start'),
      'otel:trace:mysql:start',
      'trace topic includes scope and lifecycle suffix only',
    );
    t.equal(
      otelTopic(
        'metric',
        {
          name: 'http.server',
          version: '1.2.3',
        },
        'request',
        'observe',
      ),
      'otel:metric:http.server@1.2.3:request:observe',
      'metric topic includes scope version and suffix',
    );
  });
  it('publishes canonical topic taxonomy helpers and schema envelopes', (t) => {
    t.deepEqual(
      OTEL_TOPIC_SUFFIXES.trace,
      ['start', 'end', 'error', 'event', 'attribute', 'link', 'status', 'rename'],
      'trace suffixes are canonical',
    );
    t.deepEqual(OTEL_TOPIC_SUFFIXES.metric, ['record', 'observe'], 'metric suffixes are canonical');
    t.equal(
      otelRuntimeTopic('http.server', 'request', 'start'),
      'otel:runtime:http.server:request:start',
      'runtime topic helper is stable',
    );
    const event = otelRuntimeEvent('fetch', 'request', 'end', {
      requestId: 'fetch-1',
      statusCode: 200,
    });
    t.equal(event.schemaVersion, OTEL_SCHEMA_VERSION, 'runtime events carry schema version');
    t.equal(event.topic, 'otel:runtime:fetch:request:end', 'runtime events carry topic name');
    t.equal(event.phase, 'end', 'runtime events carry phase');
    t.equal(event.correlationId, 'fetch-1', 'runtime events carry correlation id');
  });
  it('stabilizes public aliases and rejects malformed public inputs', (t) => {
    t.equal(Histogram, HistogramInstrument, 'stable histogram alias exported');
    t.ok(
      new PeriodicExportingMetricReader(new InMemoryExporter()) instanceof PeriodicMetricReader,
      'stable metric reader alias exported',
    );
    t.throws(
      () => new TracerProvider().getTracer(''),
      /non-empty string/,
      'empty tracer scope rejected',
    );
    t.throws(
      () => new LoggerProvider().getLogger('   '),
      /non-empty string/,
      'empty logger scope rejected',
    );
    t.throws(
      () => new MeterProvider().getMeter(''),
      /non-empty string/,
      'empty meter scope rejected',
    );
    t.throws(
      () => new TracerProvider().getTracer('valid').startSpan(''),
      /non-empty string/,
      'empty span name rejected',
    );
    t.throws(
      () => new OTLPHttpJsonExporter({ compression: 'zip' as 'gzip' }),
      /compression must be one of/,
      'invalid compression rejected',
    );
    t.throws(
      () => new OTLPHttpJsonExporter({ endpoints: { traces: 123 as unknown as string } }),
      /endpoint for traces must be a non-empty string/,
      'invalid endpoint override rejected',
    );
    t.throws(
      () => new OTLPHttpJsonExporter({ headers: [] as unknown as Record<string, string> }),
      /headers must be an object/,
      'invalid headers rejected',
    );
  });
  it('applies default resource identity to providers', (t) => {
    const resource = new TracerProvider().resource;
    t.equal(
      resource.attributes['service.name'],
      'unknown_service',
      'default service.name is present',
    );
    t.equal(
      resource.attributes['telemetry.sdk.name'],
      'fino',
      'default telemetry.sdk.name is present',
    );
    t.equal(
      resource.attributes['telemetry.sdk.language'],
      'javascript',
      'default telemetry.sdk.language is present',
    );
    const custom = new LoggerProvider({
      resource: new Resource({
        'service.name': 'custom-service',
        region: 'test',
      }),
    }).resource;
    t.equal(
      custom.attributes['service.name'],
      'custom-service',
      'custom service.name overrides the default',
    );
    t.equal(custom.attributes.region, 'test', 'custom resource attributes are preserved');
    t.equal(
      custom.attributes['telemetry.sdk.name'],
      'fino',
      'default telemetry SDK metadata remains attached',
    );
  });
  it('routes topic events through SDK processors and exporters', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new TraceTopicInstrumentation()],
    });
    sdk.start();
    const provider = new TracerProvider({
      resource: new Resource({ 'service.name': 'otel-test' }),
    });
    const tracer = provider.getTracer('mysql', '1.0.0');
    const span = tracer.startSpan('query', { attributes: { 'db.statement': 'select 1' } });
    span.end({ attributes: { 'db.rows_affected': 1 } });
    await sdk.flush();
    const exported = exporter.getFinishedSpans();
    t.equal(exported.length, 1, 'one span exported');
    const exportedSpan = exported[0];
    assertPresent(exportedSpan, 'exported span present');
    assertPresent(exportedSpan.scope, 'exported scope present');
    assertPresent(exportedSpan.resource, 'exported resource present');
    assertPresent(exportedSpan.attributes, 'exported attributes present');
    t.equal(exportedSpan.name, 'query', 'span name captured');
    t.equal(exportedSpan.scope.name, 'mysql', 'scope name preserved');
    t.equal(exportedSpan.resource.attributes['service.name'], 'otel-test', 'resource preserved');
    t.equal(exportedSpan.attributes['db.statement'], 'select 1', 'start attributes preserved');
    t.equal(exportedSpan.attributes['db.rows_affected'], 1, 'end attributes preserved');
    t.equal('signal' in exportedSpan, false, 'trace payload does not duplicate signal category');
    t.equal('phase' in exportedSpan, false, 'trace payload does not duplicate phase category');
    await sdk.shutdown();
  });
  it('enables configured instrumentations once and disposes them on shutdown', async (t) => {
    const events: string[] = [];
    const instrumentation: Instrumentation = {
      enable() {
        events.push('enable');
        return {
          dispose() {
            events.push('dispose');
          },
        };
      },
    };
    const sdk = new OtelSDK({
      spanProcessors: [],
      instrumentations: [instrumentation],
    });
    sdk.start();
    sdk.start();
    await sdk.shutdown();
    t.deepEqual(
      events,
      ['enable', 'dispose'],
      'instrumentation lifecycle is one enable and one dispose',
    );
  });
  it('applies SDK resource identity independently from provider resources', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      resource: new Resource({
        'service.name': 'sdk-service',
        'service.version': '2.0.0',
      }),
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new TraceTopicInstrumentation()],
    }).start();
    const provider = new TracerProvider({
      resource: new Resource({ 'service.name': 'provider-service' }),
    });
    const span = provider.getTracer('sdk.resource', '1.0.0').startSpan('work');
    span.end();
    await sdk.flush();
    const [exported] = exporter.getFinishedSpans();
    assertPresent(exported, 'exported span present');
    assertPresent(exported.resource, 'exported resource present');
    t.equal(
      exported.resource.attributes['service.name'],
      'sdk-service',
      'sdk resource overrides provider service.name',
    );
    t.equal(
      exported.resource.attributes['service.version'],
      '2.0.0',
      'sdk resource adds service.version',
    );
    t.equal(
      exported.resource.attributes['telemetry.sdk.name'],
      'fino',
      'default sdk metadata remains present',
    );
    await sdk.shutdown();
  });
  it('flushes spans, logs, and metrics during shutdown before tearing down subscriptions', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 0 })],
      metricReaders: [new PeriodicMetricReader(exporter)],
      instrumentations: [new TraceTopicInstrumentation()],
    }).start();
    const tracer = new TracerProvider().getTracer('shutdown.scope', '1.0.0');
    const logger = new LoggerProvider().getLogger('shutdown.scope', '1.0.0');
    const meter = new MeterProvider().getMeter('shutdown.scope', '1.0.0');
    const counter = meter.createCounter('shutdown.counter', { unit: '1' });
    const span = tracer.startSpan('shutdown-span');
    await runWithActiveSpan(span, async () => {
      logger.info('shutdown log', { phase: 'before-shutdown' });
      counter.add(1, { phase: 'before-shutdown' });
    });
    span.end();
    await sdk.shutdown();
    t.equal(exporter.getFinishedSpans().length, 1, 'shutdown exports final span data');
    t.equal(exporter.getFinishedLogs().length, 1, 'shutdown exports final log data');
    t.equal(exporter.getFinishedMetrics().length, 1, 'shutdown exports final metric data');
  });
  it('captures direct spans through scoped trace topics without generic trace channels', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new TraceTopicInstrumentation()],
    });
    let genericStarts = 0;
    const genericHandle = topic('otel:trace:start').subscribe(() => {
      genericStarts++;
    });
    sdk.start();
    const tracer = new TracerProvider().getTracer('mysql', '1.0.0');
    const span = tracer.startSpan('query', { attributes: { 'db.system': 'mysql' } });
    span.setAttribute('db.statement', 'select 1');
    span.addEvent('query.sent', { size: 1 });
    span.end({ status: { code: 'OK' } });
    await sdk.flush();
    const exported = exporter.getFinishedSpans();
    t.equal(genericStarts, 0, 'generic trace topics are not used');
    t.equal(exported.length, 1, 'one direct span exported');
    const directSpan = exported[0];
    assertPresent(directSpan, 'direct span present');
    assertPresent(directSpan.scope, 'direct span scope present');
    assertPresent(directSpan.attributes, 'direct span attributes present');
    assertPresent(directSpan.events, 'direct span events present');
    t.equal(directSpan.scope.name, 'mysql', 'scope preserved');
    t.equal(directSpan.name, 'query', 'operation preserved');
    t.equal(directSpan.attributes['db.system'], 'mysql', 'start attributes reconstructed');
    t.equal(directSpan.attributes['db.statement'], 'select 1', 'mutation events reconstructed');
    t.equal(directSpan.events.length, 1, 'span events reconstructed');
    genericHandle.dispose();
    await sdk.shutdown();
  });
  it('applies sampling in the SDK without changing provider publication', async (t) => {
    let published = 0;
    const events = topic<SpanRecord>(otelTopic('trace', { name: 'redis' }, 'end'));
    const publishedHandle = events.subscribe(() => {
      published++;
    });
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      sampler: new (class extends Sampler {
        shouldSample() {
          return false;
        }
      })(),
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [
        {
          enable(targetSdk) {
            const handle = events.subscribe((evt: SpanRecord) => {
              targetSdk.recordSpan({
                name: evt.operation || evt.name || '',
                kind: 'client',
                traceId: evt.traceId,
                spanId: evt.spanId,
                startTimeUnixNano: (evt.timeUnixNano ?? 0) - 1e3,
                endTimeUnixNano: evt.timeUnixNano ?? 0,
                ...(evt.attributes ? { attributes: evt.attributes } : {}),
                ...(evt.scope ? { scope: evt.scope } : {}),
                ...(evt.resource ? { resource: evt.resource } : {}),
              });
            });
            return {
              dispose() {
                handle.dispose();
              },
            };
          },
        },
      ],
    });
    sdk.start();
    const tracer = new TracerProvider().getTracer('redis');
    const span = tracer.startSpan('command');
    span.end();
    await sdk.flush();
    t.equal(published, 1, 'provider still published the end event');
    t.equal(exporter.getFinishedSpans().length, 0, 'sampler dropped the span before export');
    publishedHandle.dispose();
    await sdk.shutdown();
  });
  it('supports span processor start hooks, span limits, and queue drop policy', async (t) => {
    const exporter = new InMemoryExporter();
    const started = [];
    const sdk = new OtelSDK({
      spanLimits: {
        attributeCountLimit: 1,
        attributeValueLengthLimit: 5,
        eventCountLimit: 2,
        linkCountLimit: 1,
      },
      spanProcessors: [
        {
          onStart(span) {
            started.push(span);
          },
          onEnd() {},
          async forceFlush() {},
          async shutdown() {},
        },
        new BatchSpanProcessor(exporter, {
          maxQueueSize: 1,
          maxExportBatchSize: 1,
          scheduledDelayMillis: 0,
        }),
      ],
      instrumentations: [new TraceTopicInstrumentation()],
    }).start();
    const tracer = new TracerProvider().getTracer('limits');
    const first = tracer.startSpan('query', {
      attributes: {
        alpha: 'abcdef',
        beta: 'discard',
      },
      links: [
        {
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
        },
        {
          traceId: 'fedcba9876543210fedcba9876543210',
          spanId: 'fedcba9876543210',
        },
      ],
    });
    first.addEvent('db.start', { sql: 'select 123456' });
    first.addEvent('db.mid', { rows: 1 });
    first.recordException(new Error('boom failure'));
    first.end();
    const second = tracer.startSpan('query', { attributes: { gamma: 'queued' } });
    second.end();
    await sdk.flush();
    const spans = exporter.getFinishedSpans();
    const limitedSpan = spans[0];
    assertPresent(limitedSpan, 'limited span present');
    assertPresent(limitedSpan.attributes, 'limited span attributes present');
    assertPresent(limitedSpan.events, 'limited span events present');
    assertPresent(limitedSpan.links, 'limited span links present');
    assertPresent(limitedSpan.status, 'limited span status present');
    t.equal(started.length, 2, 'span processor onStart called for both spans');
    t.equal(spans.length, 1, 'queue limit dropped spans beyond capacity');
    t.equal(limitedSpan.attributes.alpha, 'abcde', 'attribute value length limit applied');
    t.equal(Object.keys(limitedSpan.attributes).length, 1, 'attribute count limit applied');
    t.equal(limitedSpan.events.length, 2, 'event count limit applied');
    t.equal(limitedSpan.links.length, 1, 'link count limit applied');
    t.equal(limitedSpan.status.code, 'ERROR', 'recordException promoted span status to error');
    await sdk.shutdown();
  });
  it('fans out default exporter pipelines across multiple exporters', async (t) => {
    const firstExporter = new InMemoryExporter();
    const secondExporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      exporters: [firstExporter, secondExporter],
      instrumentations: [
        {
          enable(targetSdk) {
            const startTopic = topic<SpanRecord>(otelTopic('trace', { name: 'fanout' }, 'start'));
            const endTopic = topic<SpanRecord>(otelTopic('trace', { name: 'fanout' }, 'end'));
            const starts = new Map<string, SpanRecord>();
            const a = startTopic.subscribe((evt: SpanRecord) => starts.set(evt.spanId, evt));
            const b = endTopic.subscribe((evt: SpanRecord) => {
              const start = starts.get(evt.spanId);
              if (!start) return;
              starts.delete(evt.spanId);
              targetSdk.recordSpan({
                name: evt.operation || evt.name || '',
                ...(evt.kind !== undefined ? { kind: evt.kind } : {}),
                traceId: evt.traceId,
                spanId: evt.spanId,
                ...(evt.parentSpanId !== undefined ? { parentSpanId: evt.parentSpanId } : {}),
                ...(start.timeUnixNano !== undefined
                  ? { startTimeUnixNano: start.timeUnixNano }
                  : {}),
                ...(evt.timeUnixNano !== undefined ? { endTimeUnixNano: evt.timeUnixNano } : {}),
                ...(evt.attributes ? { attributes: evt.attributes } : {}),
                ...(evt.scope ? { scope: evt.scope } : {}),
                ...(evt.resource ? { resource: evt.resource } : {}),
              });
            });
            return {
              dispose() {
                a.dispose();
                b.dispose();
              },
            };
          },
        },
      ],
    }).start();
    const tracer = new TracerProvider().getTracer('fanout');
    tracer.startSpan('op').end();
    await sdk.flush();
    t.equal(firstExporter.getFinishedSpans().length, 1, 'first exporter received span');
    t.equal(secondExporter.getFinishedSpans().length, 1, 'second exporter received span');
    await sdk.shutdown();
  });
  it('supports span mutation APIs and active parent context', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new TraceTopicInstrumentation()],
    }).start();
    const tracer = new TracerProvider({
      resource: new Resource({ 'service.name': 'trace-api-test' }),
    }).getTracer('trace.api', '1.0.0', {
      attributes: { library: 'test' },
      droppedAttributesCount: 1,
    });
    const parent = tracer.startSpan('parent');
    await runWithActiveSpan(parent, async () => {
      const child = tracer.startSpan('initial');
      child.updateName('child');
      child.setAttribute('http.method', 'GET');
      child.setAttributes({ 'http.route': '/users/:id' });
      child.addEvent('db.query', { statement: 'select 1' }, 123);
      child.addLink(
        {
          traceId: 'fedcba9876543210fedcba9876543210',
          spanId: 'fedcba9876543210',
        },
        { peer: 'remote' },
      );
      child.recordException(new Error('boom'), { handled: true });
      child.setStatus({
        code: 'ERROR',
        message: 'failed',
      });
      child.end();
    });
    parent.end();
    await sdk.flush();
    const spans = exporter.getFinishedSpans();
    const child = spans.find((span) => span.name === 'child');
    t.ok(child, 'child span exported');
    assertPresent(child, 'child span present');
    assertPresent(child.attributes, 'child attributes present');
    assertPresent(child.events, 'child events present');
    assertPresent(child.links, 'child links present');
    assertPresent(child.status, 'child status present');
    assertPresent(child.scope, 'child scope present');
    assertPresent(child.scope.attributes, 'child scope attributes present');
    assertPresent(child.events[0], 'first child event present');
    assertPresent(child.events[1], 'second child event present');
    t.equal(child.parentSpanId, parent.spanId, 'active parent context applied');
    t.equal(child.attributes['http.method'], 'GET', 'single attribute recorded');
    t.equal(child.attributes['http.route'], '/users/:id', 'multiple attributes recorded');
    t.equal(child.events.length, 2, 'manual event and exception event recorded');
    t.equal(child.events[0].name, 'db.query', 'manual event preserved');
    t.equal(child.events[1].name, 'exception', 'exception event recorded');
    t.equal(child.links.length, 1, 'link recorded');
    t.equal(child.status.code, 'ERROR', 'status recorded');
    t.equal(child.scope.attributes.library, 'test', 'scope attributes preserved');
    await sdk.shutdown();
  });
  it('ships built-in server and fetch instrumentations over runtime topics', async (t) => {
    const exporter = new InMemoryExporter();
    const parentProvider = new TracerProvider();
    const parentTracer = parentProvider.getTracer('parent');
    const activeParent = parentTracer.startSpan('parent');
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new HttpServerInstrumentation(), new FetchInstrumentation()],
    }).start();
    topic(otelRuntimeTopic('http.server', 'request', 'start')).publish(
      otelRuntimeEvent('http.server', 'request', 'start', {
        requestId: 'req-1',
        method: 'GET',
        route: '/items/:id',
        url: 'http://example.test/items/1',
        headers: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
        timeUnixNano: 100,
      }),
    );
    topic(otelRuntimeTopic('http.server', 'request', 'end')).publish(
      otelRuntimeEvent('http.server', 'request', 'end', {
        requestId: 'req-1',
        statusCode: 200,
        timeUnixNano: 200,
      }),
    );
    const outgoingHeaders: Record<string, unknown> = {};
    await runWithActiveSpan(activeParent, async () => {
      topic(otelRuntimeTopic('fetch', 'request', 'start')).publish(
        otelRuntimeEvent('fetch', 'request', 'start', {
          requestId: 'fetch-1',
          method: 'POST',
          url: 'https://api.example.test/orders',
          headers: outgoingHeaders,
          timeUnixNano: 300,
        }),
      );
    });
    topic(otelRuntimeTopic('fetch', 'request', 'error')).publish(
      otelRuntimeEvent('fetch', 'request', 'error', {
        requestId: 'fetch-1',
        error: new Error('socket closed'),
        timeUnixNano: 350,
      }),
    );
    await sdk.flush();
    const spans = exporter.getFinishedSpans();
    const serverSpan = spans.find((span) => span.name === 'GET /items/:id');
    const fetchSpan = spans.find((span) => span.name === 'POST https://api.example.test/orders');
    t.ok(serverSpan, 'server instrumentation created a span');
    assertPresent(serverSpan, 'server span present');
    assertPresent(serverSpan.attributes, 'server attributes present');
    t.equal(serverSpan.kind, 'server', 'server span kind');
    t.equal(serverSpan.attributes['http.route'], '/items/:id', 'server attributes recorded');
    t.equal(
      serverSpan.traceId,
      '0123456789abcdef0123456789abcdef',
      'incoming trace context extracted',
    );
    t.equal(serverSpan.parentSpanId, '0123456789abcdef', 'incoming parent span extracted');
    t.ok(fetchSpan, 'fetch instrumentation created a span');
    assertPresent(fetchSpan, 'fetch span present');
    assertPresent(fetchSpan.status, 'fetch status present');
    assertPresent(fetchSpan.injectedHeaders, 'fetch injected headers present');
    t.equal(fetchSpan.kind, 'client', 'fetch span kind');
    t.equal(fetchSpan.status.code, 'ERROR', 'fetch failure sets error status');
    t.ok(
      typeof fetchSpan.injectedHeaders.traceparent === 'string',
      'fetch instrumentation injected trace context',
    );
    t.equal(fetchSpan.parentSpanId, activeParent.spanId, 'fetch span linked to active parent');
    t.equal(
      outgoingHeaders.traceparent,
      fetchSpan.injectedHeaders.traceparent,
      'instrumentation mutates live outgoing headers',
    );
    activeParent.end();
    await sdk.shutdown();
  });
  it('ships built-in dns, socket, and tls instrumentations over runtime topics', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [
        new DnsInstrumentation(),
        new SocketInstrumentation(),
        new TlsInstrumentation(),
      ],
    }).start();
    topic(otelRuntimeTopic('dns', 'lookup', 'start')).publish(
      otelRuntimeEvent('dns', 'lookup', 'start', {
        lookupId: 'dns-1',
        requestId: 'fetch-42',
        hop: 0,
        hostname: 'api.example.test',
        timeUnixNano: 100,
      }),
    );
    topic(otelRuntimeTopic('dns', 'lookup', 'end')).publish(
      otelRuntimeEvent('dns', 'lookup', 'end', {
        lookupId: 'dns-1',
        requestId: 'fetch-42',
        hop: 0,
        hostname: 'api.example.test',
        address: '127.0.0.1',
        family: 4,
        timeUnixNano: 120,
      }),
    );
    topic(otelRuntimeTopic('socket', 'connect', 'start')).publish(
      otelRuntimeEvent('socket', 'connect', 'start', {
        connectId: 'socket-1',
        requestId: 'fetch-42',
        hop: 0,
        host: '127.0.0.1',
        port: 443,
        transport: 'tcp',
        timeUnixNano: 130,
      }),
    );
    topic(otelRuntimeTopic('socket', 'connect', 'end')).publish(
      otelRuntimeEvent('socket', 'connect', 'end', {
        connectId: 'socket-1',
        requestId: 'fetch-42',
        hop: 0,
        host: '127.0.0.1',
        port: 443,
        transport: 'tcp',
        timeUnixNano: 150,
      }),
    );
    topic(otelRuntimeTopic('tls', 'handshake', 'start')).publish(
      otelRuntimeEvent('tls', 'handshake', 'start', {
        handshakeId: 'tls-1',
        requestId: 'fetch-42',
        hop: 0,
        hostname: 'api.example.test',
        port: 443,
        timeUnixNano: 160,
      }),
    );
    topic(otelRuntimeTopic('tls', 'handshake', 'end')).publish(
      otelRuntimeEvent('tls', 'handshake', 'end', {
        handshakeId: 'tls-1',
        requestId: 'fetch-42',
        hop: 0,
        hostname: 'api.example.test',
        protocol: 'tls1.3',
        timeUnixNano: 180,
      }),
    );
    await sdk.flush();
    const spans = exporter.getFinishedSpans();
    const dnsSpan = spans.find((span) => span.name === 'DNS api.example.test');
    const socketSpan = spans.find((span) => span.name === 'CONNECT 127.0.0.1:443');
    const tlsSpan = spans.find((span) => span.name === 'TLS api.example.test:443');
    t.ok(dnsSpan, 'dns instrumentation created a span');
    assertPresent(dnsSpan, 'dns span present');
    assertPresent(dnsSpan.attributes, 'dns attributes present');
    t.equal(dnsSpan.kind, 'client', 'dns span kind');
    t.equal(dnsSpan.attributes['dns.question.name'], 'api.example.test', 'dns hostname recorded');
    t.equal(dnsSpan.attributes['net.sock.family'], 4, 'dns family recorded');
    t.ok(socketSpan, 'socket instrumentation created a span');
    assertPresent(socketSpan, 'socket span present');
    assertPresent(socketSpan.attributes, 'socket attributes present');
    t.equal(socketSpan.attributes['net.peer.name'], '127.0.0.1', 'socket host recorded');
    t.equal(socketSpan.attributes['net.peer.port'], 443, 'socket port recorded');
    t.ok(tlsSpan, 'tls instrumentation created a span');
    assertPresent(tlsSpan, 'tls span present');
    assertPresent(tlsSpan.attributes, 'tls attributes present');
    t.equal(tlsSpan.attributes['server.address'], 'api.example.test', 'tls hostname recorded');
    t.equal(tlsSpan.attributes['tls.protocol.name'], 'tls1.3', 'tls protocol recorded');
    await sdk.shutdown();
  });
  it('supports instrument-based metrics with SDK-side aggregation', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({ metricReaders: [new PeriodicMetricReader(exporter)] }).start();
    const meter = new MeterProvider({
      resource: new Resource({ 'service.name': 'metrics-test' }),
    }).getMeter('metrics.api', '1.0.0', { attributes: { library: 'test' } });
    const counter = meter.createCounter('http.server.requests', { unit: '1' });
    counter.add(2, { method: 'GET' });
    counter.add(3, { method: 'GET' });
    const upDownCounter = meter.createUpDownCounter('workers.active', { unit: '1' });
    upDownCounter.add(5, { pool: 'default' });
    upDownCounter.add(-2, { pool: 'default' });
    const histogram = meter.createHistogram('http.server.duration', { unit: 'ms' });
    histogram.record(10, { route: '/items/:id' });
    histogram.record(20, { route: '/items/:id' });
    const gauge = meter.createGauge('queue.depth', { unit: '1' });
    gauge.record(7, { queue: 'jobs' });
    const observableCounter = meter.createObservableCounter(
      'jobs.processed',
      () => [
        {
          value: 9,
          attributes: { queue: 'jobs' },
        },
      ],
      { unit: '1' },
    );
    const observableUpDownCounter = meter.createObservableUpDownCounter(
      'workers.available',
      () => [
        {
          value: -1,
          attributes: { pool: 'default' },
        },
      ],
      { unit: '1' },
    );
    let cpu = .7;
    const observableGauge = meter.createObservableGauge(
      'system.cpu.utilization',
      () => [
        {
          value: cpu,
          attributes: { core: 'all' },
        },
      ],
      { unit: '1' },
    );
    await sdk.flush();
    const metrics = exporter.getFinishedMetrics();
    const counterMetric = metrics.find((metric) => metric.name === 'http.server.requests');
    const upDownMetric = metrics.find((metric) => metric.name === 'workers.active');
    const histogramMetric = metrics.find((metric) => metric.name === 'http.server.duration');
    const gaugeMetric2 = metrics.find((metric) => metric.name === 'queue.depth');
    const observableCounterMetric = metrics.find((metric) => metric.name === 'jobs.processed');
    const observableUpDownCounterMetric = metrics.find(
      (metric) => metric.name === 'workers.available',
    );
    const gaugeMetric = metrics.find((metric) => metric.name === 'system.cpu.utilization');
    t.ok(counterMetric, 'counter metric exported');
    assertPresent(counterMetric, 'counter metric present');
    assertPresent(upDownMetric, 'up-down metric present');
    assertPresent(histogramMetric, 'histogram metric present');
    assertPresent(gaugeMetric2, 'queue depth metric present');
    assertPresent(observableCounterMetric, 'observable counter metric present');
    assertPresent(observableUpDownCounterMetric, 'observable up-down metric present');
    assertPresent(gaugeMetric, 'observable gauge metric present');
    t.equal(counterMetric.kind, 'counter', 'counter kind preserved');
    t.equal(counterMetric.value, 5, 'counter aggregated in SDK');
    t.equal(upDownMetric.value, 3, 'up-down counter aggregated in SDK');
    t.equal(upDownMetric.isMonotonic, false, 'up-down counter is non-monotonic');
    t.equal(histogramMetric.count, 2, 'histogram count aggregated');
    t.equal(histogramMetric.sum, 30, 'histogram sum aggregated');
    t.equal(gaugeMetric2.kind, 'gauge', 'gauge kind preserved');
    t.equal(gaugeMetric2.value, 7, 'gauge recorded');
    t.equal(observableCounterMetric.kind, 'observablecounter', 'observable counter kind preserved');
    t.equal(observableCounterMetric.value, 9, 'observable counter collected');
    t.equal(
      observableUpDownCounterMetric.kind,
      'observableupdowncounter',
      'observable up-down counter kind preserved',
    );
    t.equal(observableUpDownCounterMetric.value, -1, 'observable up-down counter collected');
    t.equal(gaugeMetric.value, .7, 'observable gauge collected');
    observableCounter.dispose();
    observableUpDownCounter.dispose();
    observableGauge.dispose();
    await sdk.shutdown();
  });
  it('bridges signals to observable gauges and manual reader collections', async (t) => {
    const reader = new ManualMetricReader();
    const provider = new MeterProvider();
    const sdk = new OtelSDK({ meterProvider: provider, metricReaders: [reader] }).start();
    const meter = provider.getMeter('signal.metrics');
    const value = createSignal(3);
    const handle = gaugeFromSignal(meter, 'signal.depth', value, {
      attributes: { queue: 'default' },
    });
    const collected = metricsSignal(reader, { intervalMs: 5 });
    const seen: number[] = [];
    const dispose = collected.subscribe((metrics) => {
      const metric = metrics.find((item) => item.name === 'signal.depth');
      if (metric) seen.push(metric.value ?? 0);
    });
    await sdk.flush();
    await delay(20);
    value.set(7);
    await sdk.flush();
    await delay(20);
    dispose();
    handle.dispose();
    await sdk.shutdown();
    t.ok(seen.includes(3), 'metrics signal collected initial gauge value');
    t.ok(seen.includes(7), 'metrics signal collected updated gauge value');
  });
  it('supports manual metric readers, views, and cardinality limits', async (t) => {
    const reader = new ManualMetricReader({ temporality: 'delta' });
    const sdk = new OtelSDK({
      metricReaders: [reader],
      views: [
        {
          instrumentName: 'db.client.duration',
          name: 'db.client.duration.ms',
          description: 'renamed by view',
          aggregation: {
            type: 'histogram',
            boundaries: [5, 10],
          },
        },
      ],
      metricCardinalityLimit: 1,
    }).start();
    const meter = new MeterProvider().getMeter('metrics.views', '1.0.0');
    const histogram = meter.createHistogram('db.client.duration', { unit: 'ms' });
    histogram.record(4, { route: '/a' });
    histogram.record(9, { route: '/a' });
    histogram.record(12, { route: '/b' });
    const counter = meter.createCounter('jobs.count', { unit: '1' });
    counter.add(1, { queue: 'a' });
    counter.add(1, { queue: 'b' });
    await sdk.flush();
    const first = reader.collect();
    const viewed = first.find((metric) => metric.name === 'db.client.duration.ms');
    const limited = first.filter((metric) => metric.name === 'jobs.count');
    t.ok(viewed, 'view renamed histogram metric');
    assertPresent(viewed, 'viewed metric present');
    t.equal(viewed.description, 'renamed by view', 'view description applied');
    t.deepEqual(viewed.explicitBounds, [5, 10], 'view aggregation boundaries applied');
    t.equal(viewed.aggregationTemporality, 1, 'manual reader applied delta temporality');
    t.equal(limited.length, 1, 'cardinality limit dropped extra attribute set');
    await sdk.flush();
    const second = reader.collect();
    const secondViewed = second.find((metric) => metric.name === 'db.client.duration.ms');
    assertPresent(secondViewed, 'second viewed metric present');
    t.equal(secondViewed.count, 0, 'delta reader resets aggregation after collection');
    await sdk.shutdown();
  });
  it('keeps cumulative and delta metric windows separate and records exemplars', async (t) => {
    const cumulativeReader = new ManualMetricReader({ temporality: 'cumulative' });
    const deltaReader = new ManualMetricReader({ temporality: 'delta' });
    const sdk = new OtelSDK({
      metricReaders: [cumulativeReader, deltaReader],
      views: [
        {
          instrumentName: 'db.calls',
          attributeKeys: ['db.system'],
        },
      ],
    }).start();
    const tracer = new TracerProvider().getTracer('metrics.windows', '1.0.0');
    const meter = new MeterProvider().getMeter('metrics.windows', '1.0.0');
    const counter = meter.createCounter('db.calls', { unit: '1' });
    const firstSpan = tracer.startSpan('db-window-1');
    await runWithActiveSpan(firstSpan, async () => {
      counter.add(2, {
        'db.system': 'mysql',
        'db.statement': 'select 1',
      });
    });
    firstSpan.end();
    await sdk.flush();
    const firstCumulative = cumulativeReader.collect().find((metric) => metric.name === 'db.calls');
    const firstDelta = deltaReader.collect().find((metric) => metric.name === 'db.calls');
    assertPresent(firstCumulative, 'first cumulative metric present');
    assertPresent(firstDelta, 'first delta metric present');
    assertPresent(firstDelta.exemplars, 'first delta exemplars present');
    assertPresent(firstDelta.exemplars[0], 'first delta exemplar present');
    t.equal(firstCumulative.value, 2, 'cumulative reader exports first total');
    t.equal(firstDelta.value, 2, 'delta reader exports first window');
    t.deepEqual(
      firstCumulative.attributes,
      { 'db.system': 'mysql' },
      'view filtered cumulative attributes',
    );
    t.deepEqual(firstDelta.attributes, { 'db.system': 'mysql' }, 'view filtered delta attributes');
    t.equal(firstDelta.exemplars.length, 1, 'delta reader includes exemplar');
    t.equal(
      firstDelta.exemplars[0].traceId,
      firstSpan.traceId,
      'exemplar trace id comes from active span',
    );
    t.equal(
      firstDelta.exemplars[0].spanId,
      firstSpan.spanId,
      'exemplar span id comes from active span',
    );
    const secondSpan = tracer.startSpan('db-window-2');
    await runWithActiveSpan(secondSpan, async () => {
      counter.add(3, {
        'db.system': 'mysql',
        'db.statement': 'select 2',
      });
    });
    secondSpan.end();
    await sdk.flush();
    const secondCumulative = cumulativeReader
      .collect()
      .find((metric) => metric.name === 'db.calls');
    const secondDelta = deltaReader.collect().find((metric) => metric.name === 'db.calls');
    assertPresent(secondCumulative, 'second cumulative metric present');
    assertPresent(secondDelta, 'second delta metric present');
    assertPresent(secondDelta.exemplars, 'second delta exemplars present');
    assertPresent(secondDelta.exemplars[0], 'second delta exemplar present');
    t.equal(secondCumulative.value, 5, 'cumulative reader keeps total across flushes');
    t.equal(secondDelta.value, 3, 'delta reader only exports new window');
    t.deepEqual(
      secondCumulative.attributes,
      { 'db.system': 'mysql' },
      'view filtering stays applied',
    );
    t.equal(secondDelta.exemplars.length, 1, 'delta window keeps latest exemplar');
    t.equal(
      secondDelta.exemplars[0].traceId,
      secondSpan.traceId,
      'second window exemplar updates to latest span',
    );
    await sdk.shutdown();
  });
  it('supports richer logger APIs and propagation facade helpers', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      logRecordProcessors: [
        {
          onEmit(log) {
            exporter.exportLogs([log]);
          },
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    }).start();
    const logger = new LoggerProvider({
      resource: new Resource({ 'service.name': 'logger-test' }),
    }).getLogger('app.logger', '1.0.0', { attributes: { library: 'test' } });
    const built = new LogRecordBuilder()
      .setBody({ message: 'login failed' })
      .setSeverity('ERROR', 17)
      .setAttribute('user.id', '42')
      .setContext({
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        traceFlags: 1,
      });
    logger.emitRecord(built);
    logger.error('login denied', { 'auth.method': 'password' });
    await sdk.flush();
    const logs = exporter.getFinishedLogs();
    const firstLog = logs[0];
    const secondLog = logs[1];
    assertPresent(firstLog, 'first log present');
    assertPresent(firstLog.attributes, 'first log attributes present');
    assertPresent(secondLog, 'second log present');
    assertPresent(secondLog.attributes, 'second log attributes present');
    assertPresent(secondLog.scope, 'second log scope present');
    assertPresent(secondLog.scope.attributes, 'second log scope attributes present');
    t.equal(logs.length, 2, 'logs exported');
    t.equal(firstLog.severityText, 'ERROR', 'builder severity applied');
    t.equal(firstLog.attributes['user.id'], '42', 'builder attribute applied');
    t.equal(firstLog.traceId, '0123456789abcdef0123456789abcdef', 'builder trace context applied');
    t.equal(secondLog.severityText, 'ERROR', 'severity helper applied');
    t.equal(secondLog.attributes['auth.method'], 'password', 'severity helper attributes applied');
    t.equal(secondLog.scope.attributes.library, 'test', 'logger scope attributes preserved');
    const carrier = {};
    Propagation.inject(carrier, {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
      baggage: new Baggage({ tenant: 'beta' }),
    });
    const extracted = Propagation.extract(carrier);
    assertPresent(extracted, 'propagation context extracted');
    t.equal(
      extracted.traceId,
      '0123456789abcdef0123456789abcdef',
      'propagation facade inject/extract works',
    );
    assertPresent(extracted.baggage, 'propagation facade extracts baggage');
    t.equal(
      extracted.baggage.get('tenant'),
      'beta',
      'propagation facade injects and extracts baggage',
    );
    await sdk.shutdown();
  });
  it('supports active-span log correlation, richer log records, and bounded log batching', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      logRecordProcessors: [
        new BatchLogRecordProcessor(exporter, {
          maxQueueSize: 1,
          maxExportBatchSize: 1,
          scheduledDelayMillis: 0,
          attributeCountLimit: 1,
          attributeValueLengthLimit: 5,
        }),
      ],
    }).start();
    const tracer = new TracerProvider().getTracer('logs.trace', '1.0.0');
    const logger = new LoggerProvider({
      resource: new Resource({ 'service.name': 'logs-test' }),
    }).getLogger('app.events', '1.0.0');
    const span = tracer.startSpan('active-log-parent');
    await runWithActiveSpan(span, async () => {
      logger.emitRecord(
        new LogRecordBuilder()
          .setTextBody('user-login-success')
          .setSeverity('INFO', 9)
          .setEventName('user.login')
          .setCategory('auth')
          .setAttributes({
            tenant: 'alpha',
            ignored: 'discarded',
          })
          .setDroppedAttributesCount(3),
      );
    });
    span.end();
    logger.error('dropped by queue', { queue: 'overflow' });
    await sdk.flush();
    const logs = exporter.getFinishedLogs();
    const activeLog = logs[0];
    assertPresent(activeLog, 'active log present');
    assertPresent(activeLog.attributes, 'active log attributes present');
    t.equal(logs.length, 1, 'bounded queue drops excess logs');
    t.equal(activeLog.traceId, span.traceId, 'active span trace id applied automatically');
    t.equal(activeLog.spanId, span.spanId, 'active span span id applied automatically');
    t.equal(activeLog.eventName, 'user.login', 'event name preserved');
    t.equal(activeLog.categoryName, 'auth', 'category preserved');
    t.equal(activeLog.body, 'user-login-success', 'text body helper applied');
    t.equal(
      activeLog.droppedAttributesCount,
      4,
      'dropped attributes count accumulated (3 pre-dropped + 1 dropped by limit)',
    );
    t.equal(Object.keys(activeLog.attributes).length, 1, 'log attribute count limit applied');
    t.equal(activeLog.attributes.tenant, 'alpha', 'first attribute preserved');
    await sdk.shutdown();
  });
  it('supports propagation adapters, tracestate, and automatic header propagation in built-in instrumentations', async (t) => {
    const headers = new Headers();
    const carrierApi: CarrierApi<Headers> = {
      get(carrier: Headers, key: string) {
        return carrier.get(key);
      },
      set(carrier: Headers, key: string, value: unknown) {
        carrier.set(key, String(value));
      },
      keys(carrier: Headers) {
        return [...carrier.keys()];
      },
    };
    Propagation.inject(
      headers,
      {
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        traceFlags: 1,
        traceState: 'vendor=value',
        baggage: new Baggage({ tenant: 'gamma' }),
      },
      carrierApi,
    );
    const extracted = Propagation.extract(headers, carrierApi);
    assertPresent(extracted, 'adapter context extracted');
    t.equal(
      headers.get('traceparent'),
      '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      'traceparent injected through adapter',
    );
    t.equal(headers.get('tracestate'), 'vendor=value', 'tracestate injected through adapter');
    t.equal(headers.get('baggage'), 'tenant=gamma', 'baggage injected through adapter');
    t.equal(extracted.traceState, 'vendor=value', 'tracestate extracted through adapter');
    assertPresent(extracted.baggage, 'baggage extracted through adapter');
    t.equal(extracted.baggage.get('tenant'), 'gamma', 'adapter baggage value round trips');
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new HttpServerInstrumentation(), new FetchInstrumentation()],
    }).start();
    const parent = new TracerProvider()
      .getTracer('propagation.parent')
      .startSpan('parent', { traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const propagationHeaders = new Headers();
    const outgoing = new Headers();
    await runWithActiveSpan(parent, async () => {
      topic('otel:runtime:fetch:request:start').publish({
        requestId: 'fetch-propagation-1',
        method: 'GET',
        url: 'https://api.example.test/items',
        headers: outgoing,
        timeUnixNano: 10,
      });
      topic('otel:runtime:fetch:request:end').publish({
        requestId: 'fetch-propagation-1',
        statusCode: 200,
        timeUnixNano: 20,
      });
      topic('otel:runtime:http.server:request:start').publish({
        requestId: 'server-propagation-1',
        method: 'POST',
        route: '/checkout',
        url: 'https://service.example.test/checkout',
        headers: outgoing,
        timeUnixNano: 30,
      });
      topic('otel:runtime:http.server:request:end').publish({
        requestId: 'server-propagation-1',
        statusCode: 201,
        timeUnixNano: 40,
      });
    });
    parent.end();
    await sdk.flush();
    const spans = exporter.getFinishedSpans();
    const fetchSpan = spans.find((span) => span.kind === 'client');
    const serverSpan = spans.find((span) => span.kind === 'server');
    t.ok(fetchSpan, 'fetch instrumentation created a client span');
    t.ok(serverSpan, 'server instrumentation created a server span');
    assertPresent(fetchSpan, 'propagated fetch span present');
    assertPresent(fetchSpan.injectedHeaders, 'propagated fetch headers present');
    assertPresent(serverSpan, 'propagated server span present');
    t.equal(
      outgoing.get('traceparent'),
      fetchSpan.injectedHeaders.traceparent,
      'fetch instrumentation propagates through Headers carrier',
    );
    t.equal(
      serverSpan.parentSpanId,
      fetchSpan.spanId,
      'server instrumentation extracts parent from propagated headers',
    );
    await sdk.shutdown();
  });
  it('supports baggage-aware active context helpers and remote parent defaults', async (t) => {
    const exporter = new InMemoryExporter();
    const logProcessor: LogRecordProcessor & {
      logs: LogRecord[];
    } = {
      logs: [],
      onEmit(log) {
        this.logs.push(log);
      },
      async forceFlush() {},
      async shutdown() {},
    };
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      logRecordProcessors: [logProcessor],
      instrumentations: [
        new FetchInstrumentation(),
        {
          enable(targetSdk) {
            const startTopic = topic<SpanRecord>(
              otelTopic(
                'trace',
                {
                  name: 'context.remote',
                  version: '1.0.0',
                },
                'start',
              ),
            );
            const endTopic = topic<SpanRecord>(
              otelTopic(
                'trace',
                {
                  name: 'context.remote',
                  version: '1.0.0',
                },
                'end',
              ),
            );
            const starts = new Map<string, SpanRecord>();
            const a = startTopic.subscribe((evt: SpanRecord) => starts.set(evt.spanId, evt));
            const b = endTopic.subscribe((evt: SpanRecord) => {
              const start = starts.get(evt.spanId);
              if (!start) return;
              starts.delete(evt.spanId);
              targetSdk.recordSpan({
                name: evt.operation || evt.name || '',
                ...(evt.kind !== undefined ? { kind: evt.kind } : {}),
                traceId: evt.traceId,
                spanId: evt.spanId,
                ...(evt.parentSpanId !== undefined ? { parentSpanId: evt.parentSpanId } : {}),
                ...((start.timeUnixNano ?? evt.startTimeUnixNano) !== undefined
                  ? { startTimeUnixNano: start.timeUnixNano ?? evt.startTimeUnixNano }
                  : {}),
                ...(evt.timeUnixNano !== undefined ? { endTimeUnixNano: evt.timeUnixNano } : {}),
                ...(evt.attributes ? { attributes: evt.attributes } : {}),
                ...(evt.scope ? { scope: evt.scope } : {}),
                ...(evt.resource ? { resource: evt.resource } : {}),
                ...(evt.status !== undefined ? { status: evt.status } : {}),
              });
            });
            return {
              dispose() {
                a.dispose();
                b.dispose();
              },
            };
          },
        },
      ],
    }).start();
    const tracer = new TracerProvider().getTracer('context.remote', '1.0.0');
    const logger = new LoggerProvider().getLogger('context.remote', '1.0.0');
    const remoteContext = {
      traceId: '11111111111111111111111111111111',
      spanId: '2222222222222222',
      traceFlags: 1,
      traceState: 'vendor=remote',
      baggage: new Baggage({ tenant: 'delta' }),
    };
    const propagationHeaders = new Headers();
    const outgoing = new Headers();
    await runWithActiveContext(remoteContext, async () => {
      t.equal(getActiveSpan(), undefined, 'no active span object for remote context');
      const activeContext = getActiveSpanContext();
      assertPresent(activeContext, 'active remote context present');
      t.equal(activeContext.spanId, remoteContext.spanId, 'remote active span context visible');
      t.equal(activeContext.traceState, 'vendor=remote', 'remote tracestate visible');
      t.equal(getActiveBaggage().get('tenant'), 'delta', 'remote baggage visible');
      await runWithBaggage(
        new Baggage({
          tenant: 'nested',
          region: 'us',
        }),
        async () => {
          t.equal(
            getActiveBaggage().get('tenant'),
            'nested',
            'nested baggage overrides active baggage',
          );
          const nestedContext = getActiveSpanContext();
          assertPresent(nestedContext, 'nested active context present');
          assertPresent(nestedContext.baggage, 'nested baggage present');
          t.equal(
            nestedContext.baggage.get('region'),
            'us',
            'active span context reflects nested baggage',
          );
          const child = tracer.startSpan('child-from-remote');
          child.end();
          logger.info('remote-linked-log');
          Propagation.inject(propagationHeaders);
          topic('otel:runtime:fetch:request:start').publish({
            requestId: 'fetch-active-context-1',
            method: 'GET',
            url: 'https://context.example.test/items',
            headers: outgoing,
            timeUnixNano: 100,
          });
          topic('otel:runtime:fetch:request:end').publish({
            requestId: 'fetch-active-context-1',
            statusCode: 200,
            timeUnixNano: 200,
          });
        },
      );
    });
    await sdk.flush();
    const spans = exporter.getFinishedSpans();
    const childSpan = spans.find((span) => span.name === 'child-from-remote');
    const fetchSpan = spans.find((span) => span.kind === 'client');
    t.ok(childSpan, 'child span exported');
    assertPresent(childSpan, 'remote child span present');
    t.equal(
      childSpan.parentSpanId,
      remoteContext.spanId,
      'tracer defaults parent from active remote context',
    );
    t.ok(fetchSpan, 'fetch span exported');
    assertPresent(fetchSpan, 'remote fetch span present');
    t.equal(
      fetchSpan.parentSpanId,
      remoteContext.spanId,
      'fetch instrumentation uses active remote context',
    );
    t.equal(
      propagationHeaders.get('traceparent'),
      `00-${remoteContext.traceId}-${remoteContext.spanId}-01`,
      'propagation inject uses active context automatically',
    );
    t.equal(
      propagationHeaders.get('baggage'),
      'tenant=nested,region=us',
      'propagation inject uses active baggage automatically',
    );
    await sdk.shutdown();
  });
  describe('OTLP exporter', () => {
    it('exports spans as OTLP JSON over HTTP via the SDK', async (t) => {
      const received: CapturedFetchRecord[] = [];
      const fetchCalls: CapturedFetchCall[] = [];
      await mockFetch(async (mock) => {
        mock
          .post('http://127.0.0.1:4318/v1/traces')
          .replyWith(captureFetchCall(received, fetchCalls));
        const exporter = new OTLPHttpJsonExporter({
          endpoint: 'http://127.0.0.1:4318',
          headers: { 'x-test-header': 'present' },
        });
        const sdk = new OtelSDK({
          spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
        });
        sdk.start();
        sdk.recordSpan({
          name: 'request',
          kind: 'server',
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
          startTimeUnixNano: 100,
          endTimeUnixNano: 200,
          attributes: { 'http.request.method': 'GET' },
          events: [
            {
              timeUnixNano: 150,
              name: 'send',
              attributes: { bytes: 42 },
            },
          ],
          links: [
            {
              traceId: 'fedcba9876543210fedcba9876543210',
              spanId: 'fedcba9876543210',
              attributes: { remote: true },
              flags: 1,
            },
          ],
          scope: {
            name: 'http.server',
            version: '1.0.0',
            schemaUrl: 'https://schemas.example/scope',
            attributes: { library: 'builtin' },
            droppedAttributesCount: 2,
          },
          resource: new Resource(
            { 'service.name': 'otlp-test' },
            {
              droppedAttributesCount: 1,
              schemaUrl: 'https://schemas.example/resource',
            },
          ),
        });
        await sdk.flush();
        t.equal(received.length, 1, 'one export request sent');
        const firstReceived = received[0];
        assertPresent(firstReceived, 'trace export captured');
        t.equal(firstReceived.method, 'POST', 'uses POST');
        t.equal(firstReceived.path, '/v1/traces', 'uses OTLP traces endpoint');
        t.equal(firstReceived.headers.contentType, 'application/json', 'uses JSON content type');
        t.equal(firstReceived.headers.custom, 'present', 'forwards custom header');
        const payload = JSON.parse(firstReceived.text);
        t.ok(payload.resourceSpans, 'resourceSpans present');
        const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
        t.equal(span.name, 'request', 'span name encoded');
        t.equal(span.kind, 2, 'server kind encoded as 2');
        t.ok(
          span.attributes.some((a: { key: string }) => a.key === 'http.request.method'),
          'span attribute encoded',
        );
        t.ok(span.events?.length > 0, 'span events encoded');
        t.ok(span.links?.length > 0, 'span links encoded');
        await sdk.shutdown();
      });
    });
    it('exports logs and metrics as OTLP JSON over HTTP', async (t) => {
      const received: CapturedFetchRecord[] = [];
      const fetchCalls: CapturedFetchCall[] = [];
      await mockFetch(async (mock) => {
        mock
          .post('http://127.0.0.1:4318/v1/logs')
          .replyWith(captureFetchCall(received, fetchCalls));
        mock
          .post('http://127.0.0.1:4318/v1/metrics')
          .replyWith(captureFetchCall(received, fetchCalls));
        const exporter = new OTLPHttpJsonExporter({ endpoint: 'http://127.0.0.1:4318' });
        await exporter.exportLogs([
          {
            timeUnixNano: 100,
            observedTimeUnixNano: 100,
            severityNumber: 17,
            severityText: 'ERROR',
            body: 'db failed',
            attributes: { retryable: true },
            flags: 1,
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            scope: {
              name: 'app.logs',
              version: '1.0.0',
              attributes: { source: 'app' },
              droppedAttributesCount: 1,
            },
            resource: new Resource({ 'service.name': 'otlp-test' }, { droppedAttributesCount: 2 }),
          },
        ]);
        await exporter.exportMetrics([
          {
            name: 'db.query.count',
            kind: 'counter',
            value: 3,
            unit: '1',
            aggregationTemporality: 2,
            isMonotonic: true,
            attributes: { db: 'mysql' },
            timeUnixNano: 200,
            startTimeUnixNano: 100,
            scope: {
              name: 'app.metrics',
              version: '1.0.0',
              attributes: { source: 'app' },
            },
            resource: new Resource({ 'service.name': 'otlp-test' }),
          },
          {
            name: 'db.query.duration',
            kind: 'histogram',
            timeUnixNano: 200,
            startTimeUnixNano: 100,
            count: 2,
            sum: 12.5,
            bucketCounts: [1, 1],
            explicitBounds: [10],
            min: 5,
            max: 7.5,
            attributes: { db: 'mysql' },
            scope: {
              name: 'app.metrics',
              version: '1.0.0',
            },
            resource: new Resource({ 'service.name': 'otlp-test' }),
          },
        ]);
        t.equal(received.length, 2, 'log and metric exports were sent');
        const logsPayload = JSON.parse(received[0]!.text);
        const metricsPayload = JSON.parse(received[1]!.text);
        t.equal(received[0]!.path, '/v1/logs', 'logs use OTLP logs endpoint');
        t.equal(received[1]!.path, '/v1/metrics', 'metrics use OTLP metrics endpoint');
        const logRecord = logsPayload.resourceLogs[0].scopeLogs[0].logRecords[0];
        t.equal(logRecord.severityText, 'ERROR', 'log severity text encoded');
        t.equal(logRecord.traceId, '0123456789abcdef0123456789abcdef', 'log traceId encoded');
        const sumMetric = metricsPayload.resourceMetrics[0].scopeMetrics[0].metrics.find(
          (m: { name: string }) => m.name === 'db.query.count',
        );
        t.ok(sumMetric?.sum, 'counter encoded as sum');
        const histMetric = metricsPayload.resourceMetrics[0].scopeMetrics[0].metrics.find(
          (m: { name: string }) => m.name === 'db.query.duration',
        );
        t.ok(histMetric?.histogram, 'histogram encoded');
      });
    });
    it('exports traces, logs, and metrics as OTLP JSON over HTTP', async (t) => {
      const received: CapturedFetchRecord[] = [];
      const fetchCalls: CapturedFetchCall[] = [];
      await mockFetch(async (mock) => {
        mock
          .post('http://127.0.0.1:4318/v1/traces')
          .replyWith(captureFetchCall(received, fetchCalls));
        mock
          .post('http://127.0.0.1:4318/v1/logs')
          .replyWith(captureFetchCall(received, fetchCalls));
        mock
          .post('http://127.0.0.1:4318/v1/metrics')
          .replyWith(captureFetchCall(received, fetchCalls));
        const exporter = new OTLPHttpJsonExporter({
          endpoint: 'http://127.0.0.1:4318',
          headers: { 'x-test-header': 'present' },
        });
        await exporter.exportSpans([
          {
            name: 'json-span',
            kind: 'server',
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            startTimeUnixNano: 100,
            endTimeUnixNano: 200,
            attributes: { 'http.method': 'GET' },
            scope: {
              name: 'json.scope',
              version: '1.0.0',
            },
            resource: new Resource({ 'service.name': 'json-test' }),
          },
        ]);
        await exporter.exportLogs([
          {
            timeUnixNano: 100,
            observedTimeUnixNano: 100,
            severityNumber: 9,
            severityText: 'INFO',
            body: 'json log',
            attributes: { env: 'test' },
            scope: {
              name: 'json.scope',
              version: '1.0.0',
            },
            resource: new Resource({ 'service.name': 'json-test' }),
          },
        ]);
        await exporter.exportMetrics([
          {
            name: 'json.counter',
            kind: 'counter',
            value: 3,
            unit: '1',
            aggregationTemporality: 2,
            isMonotonic: true,
            attributes: { env: 'test' },
            timeUnixNano: 200,
            startTimeUnixNano: 100,
            scope: {
              name: 'json.scope',
              version: '1.0.0',
            },
            resource: new Resource({ 'service.name': 'json-test' }),
          },
        ]);
        t.equal(received.length, 3, 'json exports were sent');
        const traceRequest = received[0];
        const logRequest = received[1];
        const metricRequest = received[2];
        assertPresent(traceRequest, 'json trace request captured');
        assertPresent(logRequest, 'json log request captured');
        assertPresent(metricRequest, 'json metric request captured');
        t.equal(
          traceRequest.headers.contentType,
          'application/json',
          'json exporter uses json content type',
        );
        t.equal(
          logRequest.headers.contentType,
          'application/json',
          'json log exporter uses json content type',
        );
        t.equal(
          metricRequest.headers.contentType,
          'application/json',
          'json metric exporter uses json content type',
        );
        const tracePayload = JSON.parse(traceRequest.text);
        const logPayload = JSON.parse(logRequest.text);
        const metricPayload = JSON.parse(metricRequest.text);
        t.ok(Array.isArray(tracePayload.resourceSpans), 'trace payload uses resourceSpans');
        t.equal(
          tracePayload.resourceSpans[0].scopeSpans[0].spans[0].name,
          'json-span',
          'trace span name encoded',
        );
        t.ok(Array.isArray(logPayload.resourceLogs), 'log payload uses resourceLogs');
        t.equal(
          logPayload.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue,
          'json log',
          'log body encoded as json any value',
        );
        t.ok(Array.isArray(metricPayload.resourceMetrics), 'metric payload uses resourceMetrics');
        t.equal(
          metricPayload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt,
          '3',
          'metric datapoint encoded in json',
        );
      });
    });
    it('maps each export signal to the matching HTTP route', async (t) => {
      const received: CapturedFetchRecord[] = [];
      const fetchCalls: CapturedFetchCall[] = [];
      await mockFetch(async (mock) => {
        mock
          .post('http://127.0.0.1:4318/v1/traces')
          .replyWith(captureFetchCall(received, fetchCalls));
        mock
          .post('http://127.0.0.1:4318/v1/logs')
          .replyWith(captureFetchCall(received, fetchCalls));
        mock
          .post('http://127.0.0.1:4318/v1/metrics')
          .replyWith(captureFetchCall(received, fetchCalls));
        const jsonExporter = new OTLPHttpJsonExporter({ endpoint: 'http://127.0.0.1:4318' });
        await jsonExporter.exportSpans([
          {
            name: 'route-json-span',
            kind: 'server',
            traceId: 'fedcba9876543210fedcba9876543210',
            spanId: 'fedcba9876543210',
            startTimeUnixNano: 1,
            endTimeUnixNano: 2,
            attributes: {},
            scope: { name: 'route.scope' },
            resource: new Resource({ 'service.name': 'route-test' }),
          },
        ]);
        await jsonExporter.exportLogs([
          {
            timeUnixNano: 1,
            observedTimeUnixNano: 1,
            severityNumber: 9,
            severityText: 'INFO',
            body: 'route-json-log',
            attributes: {},
            scope: { name: 'route.scope' },
            resource: new Resource({ 'service.name': 'route-test' }),
          },
        ]);
        await jsonExporter.exportMetrics([
          {
            name: 'route-json-metric',
            kind: 'counter',
            value: 1,
            unit: '1',
            attributes: {},
            timeUnixNano: 1,
            startTimeUnixNano: 1,
            scope: { name: 'route.scope' },
            resource: new Resource({ 'service.name': 'route-test' }),
          },
        ]);
        await jsonExporter.shutdown();
        assertPresent(received[0], 'json traces request present');
        assertPresent(received[1], 'json logs request present');
        assertPresent(received[2], 'json metrics request present');
        t.equal(received[0].path, '/v1/traces', 'json span export targets traces route');
        t.equal(received[1].path, '/v1/logs', 'json log export targets logs route');
        t.equal(received[2].path, '/v1/metrics', 'json metric export targets metrics route');
      });
    });
    it('injects and extracts W3C trace context through the propagator API', (t) => {
      const propagator = new W3CTraceContextPropagator();
      const carrier: Record<string, string> = {};
      const baggage = new Baggage({ tenant: 'alpha' });
      propagator.inject(carrier, {
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        traceFlags: 1,
        traceState: 'rojo=00f067aa0ba902b7',
        baggage,
      });
      t.equal(
        carrier.traceparent,
        '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
        'traceparent injected',
      );
      t.equal(carrier.tracestate, 'rojo=00f067aa0ba902b7', 'tracestate injected');
      t.equal(carrier.baggage, 'tenant=alpha', 'baggage injected');
      const extracted = propagator.extract(carrier);
      t.ok(extracted, 'trace context extracted');
      if (!extracted) return;
      t.equal(extracted.traceId, '0123456789abcdef0123456789abcdef', 'trace id extracted');
      t.equal(extracted.spanId, '0123456789abcdef', 'span id extracted');
      t.equal(extracted.traceFlags, 1, 'trace flags extracted');
      t.equal(extracted.traceState, 'rojo=00f067aa0ba902b7', 'tracestate extracted');
      assertPresent(extracted.baggage, 'baggage extracted');
      t.equal(extracted.baggage.get('tenant'), 'alpha', 'baggage value extracted');
    });
    it('rejects invalid W3C traceparent values', (t) => {
      const propagator = new W3CTraceContextPropagator();
      const validTraceId = '0123456789abcdef0123456789abcdef';
      const validSpanId = '0123456789abcdef';
      for (const traceparent of [
        `ff-${validTraceId}-${validSpanId}-01`,
        `00-${validTraceId.toUpperCase()}-${validSpanId}-01`,
        `00-${validTraceId}-${validSpanId.toUpperCase()}-01`,
        `00-${validTraceId}-${validSpanId}-01-extra`,
        `00-${validTraceId.slice(1)}-${validSpanId}-01`,
      ]) {
        t.equal(propagator.extract({ traceparent }), null, `${traceparent} is rejected`);
      }
    });
    it('supports exporter retries, timeout options, per-signal endpoints, compression, and hooks', async (t) => {
      const events: HookEvent[] = [];
      const received: CapturedFetchRecord[] = [];
      const fetchCalls: CapturedFetchCall[] = [];
      await mockFetch(async (mock) => {
        mock.post('http://127.0.0.1:4318/custom-traces').replyWith(
          captureFetchCall(
            received,
            fetchCalls,
            () =>
              new Response(
                JSON.stringify({
                  partialSuccess: {
                    rejectedSpans: 1,
                    errorMessage: 'slow down',
                  },
                }),
                { status: 200 },
              ),
          ),
        );
        mock
          .post('http://127.0.0.1:4318/custom-logs')
          .replyWith(
            captureFetchCall(received, fetchCalls, () => new Response('retry me', { status: 503 })),
          );
        mock
          .post('http://127.0.0.1:4318/custom-logs')
          .replyWith(
            captureFetchCall(received, fetchCalls, () => new Response('ok', { status: 200 })),
          );
        mock
          .post('http://127.0.0.1:4318/custom-metrics')
          .replyWith(
            captureFetchCall(received, fetchCalls, () => new Response('ok', { status: 200 })),
          );
        const exporter = new OTLPHttpJsonExporter({
          endpoint: 'http://127.0.0.1:4318',
          endpoints: {
            traces: 'http://127.0.0.1:4318/custom-traces',
            logs: 'http://127.0.0.1:4318/custom-logs',
            metrics: 'http://127.0.0.1:4318/custom-metrics',
          },
          headers: { 'x-test-header': 'present' },
          timeoutMillis: 1234,
          compression: 'gzip',
          retry: {
            maxAttempts: 2,
            initialBackoffMillis: 1,
          },
          onError(error) {
            events.push({
              type: 'error',
              message: String(error.message || error),
            });
          },
          onPartialSuccess(result) {
            events.push({
              type: 'partial',
              result,
            });
          },
        });
        const first = await exporter.exportSpans([
          {
            name: 'retry-span',
            kind: 'client',
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            startTimeUnixNano: 1,
            endTimeUnixNano: 2,
            attributes: {},
            scope: { name: 'retry.scope' },
            resource: new Resource({ 'service.name': 'retry-test' }),
          },
        ]);
        const second = await exporter.exportLogs([
          {
            severityText: 'INFO',
            severityNumber: 9,
            body: 'retry-log',
            attributes: {},
            scope: { name: 'retry.scope' },
            resource: new Resource({ 'service.name': 'retry-test' }),
          },
        ]);
        const third = await exporter.exportMetrics([
          {
            name: 'retry.metric',
            kind: 'counter',
            value: 1,
            unit: '1',
            attributes: {},
            scope: { name: 'retry.scope' },
            resource: new Resource({ 'service.name': 'retry-test' }),
          },
        ]);
        t.equal(first.code, 'success', 'partial success still returns success');
        t.equal(second.code, 'success', 'retry recovers failed export');
        t.equal(third.code, 'success', 'metrics export succeeds');
        assertPresent(received[0], 'custom traces request present');
        assertPresent(received[1], 'first custom logs request present');
        assertPresent(received[2], 'second custom logs request present');
        assertPresent(received[3], 'custom metrics request present');
        assertPresent(events[0], 'partial event present');
        assertPresent(events[1], 'error event present');
        assertPresent(events[0].result, 'partial result present');
        t.equal(received[0].path, '/custom-traces', 'trace endpoint override applied');
        t.equal(received[1].path, '/custom-logs', 'log endpoint override applied');
        t.equal(received[2].path, '/custom-logs', 'failed log attempt kept custom endpoint');
        t.equal(received[3].path, '/custom-metrics', 'metric endpoint override applied');
        t.equal(received[0].headers.encoding, 'gzip', 'compression header applied');
        t.ok(
          fetchCalls.every(
            (call) => 'signal' in ((call.init as Record<string, unknown> | null | undefined) || {}),
          ),
          'timeout signal configured',
        );
        t.equal(events[0].type, 'partial', 'partial success hook fired');
        t.equal(events[0].result.rejectedSpans, 1, 'partial success payload parsed');
        t.equal(events[1].type, 'error', 'error hook fired for retryable failure');
        await exporter.shutdown();
        const afterShutdown = await exporter.exportSpans([
          {
            name: 'after-shutdown',
            kind: 'client',
            traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            spanId: 'aaaaaaaaaaaaaaaa',
            startTimeUnixNano: 1,
            endTimeUnixNano: 2,
            attributes: {},
            scope: { name: 'retry.scope' },
            resource: new Resource({ 'service.name': 'retry-test' }),
          },
        ]);
        t.equal(afterShutdown.code, 'failure', 'shutdown exporter rejects further export');
      });
    });
    it('does not retry non-429 client errors', async (t) => {
      const received: CapturedFetchRecord[] = [];
      const fetchCalls: CapturedFetchCall[] = [];
      await mockFetch(async (mock) => {
        mock
          .post('http://127.0.0.1:4318/v1/traces')
          .replyWith(
            captureFetchCall(
              received,
              fetchCalls,
              () => new Response('bad request', { status: 400 }),
            ),
          );
        const exporter = new OTLPHttpJsonExporter({
          endpoint: 'http://127.0.0.1:4318',
          retry: {
            maxAttempts: 3,
            initialBackoffMillis: 1,
          },
        });
        const result = await exporter.exportSpans([
          {
            name: 'client-error',
            kind: 'client',
            traceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            spanId: 'bbbbbbbbbbbbbbbb',
            startTimeUnixNano: 1,
            endTimeUnixNano: 2,
            attributes: {},
            scope: { name: 'retry.scope' },
            resource: new Resource({ 'service.name': 'retry-test' }),
          },
        ]);
        t.equal(result.code, 'failure', '400 export fails');
        t.equal(received.length, 1, 'non-429 4xx is not retried');
        t.equal(fetchCalls.length, 1, 'only one HTTP call was made');
      });
    });
    it('retries 429 responses and honors Retry-After', async (t) => {
      const received: CapturedFetchRecord[] = [];
      const fetchCalls: CapturedFetchCall[] = [];
      await mockFetch(async (mock) => {
        mock.post('http://127.0.0.1:4318/v1/traces').replyWith(
          captureFetchCall(
            received,
            fetchCalls,
            () =>
              new Response('rate limited', {
                status: 429,
                headers: { 'retry-after': '0' },
              }),
          ),
        );
        mock
          .post('http://127.0.0.1:4318/v1/traces')
          .replyWith(
            captureFetchCall(received, fetchCalls, () => new Response('ok', { status: 200 })),
          );
        const exporter = new OTLPHttpJsonExporter({
          endpoint: 'http://127.0.0.1:4318',
          retry: {
            maxAttempts: 2,
            initialBackoffMillis: 1e3,
          },
        });
        const result = await exporter.exportSpans([
          {
            name: 'rate-limited',
            kind: 'client',
            traceId: 'cccccccccccccccccccccccccccccccc',
            spanId: 'cccccccccccccccc',
            startTimeUnixNano: 1,
            endTimeUnixNano: 2,
            attributes: {},
            scope: { name: 'retry.scope' },
            resource: new Resource({ 'service.name': 'retry-test' }),
          },
        ]);
        t.equal(result.code, 'success', '429 retry can recover');
        t.equal(received.length, 2, '429 response was retried');
        t.equal(fetchCalls.length, 2, 'two HTTP calls were made');
      });
    });
  });
});
