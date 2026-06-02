/**
 * internal/opentelemetry/bootstrap — internal runtime module.
 *
 * 
 * @internal
 */

import { cwd } from '../../process.mts';
import { DiskFileSystem } from '../../file/fs.mts';
import {
  BatchLogRecordProcessor,
  BatchSpanProcessor,
  DnsInstrumentation,
  FetchInstrumentation,
  HttpServerInstrumentation,
  LoggerProvider,
  MeterProvider,
  OtelSDK,
  OTLPHttpJsonExporter,
  PeriodicMetricReader,
  Resource,
  SocketInstrumentation,
  TraceTopicInstrumentation,
  TlsInstrumentation,
  TracerProvider,
} from '../../opentelemetry.mts';
import { registerShutdownHook } from '../shutdown.mts';

function logOtelDebug(prefix: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.error(`[otel] ${prefix}: ${text}`);
}

function inferServiceName(script: string): string {
  const trimmed = String(script || '').trim();
  if (!trimmed) return 'unknown_service';
  const normalized = trimmed.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = normalized.split(/[/:]/).filter(Boolean);
  const last = parts.at(-1) || '';
  const basename = last.replace(/\.[^.]+$/, '');
  return basename || 'unknown_service';
}

const fs = new DiskFileSystem();

async function loadCliResource(script: string): Promise<Resource> {
  const attributes: Record<string, unknown> = {};
  try {
    const pkgText = await fs.readFile(`${cwd()}/package.json`);
    const pkg = JSON.parse(pkgText);
    if (typeof pkg?.name === 'string' && pkg.name.trim()) attributes['service.name'] = pkg.name.trim();
    if (typeof pkg?.version === 'string' && pkg.version.trim()) attributes['service.version'] = pkg.version.trim();
  } catch {}
  if (!attributes['service.name']) attributes['service.name'] = inferServiceName(script);
  return new Resource(attributes);
}

export async function createCliOtelRuntime(endpoint: string, script: string, debug = false) {
  const exporter = new OTLPHttpJsonExporter({
    endpoint,
    onError(error) {
      console.error(`[otel] export to ${endpoint} failed: ${error.message}`);
    },
    onPartialSuccess(result) {
      const details = [
        `rejectedSpans=${result.rejectedSpans || 0}`,
        `rejectedLogs=${result.rejectedLogs || 0}`,
        `rejectedDataPoints=${result.rejectedDataPoints || 0}`,
      ];
      if (result.errorMessage) details.push(`message=${result.errorMessage}`);
      console.error(`[otel] partial success from ${endpoint}: ${details.join(' ')}`);
    },
    onRequest(info) {
      if (!debug) return;
      logOtelDebug(`request ${info.signal} ${info.method} ${info.url}`, {
        headers: info.headers,
        body: info.bodyText || (info.bodyBytes ? `[${info.bodyBytes.byteLength} bytes]` : ''),
      });
    },
    onResponse(info) {
      if (!debug) return;
      logOtelDebug(`response ${info.signal} ${info.status} ${info.url}`, {
        headers: info.headers,
        body: info.bodyText,
      });
    },
  });
  const tracerProvider = new TracerProvider();
  const loggerProvider = new LoggerProvider();
  const meterProvider = new MeterProvider();
  const resource = await loadCliResource(script);
  const sdk = new OtelSDK({
    resource,
    exporters: [exporter],
    spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 1000 })],
    logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 1000 })],
    metricReaders: [new PeriodicMetricReader(exporter, { intervalMs: 1000 })],
    instrumentations: [
      new TraceTopicInstrumentation(),
      new HttpServerInstrumentation(),
      new FetchInstrumentation(),
      new DnsInstrumentation(),
      new SocketInstrumentation(),
      new TlsInstrumentation(),
    ],
  }).start();
  registerShutdownHook(async () => {
    await sdk.shutdown();
  });
  return { tracerProvider, loggerProvider, meterProvider };
}
