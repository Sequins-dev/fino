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
import { QuicEndpoint } from '../net/quic/index.ts';
import { LogHistogram } from './statistics.ts';
import type {
  LoadBailoutOptions,
  LoadCounters,
  LoadHistogramSnapshot,
  LoadLatencySummary,
  LoadOptions,
  LoadProtocol,
  LoadRate,
  LoadResponsePolicy,
  LoadResult,
  LoadResultConfig,
  LoadScenario,
  LoadScenarioClient,
  LoadScenarioContext,
  LoadScenarioMetricResult,
  LoadScenarioOptions,
  LoadScenarioResult,
} from '../load.ts';

const DEFAULT_DURATION_MS = 10_000;
const DEFAULT_CONNECTIONS = 10;
const DEFAULT_STREAMS = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BUFFER_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 10_000;
const MAX_STREAMS = 10_000;
const MAX_CONCURRENCY = 100_000;
const MAX_ERROR_CLASSES = 32;
const MAX_EXPECTED_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_SCENARIO_METRICS = 64;
const MAX_SCENARIO_METRICS = 1024;
const DEFAULT_MAX_SCENARIO_LOGS = 1000;

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
  rate: LoadRate | null;
  maxQueuedOperations: number;
  reconnectAfter: number | null;
  responsePolicy: LoadResponsePolicy;
  expectedStatus: readonly number[] | null;
  expectedStatusSet: ReadonlySet<number> | null;
  expectedBody: Uint8Array | null;
  timeouts: NonNullable<LoadOptions['timeouts']>;
  maxPendingRequests: number;
  maxBufferedResponseBytes: number;
  retryAttempts: number;
  decompress: boolean;
  redirect: NonNullable<LoadOptions['redirect']>;
  tls: LoadOptions['tls'];
  title: string | null;
  signal: AbortSignal | null;
  bailout: LoadBailoutOptions | null;
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
  bodyFailed: number;
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

interface ArrivalPhaseOptions extends PhaseOptions {
  maxQueued: number;
  rateAt(scheduledAt: number, sequence: number): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
  offer(): void;
  drop(): void;
  finish?(): void;
}

interface PhaseSignal {
  signal: AbortSignal;
  deadline: number | null;
  abort(reason?: unknown): void;
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

function normalizeExpectedBody(input: string | Uint8Array | undefined): Uint8Array | null {
  if (input === undefined) return null;
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength > MAX_EXPECTED_BODY_BYTES) {
    throw new RangeError(
      `fino load: expectedBody cannot exceed ${MAX_EXPECTED_BODY_BYTES} encoded bytes`,
    );
  }
  return new Uint8Array(bytes);
}

function normalizeRate(input: LoadRate | undefined): LoadRate | null {
  if (input === undefined) return null;
  if (typeof input === 'number') {
    const rate = finiteNonNegative(input, 'rate');
    if (rate === 0) throw new RangeError('fino load: rate must be greater than zero');
    return rate;
  }
  const start = finiteNonNegative(input.start, 'rate.start');
  const end = finiteNonNegative(input.end, 'rate.end');
  if (start === 0 || end === 0)
    throw new RangeError('fino load: ramp rates must be greater than zero');
  return { start, end };
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
  const expectedBody = normalizeExpectedBody(options.expectedBody);
  const rate = normalizeRate(options.rate);
  const maxQueuedOperations =
    options.maxQueuedOperations === undefined
      ? concurrency
      : nonNegativeInteger(options.maxQueuedOperations, 'maxQueuedOperations');
  const reconnectAfter =
    options.reconnectAfter === undefined
      ? null
      : positiveInteger(options.reconnectAfter, 'reconnectAfter');
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
  if (responsePolicy === 'cancel' && expectedBody !== null) {
    throw new RangeError('fino load: expectedBody requires responsePolicy consume');
  }
  const bailout = options.bailout ?? null;
  if (bailout?.failures !== undefined) positiveInteger(bailout.failures, 'bailout.failures');
  if (bailout?.errors !== undefined) positiveInteger(bailout.errors, 'bailout.errors');
  if (bailout !== null && bailout.failures === undefined && bailout.errors === undefined) {
    throw new RangeError('fino load: bailout requires a failures or errors threshold');
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
    rate,
    maxQueuedOperations,
    reconnectAfter,
    responsePolicy,
    expectedStatus: expected.values,
    expectedStatusSet: expected.set,
    expectedBody,
    timeouts: normalizeTimeouts(options.timeouts),
    maxPendingRequests,
    maxBufferedResponseBytes,
    retryAttempts,
    decompress: options.decompress !== false,
    redirect,
    tls: options.tls,
    title: options.title === undefined ? null : String(options.title),
    signal: options.signal ?? null,
    bailout,
  };
}

function loadHistogramSnapshot(histogram: LogHistogram): LoadHistogramSnapshot {
  return {
    count: histogram.count,
    min: histogram.min,
    mean: histogram.mean,
    stddev: histogram.stddev,
    p50: histogram.quantile(0.5),
    p75: histogram.quantile(0.75),
    p90: histogram.quantile(0.9),
    p95: histogram.quantile(0.95),
    p99: histogram.quantile(0.99),
    p999: histogram.quantile(0.999),
    max: histogram.max,
  };
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
    bodyFailed: 0,
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
  bailoutReason: string | null = null;
  expectationFailures = 0;
  readonly queue = new LogHistogram();
  readonly ttfb = new LogHistogram();
  readonly download = new LogHistogram();
  readonly total = new LogHistogram();
  readonly connect = new LogHistogram();
  readonly tls = new LogHistogram();

  readonly #bailout: LoadBailoutOptions | null;
  readonly #abort: (reason: Error) => void;

  constructor(
    connections: number,
    bailout: LoadBailoutOptions | null = null,
    abort: (reason: Error) => void = () => {},
  ) {
    this.#knownConnectionLimit = Math.max(1, connections * 2);
    this.#bailout = bailout;
    this.#abort = abort;
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

  offer(): void {
    this.counters.offered++;
  }

  drop(): void {
    this.counters.schedulerDropped++;
  }

  begin(): void {
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

  recordHeaders(response: HttpResponse, scheduledAt: number): void {
    this.increment(this.statusCodes, String(response.status));
    this.increment(this.protocols, response.protocol);
    if (response.connection !== null) {
      if (this.#observeConnection(response.connection.id)) this.uniqueConnections++;
      if (response.connection.reused) this.reusedResponses++;
    }
    const timing = response.timing;
    this.queue.record(timing.queueEnd - scheduledAt);
    if (timing.responseHeadersEnd !== undefined) {
      this.ttfb.record(timing.responseHeadersEnd - scheduledAt);
    }
    const connectStart = timing.dnsStart ?? timing.connectStart;
    if (connectStart !== null && timing.connectEnd !== null) {
      this.connect.record(timing.connectEnd - connectStart);
    }
    if (timing.secureConnectStart !== null && timing.secureConnectEnd !== null) {
      this.tls.record(timing.secureConnectEnd - timing.secureConnectStart);
    }
  }

  recordFinished(response: HttpResponse, finishedAt: number, scheduledAt: number): void {
    const headersAt = response.timing.responseHeadersEnd;
    if (headersAt !== undefined) this.download.record(finishedAt - headersAt);
    this.total.record(finishedAt - scheduledAt);
  }

  checkBailout(): void {
    if (this.bailoutReason !== null || this.#bailout === null) return;
    const failures = this.expectationFailures;
    const errors = this.counters.timedOut + this.counters.transportFailed;
    let reason: string | null = null;
    if (this.#bailout.failures !== undefined && failures >= this.#bailout.failures) {
      reason = `failure threshold ${this.#bailout.failures} reached`;
    } else if (this.#bailout.errors !== undefined && errors >= this.#bailout.errors) {
      reason = `error threshold ${this.#bailout.errors} reached`;
    }
    if (reason !== null) {
      this.bailoutReason = reason;
      this.#abort(new Error(`fino load: ${reason}`));
    }
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
    this.checkBailout();
  }

  latency(): LoadLatencySummary {
    return {
      queue: loadHistogramSnapshot(this.queue),
      ttfb: loadHistogramSnapshot(this.ttfb),
      download: loadHistogramSnapshot(this.download),
      total: loadHistogramSnapshot(this.total),
      connect: loadHistogramSnapshot(this.connect),
      tls: loadHistogramSnapshot(this.tls),
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
    abort(reason?: unknown) {
      controller.abort(reason);
    },
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
  operation: (
    signal: AbortSignal,
    scheduledAt: number,
    sequence: number,
    workerId: number,
  ) => Promise<void>,
): Promise<number> {
  let claimed = 0;
  const worker = async (workerId: number) => {
    while (!options.signal.aborted) {
      if (options.deadline !== null && options.now() >= options.deadline) return;
      if (options.requestLimit !== null && claimed >= options.requestLimit) return;
      const sequence = claimed++;
      await operation(options.operationSignal ?? options.signal, options.now(), sequence, workerId);
    }
  };
  const workers: Promise<void>[] = [];
  for (let workerId = 0; workerId < options.concurrency; workerId++) {
    workers.push(worker(workerId));
  }
  await Promise.all(workers);
  return claimed;
}

interface ArrivalSleeper {
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
  close(): void;
}

function createArrivalSleeper(): ArrivalSleeper {
  interface Waiter {
    deadline: number;
    signal: AbortSignal;
    resolve(): void;
    abort(): void;
  }
  const waiters = new Set<Waiter>();
  const settle = (waiter: Waiter) => {
    if (!waiters.delete(waiter)) return;
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  };
  const interval = setInterval(() => {
    const now = performance.now();
    for (const waiter of waiters) {
      if (waiter.signal.aborted || now >= waiter.deadline) settle(waiter);
    }
  }, 1);
  return {
    sleep(delayMs, signal) {
      if (delayMs <= 0 || signal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const waiter: Waiter = {
          deadline: performance.now() + delayMs,
          signal,
          resolve,
          abort() {
            settle(waiter);
          },
        };
        waiters.add(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
      });
    },
    close() {
      clearInterval(interval);
      for (const waiter of [...waiters]) settle(waiter);
    },
  };
}

/**
 * Schedule bounded open-loop arrivals at intended monotonic timestamps.
 *
 * Workers consume a bounded FIFO. `operation` receives the original arrival
 * time even after queueing so callers include scheduler delay in latency.
 * Exported only for deterministic scheduler tests.
 * @internal
 */
export async function runArrivalPhase(
  options: ArrivalPhaseOptions,
  operation: (
    signal: AbortSignal,
    scheduledAt: number,
    sequence: number,
    workerId: number,
  ) => Promise<void>,
): Promise<number> {
  interface Arrival {
    scheduledAt: number;
    sequence: number;
  }
  const queue: Array<Arrival | undefined> = new Array(options.maxQueued);
  let queueHead = 0;
  let queueLength = 0;
  const waiting: Array<(arrival: Arrival | null) => void> = [];
  let done = false;
  const take = (): Promise<Arrival | null> => {
    if (queueLength > 0) {
      const arrival = queue[queueHead]!;
      queue[queueHead] = undefined;
      queueHead = (queueHead + 1) % options.maxQueued;
      queueLength--;
      return Promise.resolve(arrival);
    }
    if (done) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };
  const offer = (arrival: Arrival): boolean => {
    const resolve = waiting.shift();
    if (resolve !== undefined) {
      resolve(arrival);
      return true;
    }
    if (queueLength >= options.maxQueued) return false;
    queue[(queueHead + queueLength) % options.maxQueued] = arrival;
    queueLength++;
    return true;
  };
  const workers: Promise<void>[] = [];
  for (let workerId = 0; workerId < options.concurrency; workerId++) {
    workers.push(
      (async () => {
        for (;;) {
          const arrival = await take();
          if (arrival === null) return;
          await operation(
            options.operationSignal ?? options.signal,
            arrival.scheduledAt,
            arrival.sequence,
            workerId,
          );
        }
      })(),
    );
  }
  let offered = 0;
  let scheduledAt = options.now();
  try {
    while (!options.signal.aborted) {
      if (options.requestLimit !== null && offered >= options.requestLimit) break;
      if (options.deadline !== null && scheduledAt >= options.deadline) break;
      await options.sleep(Math.max(0, scheduledAt - options.now()), options.signal);
      if (options.signal.aborted) break;
      if (options.deadline !== null && options.now() >= options.deadline) break;
      const sequence = offered++;
      options.offer();
      if (!offer({ scheduledAt, sequence })) options.drop();
      scheduledAt += 1000 / options.rateAt(scheduledAt, sequence);
    }
    if (
      options.requestLimit === null &&
      options.deadline !== null &&
      !options.signal.aborted &&
      options.now() < options.deadline
    ) {
      await options.sleep(options.deadline - options.now(), options.signal);
    }
    options.finish?.();
  } finally {
    if (options.signal.aborted) {
      while (queueLength > 0) {
        queue[queueHead] = undefined;
        queueHead = (queueHead + 1) % options.maxQueued;
        queueLength--;
        options.drop();
      }
    }
    done = true;
    for (const resolve of waiting.splice(0)) resolve(null);
    await Promise.all(workers);
  }
  return offered;
}

function statusMatches(status: number, expected: ReadonlySet<number> | null): boolean {
  return expected === null ? status >= 200 && status < 400 : expected.has(status);
}

function rateAt(
  rate: LoadRate,
  durationMs: number | null,
  requestLimit: number | null,
  phaseStart: number,
  scheduledAt: number,
  sequence: number,
): number {
  if (typeof rate === 'number') return rate;
  const progress =
    requestLimit !== null
      ? requestLimit <= 1
        ? 1
        : Math.min(1, sequence / (requestLimit - 1))
      : durationMs === null || durationMs === 0
        ? 0
        : Math.min(1, Math.max(0, (scheduledAt - phaseStart) / durationMs));
  return rate.start + (rate.end - rate.start) * progress;
}

async function consumeResponse(
  response: HttpResponse,
  expected: Uint8Array | null,
): Promise<{ bytes: number; matched: boolean }> {
  let bytes = 0;
  let matched = true;
  if (response.body !== null) {
    for await (const chunk of response.body) {
      if (expected !== null && matched) {
        for (let index = 0; index < chunk.byteLength; index++) {
          if (bytes + index >= expected.byteLength || chunk[index] !== expected[bytes + index]) {
            matched = false;
          }
        }
      }
      bytes += chunk.byteLength;
    }
  }
  if (expected !== null && bytes !== expected.byteLength) matched = false;
  return { bytes, matched };
}

async function performOperation(
  client: HttpClient,
  options: NormalizedLoadOptions,
  signal: AbortSignal,
  recorder: LoadRecorder | null,
  scheduledAt: number,
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
    recorder?.recordHeaders(response, scheduledAt);
    const consumed =
      options.responsePolicy === 'cancel'
        ? (await response.discard('cancel'), { bytes: 0, matched: true })
        : await consumeResponse(response, options.expectedBody);
    if (recorder !== null) {
      recorder.counters.completed++;
      recorder.counters.responseBytes += consumed.bytes;
      if (options.responsePolicy === 'cancel') recorder.counters.headersOnly++;
      const statusOk = statusMatches(response.status, options.expectedStatusSet);
      if (!statusOk) recorder.counters.statusFailed++;
      if (!consumed.matched) recorder.counters.bodyFailed++;
      if (statusOk && consumed.matched) recorder.counters.successful++;
      else recorder.expectationFailures++;
      recorder.recordFinished(response, response.timing.bodyEnd ?? performance.now(), scheduledAt);
      recorder.checkBailout();
    }
  } catch (error) {
    if (recorder !== null) {
      recorder.recordError(error, signal);
      if (response !== null) recorder.recordFinished(response, performance.now(), scheduledAt);
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
    rate: options.rate,
    maxQueuedOperations: options.maxQueuedOperations,
    reconnectAfter: options.reconnectAfter,
    durationMs: options.durationMs,
    requests: options.requests,
    warmupMs: options.warmupMs,
    responsePolicy: options.responsePolicy,
    expectedStatus: options.expectedStatus,
    expectedBody: options.expectedBody !== null,
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
  const runController = new AbortController();
  const abortFromParent = () => runController.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener('abort', abortFromParent, { once: true });
  let reconnectGate = Promise.resolve();
  const maybeReconnect = async (sequence: number): Promise<void> => {
    if (
      options.reconnectAfter === null ||
      sequence === 0 ||
      sequence % options.reconnectAfter !== 0
    ) {
      return;
    }
    const pending = reconnectGate.then(() => client.closeIdleSessions());
    reconnectGate = pending.catch(() => {});
    await pending;
  };
  const runPhase = async (
    durationMs: number | null,
    requestLimit: number | null,
    recorder: LoadRecorder | null,
    parent: AbortSignal,
  ): Promise<void> => {
    const timerOwnsDeadline = options.rate === null || durationMs === null;
    const phase = phaseSignal(parent, timerOwnsDeadline ? durationMs : null);
    const operations = durationMs === null ? phase : phaseSignal(parent, null);
    const start = performance.now();
    const deadline = phase.deadline ?? (durationMs === null ? null : start + durationMs);
    const operation = async (signal: AbortSignal, scheduledAt: number, sequence: number) => {
      await maybeReconnect(sequence);
      await performOperation(client, options, signal, recorder, scheduledAt);
    };
    try {
      if (options.rate === null) {
        await runClosedLoopPhase(
          {
            concurrency: options.concurrency,
            requestLimit,
            deadline,
            signal: phase.signal,
            operationSignal: operations.signal,
            now: () => performance.now(),
          },
          async (signal, scheduledAt, sequence) => {
            recorder?.offer();
            await operation(signal, scheduledAt, sequence);
          },
        );
      } else {
        const sleeper = createArrivalSleeper();
        try {
          await runArrivalPhase(
            {
              concurrency: options.concurrency,
              maxQueued: options.maxQueuedOperations,
              requestLimit,
              deadline,
              signal: phase.signal,
              operationSignal: operations.signal,
              now: () => performance.now(),
              sleep: sleeper.sleep,
              rateAt: (scheduledAt, sequence) =>
                rateAt(options.rate!, durationMs, requestLimit, start, scheduledAt, sequence),
              offer: () => recorder?.offer(),
              drop: () => recorder?.drop(),
            },
            operation,
          );
        } finally {
          sleeper.close();
        }
      }
    } finally {
      phase.close();
      if (operations !== phase) operations.close();
    }
  };
  try {
    if (options.warmupMs > 0 && !runController.signal.aborted) {
      await runPhase(options.warmupMs, null, null, runController.signal);
    }

    const recorder = new LoadRecorder(options.connections, options.bailout, (reason) => {
      runController.abort(reason);
    });
    const startedAt = new Date().toISOString();
    const start = performance.now();
    await runPhase(options.durationMs, options.requests, recorder, runController.signal);
    const durationMs = Math.max(0, performance.now() - start);
    const seconds = durationMs / 1000;
    const counters: LoadCounters = { ...recorder.counters };
    return {
      schemaVersion: 2,
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
      bailout: recorder.bailoutReason,
    };
  } finally {
    options.signal?.removeEventListener('abort', abortFromParent);
    await reconnectGate;
    await client.close();
  }
}

interface NormalizedScenarioOptions {
  users: number;
  durationMs: number | null;
  sessions: number | null;
  rate: LoadRate | null;
  maxQueuedSessions: number;
  maxMetrics: number;
  maxLogs: number;
  signal: AbortSignal | null;
}

function normalizeScenarioOptions(
  scenario: LoadScenario,
  overrides: LoadScenarioOptions,
): NormalizedScenarioOptions {
  if (typeof scenario !== 'object' || scenario === null || typeof scenario.session !== 'function') {
    throw new TypeError('fino load: scenario must provide a session() function');
  }
  if (!['http', 'sse', 'websocket', 'webtransport', 'quic'].includes(scenario.protocol)) {
    throw new TypeError('fino load: scenario protocol is not supported');
  }
  const input = { ...scenario.options, ...overrides };
  if (input.durationMs !== undefined && input.sessions !== undefined) {
    throw new RangeError('fino load: scenario durationMs and sessions are mutually exclusive');
  }
  const durationMs =
    input.sessions === undefined
      ? finiteNonNegative(input.durationMs ?? DEFAULT_DURATION_MS, 'scenario durationMs')
      : null;
  if (durationMs === 0)
    throw new RangeError('fino load: scenario durationMs must be greater than zero');
  const sessions =
    input.sessions === undefined ? null : positiveInteger(input.sessions, 'scenario sessions');
  const users = positiveInteger(input.users ?? 1, 'scenario users', MAX_CONCURRENCY);
  const maxQueuedSessions =
    input.maxQueuedSessions === undefined
      ? users
      : nonNegativeInteger(input.maxQueuedSessions, 'scenario maxQueuedSessions');
  return {
    users,
    durationMs,
    sessions,
    rate: normalizeRate(input.rate),
    maxQueuedSessions,
    maxMetrics: positiveInteger(
      input.maxMetrics ?? DEFAULT_MAX_SCENARIO_METRICS,
      'scenario maxMetrics',
      MAX_SCENARIO_METRICS,
    ),
    maxLogs: nonNegativeInteger(input.maxLogs ?? DEFAULT_MAX_SCENARIO_LOGS, 'scenario maxLogs'),
    signal: input.signal ?? null,
  };
}

class ScenarioRecorder {
  offered = 0;
  started = 0;
  completed = 0;
  failed = 0;
  dropped = 0;
  active = 0;
  maxActive = 0;
  bytesSent = 0;
  bytesReceived = 0;
  messagesSent = 0;
  messagesReceived = 0;
  logsAccepted = 0;
  logsDropped = 0;
  readonly errors = new Map<string, number>();
  readonly metrics = new Map<string, LogHistogram>();

  constructor(
    readonly maxMetrics: number,
    readonly maxLogs: number,
  ) {}

  metric(name: string, value: number): void {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      throw new TypeError('fino load: metric names must be 1-64 safe ASCII characters');
    }
    finiteNonNegative(value, `metric ${name}`);
    let metric = this.metrics.get(name);
    if (metric === undefined) {
      if (this.metrics.size >= this.maxMetrics) {
        throw new RangeError(`fino load: scenario metric limit ${this.maxMetrics} reached`);
      }
      metric = new LogHistogram();
      this.metrics.set(name, metric);
    }
    metric.record(value);
  }

  count(direction: 'sent' | 'received', kind: 'bytes' | 'messages', count: number): void {
    nonNegativeInteger(count, `${kind}.${direction}`);
    if (kind === 'bytes' && direction === 'sent') this.bytesSent += count;
    else if (kind === 'bytes') this.bytesReceived += count;
    else if (direction === 'sent') this.messagesSent += count;
    else this.messagesReceived += count;
  }

  log(values: unknown[]): void {
    if (this.logsAccepted >= this.maxLogs) {
      this.logsDropped++;
      return;
    }
    this.logsAccepted++;
    console.log(...values);
  }

  error(error: unknown): void {
    this.failed++;
    const raw = error instanceof Error && error.name !== '' ? error.name : 'Error';
    const name = this.errors.has(raw) || this.errors.size < MAX_ERROR_CLASSES ? raw : 'Other';
    this.errors.set(name, (this.errors.get(name) ?? 0) + 1);
  }
}

function scenarioMetricResults(
  metrics: Map<string, LogHistogram>,
): Readonly<Record<string, LoadScenarioMetricResult>> {
  return Object.fromEntries(
    [...metrics.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, histogram]) => [
        name,
        { ...loadHistogramSnapshot(histogram), total: histogram.total },
      ]),
  );
}

function scenarioRateAt(
  rate: LoadRate,
  durationMs: number | null,
  sessions: number | null,
  start: number,
  scheduledAt: number,
  sequence: number,
): number {
  if (typeof rate === 'number') return rate;
  const progress =
    sessions !== null
      ? sessions <= 1
        ? 1
        : Math.min(1, sequence / (sessions - 1))
      : durationMs === null
        ? 0
        : Math.min(1, Math.max(0, (scheduledAt - start) / durationMs));
  return rate.start + (rate.end - rate.start) * progress;
}

/** Execute a bounded public `LoadScenario`. @internal */
export async function runLoadScenarioEngine(
  scenario: LoadScenario,
  rawOptions: LoadScenarioOptions = {},
): Promise<LoadScenarioResult> {
  const options = normalizeScenarioOptions(scenario, rawOptions);
  const client = new HttpClient();
  const recorder = new ScenarioRecorder(options.maxMetrics, options.maxLogs);
  const timedArrival = options.rate !== null && options.durationMs !== null;
  const phase = phaseSignal(options.signal, timedArrival ? null : options.durationMs);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const deadline =
    phase.deadline ?? (options.durationMs === null ? null : start + options.durationMs);
  const operation = async (
    signal: AbortSignal,
    _scheduledAt: number,
    sequence: number,
    workerId: number,
  ) => {
    recorder.started++;
    recorder.active++;
    recorder.maxActive = Math.max(recorder.maxActive, recorder.active);
    const responses: HttpResponse[] = [];
    const eventSources: Array<{ close(): void }> = [];
    const sockets: Array<{ close(code?: number, reason?: string): Promise<void> }> = [];
    const transports: Array<{ close(info?: { closeCode?: number; reason?: string }): void }> = [];
    const quicConnections: Array<{ close(): Promise<void> }> = [];
    const endpoints: QuicEndpoint[] = [];
    const controlled: LoadScenarioClient = {
      async request(input, init = {}) {
        const response = await client.request(input, { ...init, signal: init.signal ?? signal });
        responses.push(response);
        return response;
      },
      sse(input, init = {}) {
        const source = client.sse(input, init);
        eventSources.push(source);
        return source;
      },
      async websocket(input, init = {}) {
        const socket = await client.websocket(input, init);
        sockets.push(socket);
        return socket;
      },
      async webtransport(input, init = {}) {
        const transport = await client.webtransport(input, init);
        transports.push(transport);
        return transport;
      },
      async quic(init) {
        const endpoint = new QuicEndpoint(init.endpoint);
        endpoints.push(endpoint);
        const connection = await endpoint.connect(init.connect);
        quicConnections.push(connection);
        return connection;
      },
    };
    const context: LoadScenarioContext = {
      sequence,
      userId: workerId,
      signal,
      metric: (name, value) => recorder.metric(name, value),
      bytes: (direction, count) => recorder.count(direction, 'bytes', count),
      messages: (direction, count = 1) => recorder.count(direction, 'messages', count),
      log: (...values) => recorder.log(values),
    };
    try {
      await scenario.session(controlled, context);
      recorder.completed++;
    } catch (error) {
      recorder.error(error);
    } finally {
      try {
        for (const response of responses) await response.close().catch(() => {});
        for (const source of eventSources) {
          try {
            source.close();
          } catch {}
        }
        for (const socket of sockets) await socket.close().catch(() => {});
        for (const transport of transports) {
          try {
            transport.close();
          } catch {}
        }
        for (const connection of quicConnections) await connection.close().catch(() => {});
        for (const endpoint of endpoints) await endpoint.close().catch(() => {});
      } finally {
        recorder.active--;
      }
    }
  };
  try {
    if (options.rate === null) {
      await runClosedLoopPhase(
        {
          concurrency: options.users,
          requestLimit: options.sessions,
          deadline,
          signal: phase.signal,
          now: () => performance.now(),
        },
        async (signal, scheduledAt, sequence, workerId) => {
          recorder.offered++;
          await operation(signal, scheduledAt, sequence, workerId);
        },
      );
    } else {
      const sleeper = createArrivalSleeper();
      try {
        await runArrivalPhase(
          {
            concurrency: options.users,
            maxQueued: options.maxQueuedSessions,
            requestLimit: options.sessions,
            deadline,
            signal: phase.signal,
            now: () => performance.now(),
            sleep: sleeper.sleep,
            rateAt: (scheduledAt, sequence) =>
              scenarioRateAt(
                options.rate!,
                options.durationMs,
                options.sessions,
                start,
                scheduledAt,
                sequence,
              ),
            offer: () => recorder.offered++,
            drop: () => recorder.dropped++,
            finish: timedArrival
              ? () => phase.abort(new Error('fino load: scenario measured phase ended'))
              : undefined,
          },
          operation,
        );
      } finally {
        sleeper.close();
      }
    }
  } finally {
    phase.close();
    await client.close();
  }
  return {
    schemaVersion: 1,
    protocol: scenario.protocol,
    startedAt,
    durationMs: Math.max(0, performance.now() - start),
    offered: recorder.offered,
    started: recorder.started,
    completed: recorder.completed,
    failed: recorder.failed,
    dropped: recorder.dropped,
    maxActive: recorder.maxActive,
    bytes: { sent: recorder.bytesSent, received: recorder.bytesReceived },
    messages: { sent: recorder.messagesSent, received: recorder.messagesReceived },
    errors: sortedRecord(recorder.errors),
    metrics: scenarioMetricResults(recorder.metrics),
    logs: { accepted: recorder.logsAccepted, dropped: recorder.logsDropped },
  };
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
    `${result.config.protocol}, ${result.config.connections} connections x ${result.config.streams} streams = ${result.config.concurrency} concurrency, ${result.config.rate === null ? 'closed-loop' : 'open-loop'}, response=${result.config.responsePolicy}`,
  );
  lines.push(
    `${decimal(result.durationMs / 1000)} s measured, ${decimal(result.requestsPerSecond)} completed req/s, ${bytes(result.bytesPerSecond)}/s`,
  );
  lines.push(
    `Requests: offered=${result.counters.offered} started=${result.counters.started} completed=${result.counters.completed} successful=${result.counters.successful}`,
  );
  lines.push(
    `Failures: status=${result.counters.statusFailed} body=${result.counters.bodyFailed} timeout=${result.counters.timedOut} cancelled=${result.counters.cancelled} transport=${result.counters.transportFailed} dropped=${result.counters.schedulerDropped}`,
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
  if (result.bailout !== null) lines.push(`Bailout: ${result.bailout}`);
  lines.push('Latency:');
  lines.push(latencyLine('queue', result.latency.queue));
  lines.push(latencyLine('ttfb', result.latency.ttfb));
  lines.push(latencyLine('download', result.latency.download));
  lines.push(latencyLine('total', result.latency.total));
  if (result.latency.connect.count > 0) lines.push(latencyLine('connect', result.latency.connect));
  if (result.latency.tls.count > 0) lines.push(latencyLine('tls', result.latency.tls));
  return lines.join('\n') + '\n';
}

/** Render a scripted scenario result as stable plain text. @internal */
export function formatLoadScenarioResultText(result: LoadScenarioResult): string {
  const seconds = result.durationMs / 1000;
  const lines = [
    `fino load scenario (${result.protocol})`,
    `${decimal(seconds)} s measured, ${decimal(seconds === 0 ? 0 : result.completed / seconds)} completed sessions/s`,
    `Sessions: offered=${result.offered} started=${result.started} completed=${result.completed} failed=${result.failed} dropped=${result.dropped} max-active=${result.maxActive}`,
    `Traffic: sent=${bytes(result.bytes.sent)} received=${bytes(result.bytes.received)} messages-sent=${result.messages.sent} messages-received=${result.messages.received}`,
    distribution('Errors', result.errors),
    `Logs: accepted=${result.logs.accepted} dropped=${result.logs.dropped}`,
  ];
  for (const [name, metric] of Object.entries(result.metrics)) {
    lines.push(latencyLine(name, metric));
  }
  return lines.join('\n') + '\n';
}
