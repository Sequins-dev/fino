/**
 * internal:load — scheduler, metrics, and reporter for `fino:load`.
 *
 * The public module owns the user contract; this module keeps the hot path and
 * deterministic scheduler helpers internal. It uses a fixed-size logarithmic
 * histogram instead of retaining per-request observations and delegates all
 * wire behavior to `HttpClient`.
 *
 * HTTP/2 concurrency follows RFC 9113 Section 5.1.2. Headers-only disposal is
 * implemented by `HttpResponse.discard('cancel')`, which maps to RST_STREAM for
 * HTTP/2 (RFC 9113 Section 6.4) and bidirectional stream cancellation with
 * H3_REQUEST_CANCELLED for HTTP/3 (RFC 9114 Section 4.1.1).
 *
 * @internal
 */
import { HttpClient } from '../net/http/client.ts';
import type { HttpResponse } from '../net/http/client.ts';
import { Headers } from '../net/http/index.ts';
import type {
  LoadCounters,
  LoadHistogramSnapshot,
  LoadLatencySummary,
  LoadOptions,
  LoadProtocol,
  LoadResponsePolicy,
  LoadResult,
  LoadResultConfig,
} from '../load.ts';

const DEFAULT_DURATION_MS = 10_000;
const DEFAULT_CONNECTIONS = 10;
const DEFAULT_STREAMS = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BUFFER_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 10_000;
const MAX_STREAMS = 10_000;
const MAX_CONCURRENCY = 100_000;
const HISTOGRAM_BUCKETS = 4096;
const HISTOGRAM_SUB_BUCKETS = 64;
const HISTOGRAM_OFFSET = 1024;
const MAX_ERROR_CLASSES = 32;

interface NormalizedLoadOptions {
  url: URL;
  method: string;
  headers: LoadOptions['headers'];
  body: LoadOptions['body'];
  protocol: LoadProtocol;
  connections: number;
  streams: number;
  concurrency: number;
  durationMs: number | null;
  requests: number | null;
  warmupMs: number;
  responsePolicy: LoadResponsePolicy;
  expectedStatus: readonly number[] | null;
  expectedStatusSet: ReadonlySet<number> | null;
  timeouts: NonNullable<LoadOptions['timeouts']>;
  maxPendingRequests: number;
  maxBufferedResponseBytes: number;
  retryAttempts: number;
  decompress: boolean;
  redirect: NonNullable<LoadOptions['redirect']>;
  tls: LoadOptions['tls'];
  title: string | null;
  signal: AbortSignal | null;
}

interface MutableCounters {
  offered: number;
  started: number;
  completed: number;
  successful: number;
  statusFailed: number;
  timedOut: number;
  cancelled: number;
  transportFailed: number;
  schedulerDropped: number;
  headersOnly: number;
  responseBytes: number;
}

interface PhaseOptions {
  concurrency: number;
  requestLimit: number | null;
  deadline: number | null;
  signal: AbortSignal;
  operationSignal?: AbortSignal;
  now(): number;
}

interface PhaseSignal {
  signal: AbortSignal;
  deadline: number | null;
  close(): void;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`fino load: ${name} must be a finite non-negative number`);
  }
  return value;
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`fino load: ${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`fino load: ${name} must be a non-negative integer`);
  }
  return value;
}

function normalizeExpectedStatus(input: LoadOptions['expectedStatus']): {
  values: readonly number[] | null;
  set: ReadonlySet<number> | null;
} {
  if (input === undefined) return { values: null, set: null };
  const raw = typeof input === 'number' ? [input] : [...input];
  if (raw.length === 0) throw new RangeError('fino load: expectedStatus cannot be empty');
  const unique = [...new Set(raw)].sort((a, b) => a - b);
  for (const status of unique) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new RangeError('fino load: expectedStatus values must be HTTP status codes');
    }
  }
  return { values: unique, set: new Set(unique) };
}

function normalizeTimeouts(input: LoadOptions['timeouts']): NonNullable<LoadOptions['timeouts']> {
  const timeouts: NonNullable<LoadOptions['timeouts']> = {
    total: input?.total ?? DEFAULT_TIMEOUT_MS,
  };
  if (input?.connect !== undefined) timeouts.connect = input.connect;
  if (input?.headers !== undefined) timeouts.headers = input.headers;
  if (input?.bodyIdle !== undefined) timeouts.bodyIdle = input.bodyIdle;
  for (const [name, value] of Object.entries(timeouts)) {
    if (value !== undefined) finiteNonNegative(value, `timeouts.${name}`);
  }
  return timeouts;
}

function normalizeOptions(options: LoadOptions): NormalizedLoadOptions {
  const url = options.url instanceof URL ? new URL(options.url.href) : new URL(String(options.url));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('fino load: url must use http: or https:');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('fino load: url must not contain credentials');
  }
  const protocol = options.protocol ?? 'http/1.1';
  if (protocol !== 'http/1.1' && protocol !== 'h2' && protocol !== 'h3') {
    throw new TypeError('fino load: protocol must be http/1.1, h2, or h3');
  }
  if ((protocol === 'h2' || protocol === 'h3') && url.protocol !== 'https:') {
    throw new TypeError(`fino load: ${protocol.toUpperCase()} requires an https: URL`);
  }
  const method = String(options.method ?? 'GET').toUpperCase();
  if (
    options.body !== undefined &&
    typeof options.body !== 'string' &&
    !(options.body instanceof Uint8Array) &&
    !(options.body instanceof ArrayBuffer)
  ) {
    throw new TypeError('fino load: body must be a replayable string, Uint8Array, or ArrayBuffer');
  }
  if (options.body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw new TypeError(`fino load: ${method} requests cannot have a body`);
  }
  const connections = positiveInteger(
    options.connections ?? DEFAULT_CONNECTIONS,
    'connections',
    MAX_CONNECTIONS,
  );
  const streams = positiveInteger(options.streams ?? DEFAULT_STREAMS, 'streams', MAX_STREAMS);
  if (protocol === 'http/1.1' && streams !== 1) {
    throw new RangeError('fino load: HTTP/1.1 requires streams to be 1');
  }
  const concurrency = connections * streams;
  if (concurrency > MAX_CONCURRENCY) {
    throw new RangeError(`fino load: total concurrency cannot exceed ${MAX_CONCURRENCY}`);
  }
  if (options.durationMs !== undefined && options.requests !== undefined) {
    throw new RangeError('fino load: durationMs and requests are mutually exclusive');
  }
  const durationMs =
    options.requests === undefined
      ? finiteNonNegative(options.durationMs ?? DEFAULT_DURATION_MS, 'durationMs')
      : null;
  if (durationMs === 0) throw new RangeError('fino load: durationMs must be greater than zero');
  const requests =
    options.requests === undefined
      ? null
      : positiveInteger(options.requests, 'requests', Number.MAX_SAFE_INTEGER);
  const warmupMs = finiteNonNegative(options.warmupMs ?? 0, 'warmupMs');
  const expected = normalizeExpectedStatus(options.expectedStatus);
  const maxPendingRequests =
    options.maxPendingRequests === undefined
      ? concurrency
      : nonNegativeInteger(options.maxPendingRequests, 'maxPendingRequests');
  const maxBufferedResponseBytes = positiveInteger(
    options.maxBufferedResponseBytes ?? DEFAULT_BUFFER_BYTES,
    'maxBufferedResponseBytes',
  );
  const retryAttempts = positiveInteger(options.retryAttempts ?? 1, 'retryAttempts');
  const responsePolicy = options.responsePolicy ?? 'consume';
  if (responsePolicy !== 'consume' && responsePolicy !== 'cancel') {
    throw new TypeError('fino load: responsePolicy must be consume or cancel');
  }
  const redirect = options.redirect ?? 'follow';
  if (redirect !== 'follow' && redirect !== 'error' && redirect !== 'manual') {
    throw new TypeError('fino load: redirect must be follow, error, or manual');
  }
  return {
    url,
    method,
    headers: options.headers,
    body: options.body,
    protocol,
    connections,
    streams,
    concurrency,
    durationMs,
    requests,
    warmupMs,
    responsePolicy,
    expectedStatus: expected.values,
    expectedStatusSet: expected.set,
    timeouts: normalizeTimeouts(options.timeouts),
    maxPendingRequests,
    maxBufferedResponseBytes,
    retryAttempts,
    decompress: options.decompress !== false,
    redirect,
    tls: options.tls,
    title: options.title === undefined ? null : String(options.title),
    signal: options.signal ?? null,
  };
}

/** Fixed-memory logarithmic latency histogram used by the load recorder. @internal */
export class LoadLogHistogram {
  readonly #buckets = new Float64Array(HISTOGRAM_BUCKETS);
  #zeroCount = 0;
  #count = 0;
  #min = Infinity;
  #max = -Infinity;
  #sum = 0;
  #sumSquares = 0;

  /** Record one non-negative millisecond observation. @internal */
  record(value: number): void {
    if (!Number.isFinite(value)) return;
    const safe = Math.max(0, value);
    this.#count++;
    this.#min = Math.min(this.#min, safe);
    this.#max = Math.max(this.#max, safe);
    this.#sum += safe;
    this.#sumSquares += safe * safe;
    if (safe === 0) {
      this.#zeroCount++;
      return;
    }
    const micros = safe * 1000;
    const raw = Math.floor(Math.log2(micros) * HISTOGRAM_SUB_BUCKETS) + HISTOGRAM_OFFSET;
    const index = Math.max(0, Math.min(HISTOGRAM_BUCKETS - 1, raw));
    this.#buckets[index]!++;
  }

  #quantile(q: number): number | null {
    if (this.#count === 0) return null;
    if (q <= 0) return this.#min;
    if (q >= 1) return this.#max;
    const rank = Math.max(1, Math.ceil(this.#count * q));
    if (rank <= this.#zeroCount) return 0;
    let seen = this.#zeroCount;
    for (let index = 0; index < this.#buckets.length; index++) {
      seen += this.#buckets[index]!;
      if (seen >= rank) {
        const estimate = 2 ** ((index - HISTOGRAM_OFFSET + 0.5) / HISTOGRAM_SUB_BUCKETS) / 1000;
        return Math.max(this.#min, Math.min(this.#max, estimate));
      }
    }
    return this.#max;
  }

  /** Return the JSON-safe summary without exposing bucket storage. @internal */
  snapshot(): LoadHistogramSnapshot {
    if (this.#count === 0) {
      return {
        count: 0,
        min: null,
        mean: null,
        stddev: null,
        p50: null,
        p75: null,
        p90: null,
        p95: null,
        p99: null,
        p999: null,
        max: null,
      };
    }
    const mean = this.#sum / this.#count;
    const variance = Math.max(0, this.#sumSquares / this.#count - mean * mean);
    return {
      count: this.#count,
      min: this.#min,
      mean,
      stddev: Math.sqrt(variance),
      p50: this.#quantile(0.5),
      p75: this.#quantile(0.75),
      p90: this.#quantile(0.9),
      p95: this.#quantile(0.95),
      p99: this.#quantile(0.99),
      p999: this.#quantile(0.999),
      max: this.#max,
    };
  }
}

class LoadRecorder {
  readonly #knownConnectionIds = new Map<string, true>();
  readonly #knownConnectionLimit: number;
  readonly counters: MutableCounters = {
    offered: 0,
    started: 0,
    completed: 0,
    successful: 0,
    statusFailed: 0,
    timedOut: 0,
    cancelled: 0,
    transportFailed: 0,
    schedulerDropped: 0,
    headersOnly: 0,
    responseBytes: 0,
  };
  readonly statusCodes = new Map<string, number>();
  readonly protocols = new Map<string, number>();
  readonly errors = new Map<string, number>();
  uniqueConnections = 0;
  reusedResponses = 0;
  active = 0;
  maxActive = 0;
  readonly queue = new LoadLogHistogram();
  readonly ttfb = new LoadLogHistogram();
  readonly download = new LoadLogHistogram();
  readonly total = new LoadLogHistogram();
  readonly connect = new LoadLogHistogram();
  readonly tls = new LoadLogHistogram();

  constructor(connections: number) {
    this.#knownConnectionLimit = Math.max(1, connections * 2);
  }

  #observeConnection(id: string): boolean {
    if (this.#knownConnectionIds.has(id)) {
      this.#knownConnectionIds.delete(id);
      this.#knownConnectionIds.set(id, true);
      return false;
    }
    this.#knownConnectionIds.set(id, true);
    if (this.#knownConnectionIds.size > this.#knownConnectionLimit) {
      const oldest = this.#knownConnectionIds.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#knownConnectionIds.delete(oldest);
    }
    return true;
  }

  begin(): void {
    this.counters.offered++;
    this.counters.started++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
  }

  end(): void {
    this.active--;
  }

  increment(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  recordHeaders(response: HttpResponse): void {
    this.increment(this.statusCodes, String(response.status));
    this.increment(this.protocols, response.protocol);
    if (response.connection !== null) {
      if (this.#observeConnection(response.connection.id)) this.uniqueConnections++;
      if (response.connection.reused) this.reusedResponses++;
    }
    const timing = response.timing;
    this.queue.record(timing.queueEnd - timing.scheduledTime);
    if (timing.responseHeadersEnd !== undefined) {
      this.ttfb.record(timing.responseHeadersEnd - timing.scheduledTime);
    }
    const connectStart = timing.dnsStart ?? timing.connectStart;
    if (connectStart !== null && timing.connectEnd !== null) {
      this.connect.record(timing.connectEnd - connectStart);
    }
    if (timing.secureConnectStart !== null && timing.secureConnectEnd !== null) {
      this.tls.record(timing.secureConnectEnd - timing.secureConnectStart);
    }
  }

  recordFinished(response: HttpResponse, finishedAt: number): void {
    const headersAt = response.timing.responseHeadersEnd;
    if (headersAt !== undefined) this.download.record(finishedAt - headersAt);
    this.total.record(finishedAt - response.timing.scheduledTime);
  }

  recordError(error: unknown, phaseSignal: AbortSignal): void {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) this.counters.timedOut++;
    else if (phaseSignal.aborted) this.counters.cancelled++;
    else this.counters.transportFailed++;
    const rawName = error instanceof Error && error.name !== '' ? error.name : 'Error';
    const name =
      this.errors.has(rawName) || this.errors.size < MAX_ERROR_CLASSES ? rawName : 'Other';
    this.increment(this.errors, name);
  }

  latency(): LoadLatencySummary {
    return {
      queue: this.queue.snapshot(),
      ttfb: this.ttfb.snapshot(),
      download: this.download.snapshot(),
      total: this.total.snapshot(),
      connect: this.connect.snapshot(),
      tls: this.tls.snapshot(),
    };
  }
}

function phaseSignal(parent: AbortSignal | null, durationMs: number | null): PhaseSignal {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const deadline = durationMs === null ? null : performance.now() + durationMs;
  const timer =
    durationMs === null
      ? null
      : setTimeout(
          () => controller.abort(new Error('fino load: measured phase ended')),
          Math.max(0, durationMs),
        );
  return {
    signal: controller.signal,
    deadline,
    close() {
      if (timer !== null) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

/**
 * Run fixed workers until a shared request count or monotonic deadline is met.
 *
 * The synchronous claim before each await makes request-count distribution
 * deterministic in one JS realm. Exported only for fake-clock scheduler tests.
 * @internal
 */
export async function runClosedLoopPhase(
  options: PhaseOptions,
  operation: (signal: AbortSignal) => Promise<void>,
): Promise<number> {
  let claimed = 0;
  const worker = async () => {
    while (!options.signal.aborted) {
      if (options.deadline !== null && options.now() >= options.deadline) return;
      if (options.requestLimit !== null && claimed >= options.requestLimit) return;
      claimed++;
      await operation(options.operationSignal ?? options.signal);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  return claimed;
}

function statusMatches(status: number, expected: ReadonlySet<number> | null): boolean {
  return expected === null ? status >= 200 && status < 400 : expected.has(status);
}

async function performOperation(
  client: HttpClient,
  options: NormalizedLoadOptions,
  signal: AbortSignal,
  recorder: LoadRecorder | null,
): Promise<void> {
  recorder?.begin();
  let response: HttpResponse | null = null;
  try {
    response = await client.request(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal,
      timeouts: options.timeouts,
      retry: { attempts: options.retryAttempts },
      decompress: options.decompress,
      redirect: options.redirect,
    });
    recorder?.recordHeaders(response);
    const bytes = await response.discard(options.responsePolicy);
    if (recorder !== null) {
      recorder.counters.completed++;
      recorder.counters.responseBytes += bytes;
      if (options.responsePolicy === 'cancel') recorder.counters.headersOnly++;
      if (statusMatches(response.status, options.expectedStatusSet)) recorder.counters.successful++;
      else recorder.counters.statusFailed++;
      recorder.recordFinished(response, response.timing.bodyEnd ?? performance.now());
    }
  } catch (error) {
    if (recorder !== null) {
      recorder.recordError(error, signal);
      if (response !== null) recorder.recordFinished(response, performance.now());
    }
  } finally {
    recorder?.end();
  }
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function resultConfig(options: NormalizedLoadOptions): LoadResultConfig {
  const headerNames: string[] = [];
  for (const [name] of new Headers(options.headers)) {
    if (name !== undefined) headerNames.push(name);
  }
  headerNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const requestBodyBytes =
    options.body === undefined
      ? 0
      : typeof options.body === 'string'
        ? new TextEncoder().encode(options.body).byteLength
        : options.body.byteLength;
  return {
    url: options.url.href,
    method: options.method,
    headerNames,
    requestBodyBytes,
    protocol: options.protocol,
    connections: options.connections,
    streams: options.streams,
    concurrency: options.concurrency,
    durationMs: options.durationMs,
    requests: options.requests,
    warmupMs: options.warmupMs,
    responsePolicy: options.responsePolicy,
    expectedStatus: options.expectedStatus,
    decompress: options.decompress,
    maxBufferedResponseBytes: options.maxBufferedResponseBytes,
    maxPendingRequests: options.maxPendingRequests,
    retryAttempts: options.retryAttempts,
    redirect: options.redirect,
    tls: {
      rejectUnauthorized: options.tls?.rejectUnauthorized !== false,
      customCa: options.tls?.ca !== undefined,
      clientCertificate: options.tls?.cert !== undefined && options.tls?.key !== undefined,
    },
    timeouts: options.timeouts,
  };
}

/** Execute the public load contract through `HttpClient`. @internal */
export async function runLoadEngine(rawOptions: LoadOptions): Promise<LoadResult> {
  const options = normalizeOptions(rawOptions);
  const client = new HttpClient({
    protocols: [options.protocol],
    connections: options.connections,
    maxConcurrentStreams: options.streams,
    maxPendingRequests: options.maxPendingRequests,
    maxBufferedResponseBytes: options.maxBufferedResponseBytes,
    timeouts: options.timeouts,
    retry: { attempts: options.retryAttempts },
    decompress: options.decompress,
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
  });
  try {
    if (options.warmupMs > 0 && !options.signal?.aborted) {
      const warmupSchedule = phaseSignal(options.signal, options.warmupMs);
      const warmupOperations = phaseSignal(options.signal, null);
      try {
        await runClosedLoopPhase(
          {
            concurrency: options.concurrency,
            requestLimit: null,
            deadline: warmupSchedule.deadline,
            signal: warmupSchedule.signal,
            operationSignal: warmupOperations.signal,
            now: () => performance.now(),
          },
          (signal) => performOperation(client, options, signal, null),
        );
      } finally {
        warmupSchedule.close();
        warmupOperations.close();
      }
    }

    const recorder = new LoadRecorder(options.connections);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const measured = phaseSignal(options.signal, options.durationMs);
    try {
      await runClosedLoopPhase(
        {
          concurrency: options.concurrency,
          requestLimit: options.requests,
          deadline: measured.deadline,
          signal: measured.signal,
          now: () => performance.now(),
        },
        (signal) => performOperation(client, options, signal, recorder),
      );
    } finally {
      measured.close();
    }
    const durationMs = Math.max(0, performance.now() - start);
    const seconds = durationMs / 1000;
    const counters: LoadCounters = { ...recorder.counters };
    return {
      schemaVersion: 1,
      title: options.title,
      startedAt,
      durationMs,
      config: resultConfig(options),
      counters,
      requestsPerSecond: seconds === 0 ? 0 : counters.completed / seconds,
      bytesPerSecond: seconds === 0 ? 0 : counters.responseBytes / seconds,
      statusCodes: sortedRecord(recorder.statusCodes),
      protocols: sortedRecord(recorder.protocols),
      errors: sortedRecord(recorder.errors),
      connections: {
        unique: recorder.uniqueConnections,
        reusedResponses: recorder.reusedResponses,
        reconnects: Math.max(0, recorder.uniqueConnections - options.connections),
        maxActiveOperations: recorder.maxActive,
      },
      latency: recorder.latency(),
    };
  } finally {
    await client.close();
  }
}

function decimal(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0.00';
}

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${decimal(scaled)} ${units[unit]}`;
}

function latencyLine(name: string, histogram: LoadHistogramSnapshot): string {
  if (histogram.count === 0) return `${name.padEnd(10)} no observations`;
  return [
    `${name.padEnd(10)} min ${decimal(histogram.min!)} ms  avg ${decimal(histogram.mean!)} ms  stdev ${decimal(histogram.stddev!)} ms  max ${decimal(histogram.max!)} ms`,
    `${''.padEnd(10)} p50 ${decimal(histogram.p50!)} ms  p75 ${decimal(histogram.p75!)} ms  p90 ${decimal(histogram.p90!)} ms  p95 ${decimal(histogram.p95!)} ms  p99 ${decimal(histogram.p99!)} ms  p99.9 ${decimal(histogram.p999!)} ms`,
  ].join('\n');
}

function distribution(name: string, values: Readonly<Record<string, number>>): string {
  const entries = Object.entries(values);
  return `${name}: ${entries.length === 0 ? 'none' : entries.map(([key, value]) => `${key}=${value}`).join(' ')}`;
}

/** Render the public result as stable plain text. @internal */
export function formatLoadResultText(result: LoadResult): string {
  const lines: string[] = [];
  if (result.title !== null) lines.push(result.title);
  lines.push(`fino load ${result.config.method} ${result.config.url}`);
  lines.push(
    `${result.config.protocol}, ${result.config.connections} connections x ${result.config.streams} streams = ${result.config.concurrency} concurrency, response=${result.config.responsePolicy}`,
  );
  lines.push(
    `${decimal(result.durationMs / 1000)} s measured, ${decimal(result.requestsPerSecond)} completed req/s, ${bytes(result.bytesPerSecond)}/s`,
  );
  lines.push(
    `Requests: offered=${result.counters.offered} started=${result.counters.started} completed=${result.counters.completed} successful=${result.counters.successful}`,
  );
  lines.push(
    `Failures: status=${result.counters.statusFailed} timeout=${result.counters.timedOut} cancelled=${result.counters.cancelled} transport=${result.counters.transportFailed} dropped=${result.counters.schedulerDropped}`,
  );
  lines.push(
    `Responses: bytes=${bytes(result.counters.responseBytes)} headers-only=${result.counters.headersOnly}`,
  );
  lines.push(
    `Connections: unique=${result.connections.unique} reused-responses=${result.connections.reusedResponses} reconnects=${result.connections.reconnects} max-active=${result.connections.maxActiveOperations}`,
  );
  lines.push(distribution('Status', result.statusCodes));
  lines.push(distribution('Protocols', result.protocols));
  lines.push(distribution('Errors', result.errors));
  lines.push('Latency:');
  lines.push(latencyLine('queue', result.latency.queue));
  lines.push(latencyLine('ttfb', result.latency.ttfb));
  lines.push(latencyLine('download', result.latency.download));
  lines.push(latencyLine('total', result.latency.total));
  if (result.latency.connect.count > 0) lines.push(latencyLine('connect', result.latency.connect));
  if (result.latency.tls.count > 0) lines.push(latencyLine('tls', result.latency.tls));
  return lines.join('\n') + '\n';
}
