/**
* internal/opentelemetry/bootstrap — internal runtime module.
*
* Creates the OpenTelemetry runtime used by CLI script execution when
* `--otlp-endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT` is supplied. It configures
* OTLP/HTTP JSON export, resource attributes, runtime instrumentations,
* processors, readers, and a shutdown hook that flushes providers before the
* CLI exits.
*
* The release baseline covers built-in HTTP server, fetch, DNS, socket, TLS,
* and trace-topic instrumentations plus OTLP/HTTP JSON export. `OTEL_EXPORTER_OTLP_ENDPOINT`,
* per-signal endpoint env vars, comma-separated `OTEL_EXPORTER_OTLP_HEADERS`,
* `OTEL_EXPORTER_OTLP_COMPRESSION=none|gzip`, `OTEL_RESOURCE_ATTRIBUTES`, and
* `OTEL_SERVICE_NAME` are supported for CLI bootstrap. OTLP protobuf/gRPC,
* auto-discovery of third-party instrumentation packages, and upstream Node SDK
* bootstrap parity are intentionally outside this module.
*
* ```js
* import { createCliOtelRuntime } from 'internal:opentelemetry/bootstrap';
* console.log(typeof createCliOtelRuntime);
* ```
*
* @internal
*/
import { cwd, env } from '../../process.ts';
import { DiskFileSystem } from '../../file/fs.ts';
import { BatchLogRecordProcessor, BatchSpanProcessor, DnsInstrumentation, FetchInstrumentation, HttpServerInstrumentation, JobsInstrumentation, LoggerProvider, MeterProvider, OtelSDK, OTLPHttpJsonExporter, PeriodicMetricReader, Resource, SocketInstrumentation, TraceTopicInstrumentation, TlsInstrumentation, TracerProvider } from '../../opentelemetry.ts';
import { registerShutdownHook } from '../shutdown.ts';
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
function envString(key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}
function parseCommaKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of text.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}
function envSignalEndpoints(): {
  traces?: string;
  logs?: string;
  metrics?: string;
} {
  const endpoints: {
    traces?: string;
    logs?: string;
    metrics?: string;
  } = {};
  const traces = envString('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
  const logs = envString('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
  const metrics = envString('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT');
  if (traces) endpoints.traces = traces;
  if (logs) endpoints.logs = logs;
  if (metrics) endpoints.metrics = metrics;
  return endpoints;
}
function envHeaders(): Record<string, string> {
  const text = envString('OTEL_EXPORTER_OTLP_HEADERS');
  return text ? parseCommaKeyValues(text) : {};
}
function envCompression(): 'gzip' | null {
  const value = envString('OTEL_EXPORTER_OTLP_COMPRESSION').toLowerCase();
  if (!value || value === 'none') return null;
  if (value === 'gzip') return 'gzip';
  throw new TypeError('OTEL_EXPORTER_OTLP_COMPRESSION must be "none" or "gzip"');
}
function exportIntervalMs(): number {
  const value = envString('FINO_OTEL_EXPORT_INTERVAL_MS');
  if (!value) return 1e3;
  const interval = Number(value);
  return Number.isFinite(interval) && interval >= 0 ? interval : 1e3;
}
function envResourceAttributes(): Record<string, unknown> {
  const text = envString('OTEL_RESOURCE_ATTRIBUTES');
  return text ? parseCommaKeyValues(text) : {};
}
async function loadCliResource(script: string): Promise<Resource> {
  const attributes: Record<string, unknown> = {};
  try {
    const pkgText = await fs.readFile(`${cwd()}/package.json`);
    const pkg = JSON.parse(pkgText);
    if (typeof pkg?.name === 'string' && pkg.name.trim()) attributes['service.name'] = pkg.name.trim();
    if (typeof pkg?.version === 'string' && pkg.version.trim()) attributes['service.version'] = pkg.version.trim();
  } catch {}
  Object.assign(attributes, envResourceAttributes());
  const serviceName = envString('OTEL_SERVICE_NAME');
  if (serviceName) attributes['service.name'] = serviceName;
  if (!attributes['service.name']) attributes['service.name'] = inferServiceName(script);
  return new Resource(attributes);
}
/**
* Build tracer, logger, and meter providers for an instrumented CLI script.
*
* The resource is loaded from `package.json`, `OTEL_RESOURCE_ATTRIBUTES`, and
* `OTEL_SERVICE_NAME`, then falls back to a service name inferred from `script`.
* `debug` enables verbose exporter request and response logging. The returned
* providers are started through an `OtelSDK` instance and a shutdown hook is
* registered to flush and stop it. Exporter partial-success and request
* failures are logged to stderr.
*
* ```js
* import { createCliOtelRuntime } from 'internal:opentelemetry/bootstrap';
* const runtime = await createCliOtelRuntime('http://127.0.0.1:4318', 'server.ts');
* console.log(Boolean(runtime.tracerProvider));
* ```
*
* @param endpoint OTLP/HTTP collector endpoint.
* @param script Script path or specifier used for fallback service metadata.
* @param debug Enables exporter request/response logging when true.
* @returns Providers to install around CLI script execution.
* @internal
*/
export async function createCliOtelRuntime(endpoint: string, script: string, debug = false) {
  const exporter = new OTLPHttpJsonExporter({
    endpoint,
    endpoints: envSignalEndpoints(),
    headers: envHeaders(),
    compression: envCompression(),
    onError(error) {
      console.error(`[otel] export to ${endpoint} failed: ${error.message}`);
    },
    onPartialSuccess(result) {
      const details = [
        `rejectedSpans=${result.rejectedSpans || 0}`,
        `rejectedLogs=${result.rejectedLogs || 0}`,
        `rejectedDataPoints=${result.rejectedDataPoints || 0}`
      ];
      if (result.errorMessage) details.push(`message=${result.errorMessage}`);
      console.error(`[otel] partial success from ${endpoint}: ${details.join(' ')}`);
    },
    onRequest(info) {
      if (!debug) return;
      logOtelDebug(`request ${info.signal} ${info.method} ${info.url}`, {
        headers: info.headers,
        body: info.bodyText || (info.bodyBytes ? `[${info.bodyBytes.byteLength} bytes]` : '')
      });
    },
    onResponse(info) {
      if (!debug) return;
      logOtelDebug(`response ${info.signal} ${info.status} ${info.url}`, {
        headers: info.headers,
        body: info.bodyText
      });
    }
  });
  const tracerProvider = new TracerProvider();
  const loggerProvider = new LoggerProvider();
  const meterProvider = new MeterProvider();
  const resource = await loadCliResource(script);
  const intervalMs = exportIntervalMs();
  const sdk = new OtelSDK({
    resource,
    exporters: [exporter],
    spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: intervalMs })],
    logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: intervalMs })],
    metricReaders: [new PeriodicMetricReader(exporter, { intervalMs })],
    instrumentations: [
      new TraceTopicInstrumentation(),
      new HttpServerInstrumentation(),
      new FetchInstrumentation(),
      new DnsInstrumentation(),
      new SocketInstrumentation(),
      new TlsInstrumentation(),
      new JobsInstrumentation()
    ]
  }).start();
  registerShutdownHook(async () => {
    await sdk.shutdown();
  });
  return {
    tracerProvider,
    loggerProvider,
    meterProvider
  };
}
