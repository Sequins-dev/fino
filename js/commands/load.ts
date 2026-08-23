/**
 * fino:commands/load — reusable HTTP and scripted-protocol load task.
 *
 * Parses closed-loop or bounded open-loop HTTP workloads and TypeScript
 * scenarios, then delegates execution to `fino:load`. HTTP mode pins
 * HTTP/1.1, HTTP/2, or HTTP/3 explicitly; it does not silently fall back when
 * the peer cannot speak the selected protocol. Responses stream into a byte
 * counter by default, while `--response cancel` stops after final headers and
 * records the run as headers-only.
 *
 * Durations accept `ms`, `s`, `m`, or `h` suffixes. Use either `--duration`
 * (10 seconds by default) or `--requests`, never both. JSON mode emits the
 * versioned HTTP or scenario result from `fino:load`; text mode prints the
 * corresponding shared human-readable summary. Scenario modules are imported
 * from the command working directory and must default-export `LoadScenario`.
 *
 * ```ts no_run
 * import loadCommand from 'fino:commands/load';
 *
 * await loadCommand.parse([
 *   '--protocol', 'h2',
 *   '--connections', '10',
 *   '--streams', '20',
 *   '--duration', '30s',
 *   'https://localhost:3000/health',
 * ]);
 * ```
 */
import { DiskFileSystem } from '../file/fs.ts';
import { cwd } from '../process.ts';
import { formatLoadResult, formatLoadScenarioResult, runLoad, runLoadScenario } from '../load.ts';
import type {
  LoadOptions,
  LoadProtocol,
  LoadScenario,
  LoadScenarioOptions,
  LoadTarget,
  LoadTlsOptions,
} from '../load.ts';
import { Task } from '../task.ts';
import type { TaskJsonValue } from '../task.ts';

interface LoadCommandInput {
  url?: unknown;
  target?: unknown[];
  scenario?: unknown;
  users?: unknown;
  sessions?: unknown;
  protocol?: unknown;
  method?: unknown;
  header?: unknown[];
  body?: unknown;
  'body-file'?: unknown;
  connections?: unknown;
  streams?: unknown;
  duration?: unknown;
  requests?: unknown;
  warmup?: unknown;
  rate?: unknown;
  'rate-to'?: unknown;
  seed?: unknown;
  'max-queued-operations'?: unknown;
  'reconnect-after'?: unknown;
  response?: unknown;
  'expect-status'?: unknown[];
  'expect-body'?: unknown;
  'bailout-failures'?: unknown;
  'bailout-errors'?: unknown;
  timeout?: unknown;
  'connect-timeout'?: unknown;
  'headers-timeout'?: unknown;
  'body-idle-timeout'?: unknown;
  'max-pending-requests'?: unknown;
  'max-buffered-response-bytes'?: unknown;
  retry?: unknown;
  'no-decompress'?: unknown;
  redirect?: unknown;
  ca?: unknown;
  cert?: unknown;
  key?: unknown;
  insecure?: unknown;
  title?: unknown;
  quiet?: unknown;
}

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Parse a CLI duration such as `250ms`, `10s`, `2m`, or `1h`. @internal */
function parseLoadDuration(value: unknown, option: string): number {
  const text = String(value).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
  if (match === null) {
    throw new TypeError(`fino load: ${option} must be a duration such as 250ms, 10s, 2m, or 1h`);
  }
  return Number(match[1]) * DURATION_UNITS[match[2]!]!;
}

function optionalDuration(value: unknown, option: string): number | undefined {
  return value === undefined ? undefined : parseLoadDuration(value, option);
}

function parseHeaders(values: unknown[] | undefined): string[][] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const headers: string[][] = [];
  for (const raw of values) {
    const line = String(raw);
    const colon = line.indexOf(':');
    if (colon <= 0) throw new TypeError(`fino load: invalid header ${JSON.stringify(line)}`);
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trimStart();
    headers.push([name, value]);
  }
  return headers;
}

function numberOption(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

async function requestBody(
  inline: unknown,
  file: unknown,
  commandCwd: string | undefined,
): Promise<string | Uint8Array | undefined> {
  if (inline !== undefined && file !== undefined) {
    throw new RangeError('fino load: --body and --body-file are mutually exclusive');
  }
  if (inline !== undefined) return String(inline);
  if (file === undefined) return undefined;
  const rawPath = String(file);
  const path = rawPath.startsWith('/') ? rawPath : `${commandCwd ?? cwd()}/${rawPath}`;
  return new DiskFileSystem().readFile(path);
}

function protocolOption(value: unknown): LoadProtocol {
  if (value === undefined || value === 'h1' || value === 'http/1.1') return 'http/1.1';
  if (value === 'h2' || value === 'h3') return value;
  throw new TypeError('fino load: --protocol must be h1, h2, or h3');
}

function fileUrlFromPath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let encoded = '';
  for (const byte of bytes) {
    encoded +=
      byte === 47 ||
      (byte >= 48 && byte <= 57) ||
      (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      byte === 45 ||
      byte === 46 ||
      byte === 95 ||
      byte === 126
        ? String.fromCharCode(byte)
        : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return 'file://' + encoded;
}

function parseTargets(values: unknown[] | undefined): LoadTarget[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values.map((raw) => {
    const text = String(raw);
    const weighted = /^(\d+(?:\.\d+)?):(https?:\/\/.*)$/i.exec(text);
    return weighted === null ? { url: text } : { url: weighted[2]!, weight: Number(weighted[1]) };
  });
}

async function importScenario(path: string): Promise<LoadScenario> {
  const mod = (await import(fileUrlFromPath(path))) as { default?: unknown };
  const scenario = mod.default as Partial<LoadScenario> | undefined;
  if (
    typeof scenario !== 'object' ||
    scenario === null ||
    typeof scenario.protocol !== 'string' ||
    typeof scenario.session !== 'function'
  ) {
    throw new TypeError('fino load: scenario file must default-export a LoadScenario');
  }
  return scenario as LoadScenario;
}

/**
 * The `load` subcommand mounted by the root Fino CLI.
 *
 * It accepts one URL, repeatable weighted targets, or one TypeScript scenario.
 * Text mode returns the formatted report string. JSON mode writes and returns
 * the versioned result object. `--quiet` suppresses text output but never
 * suppresses explicitly requested JSON.
 */
const command = new Task({
  name: 'load',
  description: 'Load test HTTP or a scripted stateful protocol',
  outputMode: 'both',
  sideEffects: true,
  effects: [
    {
      kind: 'network-load',
      description: 'Sends concurrent HTTP requests to the selected target',
    },
  ],
  run: async function runLoadCommand(input: LoadCommandInput, ctx) {
    const targets = parseTargets(input.target);
    if (input.scenario !== undefined) {
      if (input.url !== undefined || targets !== undefined) {
        throw new RangeError('fino load: --scenario cannot be combined with URL targets');
      }
      if (input.duration !== undefined && input.sessions !== undefined) {
        throw new RangeError('fino load: --duration and --sessions are mutually exclusive');
      }
      const rawPath = String(input.scenario);
      const path = rawPath.startsWith('/') ? rawPath : `${ctx.cwd ?? cwd()}/${rawPath}`;
      const scenario = await importScenario(path);
      const scenarioOptions: LoadScenarioOptions = { signal: ctx.signal };
      const users = numberOption(input.users);
      const sessions = numberOption(input.sessions);
      const durationMs = optionalDuration(input.duration, '--duration');
      const rate = numberOption(input.rate);
      const rateTo = numberOption(input['rate-to']);
      const maxQueued = numberOption(input['max-queued-operations']);
      const seed = numberOption(input.seed);
      if (rateTo !== undefined && rate === undefined) {
        throw new RangeError('fino load: --rate-to requires --rate');
      }
      if (users !== undefined) scenarioOptions.users = users;
      if (sessions !== undefined) scenarioOptions.sessions = sessions;
      if (durationMs !== undefined) scenarioOptions.durationMs = durationMs;
      if (rate !== undefined)
        scenarioOptions.rate = rateTo === undefined ? rate : { start: rate, end: rateTo };
      if (maxQueued !== undefined) scenarioOptions.maxQueuedSessions = maxQueued;
      if (seed !== undefined) scenarioOptions.seed = seed;
      const result = await runLoadScenario(scenario, scenarioOptions);
      if (ctx.writer.mode === 'json') {
        await ctx.writer.writeJson(result as unknown as TaskJsonValue);
        return result;
      }
      return input.quiet === true ? '' : formatLoadScenarioResult(result);
    }
    if (input.url === undefined && targets === undefined) {
      throw new Error('fino load: no target URL specified');
    }
    if (input.duration !== undefined && input.requests !== undefined) {
      throw new RangeError('fino load: --duration and --requests are mutually exclusive');
    }
    const timeouts: NonNullable<LoadOptions['timeouts']> = {};
    const timeout = optionalDuration(input.timeout, '--timeout');
    const connectTimeout = optionalDuration(input['connect-timeout'], '--connect-timeout');
    const headersTimeout = optionalDuration(input['headers-timeout'], '--headers-timeout');
    const bodyIdleTimeout = optionalDuration(input['body-idle-timeout'], '--body-idle-timeout');
    if (timeout !== undefined) timeouts.total = timeout;
    if (connectTimeout !== undefined) timeouts.connect = connectTimeout;
    if (headersTimeout !== undefined) timeouts.headers = headersTimeout;
    if (bodyIdleTimeout !== undefined) timeouts.bodyIdle = bodyIdleTimeout;
    const tls: LoadTlsOptions = {};
    if (input.ca !== undefined) tls.ca = String(input.ca);
    if (input.cert !== undefined) tls.cert = String(input.cert);
    if (input.key !== undefined) tls.key = String(input.key);
    if (input.insecure === true) tls.rejectUnauthorized = false;
    const headers = parseHeaders(input.header);
    const body = await requestBody(input.body, input['body-file'], ctx.cwd);
    const connections = numberOption(input.connections);
    const streams = numberOption(input.streams);
    const durationMs = optionalDuration(input.duration, '--duration');
    const requests = numberOption(input.requests);
    const warmupMs = optionalDuration(input.warmup, '--warmup');
    const rate = numberOption(input.rate);
    const rateTo = numberOption(input['rate-to']);
    if (rateTo !== undefined && rate === undefined) {
      throw new RangeError('fino load: --rate-to requires --rate');
    }
    const expectedStatus =
      input['expect-status'] === undefined || input['expect-status'].length === 0
        ? undefined
        : input['expect-status'].map((status) => Number(status));
    const maxPendingRequests = numberOption(input['max-pending-requests']);
    const maxBufferedResponseBytes = numberOption(input['max-buffered-response-bytes']);
    const retryAttempts = numberOption(input.retry);
    const options: LoadOptions = {
      protocol: protocolOption(input.protocol),
      responsePolicy: input.response === 'cancel' ? 'cancel' : 'consume',
      timeouts,
      decompress: input['no-decompress'] !== true,
      tls,
      signal: ctx.signal,
    };
    if (input.url !== undefined) options.url = String(input.url);
    if (targets !== undefined) options.targets = targets;
    if (input.method !== undefined) options.method = String(input.method);
    if (headers !== undefined) options.headers = headers;
    if (body !== undefined) options.body = body;
    if (connections !== undefined) options.connections = connections;
    if (streams !== undefined) options.streams = streams;
    if (durationMs !== undefined) options.durationMs = durationMs;
    if (requests !== undefined) options.requests = requests;
    if (warmupMs !== undefined) options.warmupMs = warmupMs;
    if (rate !== undefined)
      options.rate = rateTo === undefined ? rate : { start: rate, end: rateTo };
    const seed = numberOption(input.seed);
    const maxQueuedOperations = numberOption(input['max-queued-operations']);
    const reconnectAfter = numberOption(input['reconnect-after']);
    if (seed !== undefined) options.seed = seed;
    if (maxQueuedOperations !== undefined) options.maxQueuedOperations = maxQueuedOperations;
    if (reconnectAfter !== undefined) options.reconnectAfter = reconnectAfter;
    if (expectedStatus !== undefined) options.expectedStatus = expectedStatus;
    if (input['expect-body'] !== undefined) options.expectedBody = String(input['expect-body']);
    const bailoutFailures = numberOption(input['bailout-failures']);
    const bailoutErrors = numberOption(input['bailout-errors']);
    if (bailoutFailures !== undefined || bailoutErrors !== undefined) {
      options.bailout = {};
      if (bailoutFailures !== undefined) options.bailout.failures = bailoutFailures;
      if (bailoutErrors !== undefined) options.bailout.errors = bailoutErrors;
    }
    if (maxPendingRequests !== undefined) options.maxPendingRequests = maxPendingRequests;
    if (maxBufferedResponseBytes !== undefined) {
      options.maxBufferedResponseBytes = maxBufferedResponseBytes;
    }
    if (retryAttempts !== undefined) options.retryAttempts = retryAttempts;
    if (input.redirect !== undefined) {
      options.redirect = input.redirect as NonNullable<LoadOptions['redirect']>;
    }
    if (input.title !== undefined) options.title = String(input.title);
    const result = await runLoad(options);
    if (ctx.writer.mode === 'json') {
      await ctx.writer.writeJson(result as unknown as TaskJsonValue);
      return result;
    }
    return input.quiet === true ? '' : formatLoadResult(result);
  },
  cli: {
    options: [
      {
        name: 'target',
        flags: '--target',
        type: 'string',
        multiple: true,
        description: 'Weighted target as URL or WEIGHT:URL; repeatable',
      },
      {
        flags: '--scenario',
        type: 'string',
        description: 'TypeScript module default-exporting a LoadScenario',
      },
      {
        flags: '--users',
        type: 'number',
        description: 'Concurrent virtual users for --scenario',
      },
      {
        flags: '--sessions',
        type: 'number',
        description: 'Exact session count for --scenario',
      },
      {
        flags: '--protocol, -p',
        type: 'string',
        choices: ['h1', 'h2', 'h3'],
        default: 'h1',
        description: 'Require h1, h2, or h3; no silent fallback',
      },
      {
        flags: '--method, -X',
        type: 'string',
        default: 'GET',
        description: 'HTTP method sent by every operation',
      },
      {
        name: 'header',
        flags: '--header, -H',
        type: 'string',
        multiple: true,
        description: 'Request header in name:value form; repeatable',
      },
      {
        flags: '--body',
        type: 'string',
        description: 'Static request body replayed for every operation',
      },
      {
        flags: '--body-file',
        type: 'string',
        description: 'Read the replayable request body from a file',
      },
      {
        flags: '--connections, -c',
        type: 'number',
        default: 10,
        description: 'Physical connections to maintain',
      },
      {
        flags: '--streams, -m',
        type: 'number',
        default: 1,
        description: 'Concurrent streams per h2 or h3 connection',
      },
      {
        flags: '--duration, -d',
        type: 'string',
        description: 'Measured duration, for example 10s; defaults to 10s',
      },
      {
        flags: '--requests, -n',
        type: 'number',
        description: 'Exact measured request count instead of a duration',
      },
      {
        flags: '--warmup',
        type: 'string',
        default: '0ms',
        description: 'Unmeasured warmup duration using the same client',
      },
      {
        flags: '--rate',
        type: 'number',
        description: 'Open-loop starting arrival rate per second',
      },
      {
        flags: '--rate-to',
        type: 'number',
        description: 'Linearly ramp the arrival rate to this value',
      },
      {
        flags: '--seed',
        type: 'number',
        default: 1,
        description: 'Deterministic target, substitution, and scenario seed',
      },
      {
        flags: '--max-queued-operations',
        type: 'number',
        description: 'Bound open-loop arrivals waiting for capacity',
      },
      {
        flags: '--reconnect-after',
        type: 'number',
        description: 'Recreate pooled sessions after this many starts',
      },
      {
        flags: '--response',
        type: 'string',
        choices: ['consume', 'cancel'],
        default: 'consume',
        description: 'Stream and drop response bodies or cancel after headers',
      },
      {
        flags: '--expect-status',
        type: 'number',
        multiple: true,
        description: 'Status code considered successful; repeatable',
      },
      {
        flags: '--expect-body',
        type: 'string',
        description: 'Exact response body matched incrementally',
      },
      {
        flags: '--bailout-failures',
        type: 'number',
        description: 'Stop after this many status or body failures',
      },
      {
        flags: '--bailout-errors',
        type: 'number',
        description: 'Stop after this many timeout or transport failures',
      },
      {
        flags: '--timeout',
        type: 'string',
        description: 'Total timeout per request; defaults to 30s',
      },
      {
        flags: '--connect-timeout',
        type: 'string',
        description: 'DNS plus new-connection timeout',
      },
      {
        flags: '--headers-timeout',
        type: 'string',
        description: 'Local queue plus final response headers timeout',
      },
      {
        flags: '--body-idle-timeout',
        type: 'string',
        description: 'Maximum idle gap between response body chunks',
      },
      {
        flags: '--max-pending-requests',
        type: 'number',
        description: 'Bound HttpClient requests waiting for capacity',
      },
      {
        flags: '--max-buffered-response-bytes',
        type: 'number',
        default: 1024 * 1024,
        description: 'Bound unread bytes on each h2 or h3 response',
      },
      {
        flags: '--retry',
        type: 'number',
        default: 1,
        description: 'Total safe attempts for replayable idempotent requests',
      },
      {
        flags: '--no-decompress',
        type: 'boolean',
        description: 'Count encoded bytes without transparent decompression',
      },
      {
        flags: '--redirect',
        type: 'string',
        choices: ['follow', 'error', 'manual'],
        default: 'follow',
        description: 'Redirect policy',
      },
      {
        flags: '--ca',
        type: 'string',
        description: 'Certificate authority PEM file',
      },
      {
        flags: '--cert',
        type: 'string',
        description: 'Client certificate PEM file',
      },
      {
        flags: '--key',
        type: 'string',
        description: 'Client private key PEM file',
      },
      {
        flags: '--insecure',
        type: 'boolean',
        description: 'Disable TLS peer verification for local development',
      },
      {
        flags: '--title',
        type: 'string',
        description: 'Label included in text and JSON results',
      },
      {
        flags: '--quiet, -q',
        type: 'boolean',
        description: 'Suppress the final text report',
      },
    ],
    positionals: [
      {
        name: 'url',
        type: 'string',
        required: false,
        description: 'Absolute HTTP(S) target URL unless --target or --scenario is used',
      },
    ],
  },
});

export { command as default };
