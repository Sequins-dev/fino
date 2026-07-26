/**
 * fino:webhooks — signed inbound verification and durable outbound delivery.
 *
 * The signature covers `webhook-id`, `webhook-timestamp`, and the exact body
 * bytes with HMAC-SHA-256. Outbound work is a normal `fino:task` task, so
 * `enqueueWebhook()` delegates persistence, exponential backoff, and
 * dead-letter behavior to `fino:jobs`.
 *
 * Delivery is at-least-once. Receivers should retain `webhook-id` values for
 * their business idempotency window and return success for an already-applied
 * event. The jobs dedupe key prevents duplicate active deliveries but does not
 * replace durable receiver-side idempotency.
 *
 * ```ts no_run
 * import { Jobs } from 'fino:jobs';
 * import { createWebhookDeliveryTask, enqueueWebhook } from 'fino:webhooks';
 *
 * const delivery = createWebhookDeliveryTask({ secret: webhookSecret });
 * await using jobs = await Jobs.open({
 *   path: './.fino/jobs.db',
 *   tasks: [delivery],
 * });
 * await enqueueWebhook(jobs, {
 *   id: 'evt_123',
 *   url: 'https://example.com/hooks',
 *   body: JSON.stringify({ type: 'created' }),
 * });
 * ```
 */
import { hmac } from './internal/openssl.ts';
import {
  base64urlEncode,
  timingSafeEqualString,
  toBytes,
  type BufferLike,
} from './internal/security/encoding.ts';
import { fetch as runtimeFetch, type FetchInit } from './globals/fetch.ts';
import { Headers, Request, Response } from './net/http/index.ts';
import type { HttpContext, Middleware } from './net/http/app.ts';
import { NonRetryableJobError, type JobRecord, type JobRetryPolicy, type Jobs } from './jobs.ts';
import { task, type Task } from './task.ts';
const encoder = new TextEncoder();
const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_TASK_NAME = 'webhooks.deliver';
/**
 * Header names used by the Fino webhook signature scheme.
 */
export const webhookHeaders = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const;
/**
 * Input accepted by `signWebhook()`.
 */
export interface WebhookSignOptions {
  /**
   * Stable event identifier.
   */
  id: string;
  /**
   * Unix timestamp in seconds.
   */
  timestamp: number;
  /**
   * Exact body bytes or UTF-8 string to sign.
   */
  body: BufferLike;
  /**
   * HMAC secret.
   */
  secret: BufferLike;
}
function concatenate(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
function signingInput(id: string, timestamp: number, body: BufferLike): Uint8Array {
  return concatenate(encoder.encode(`${id}.${timestamp}.`), toBytes(body));
}
function signatureFor(options: WebhookSignOptions): string {
  const digest = hmac(
    'sha-256',
    toBytes(options.secret),
    signingInput(options.id, options.timestamp, options.body),
  );
  return `v1,${base64urlEncode(digest)}`;
}
/**
 * Create the three headers authenticating one webhook body.
 *
 * The timestamp is supplied by the caller so tests and durable delivery
 * attempts can make time explicit.
 */
export function signWebhook(options: WebhookSignOptions): Headers {
  if (!Number.isSafeInteger(options.timestamp) || options.timestamp < 0) {
    throw new TypeError('Webhook timestamp must be a non-negative integer');
  }
  if (options.id.length === 0) throw new TypeError('Webhook id must not be empty');
  return new Headers({
    [webhookHeaders.id]: options.id,
    [webhookHeaders.timestamp]: String(options.timestamp),
    [webhookHeaders.signature]: signatureFor(options),
  });
}
/**
 * Machine-readable inbound verification failure codes.
 */
export type WebhookVerificationErrorCode =
  | 'missing_header'
  | 'invalid_timestamp'
  | 'timestamp_outside_tolerance'
  | 'invalid_signature'
  | 'replay_detected';
/**
 * Error raised when an inbound webhook cannot be authenticated.
 */
export class WebhookVerificationError extends Error {
  /**
   * Machine-readable reason suitable for API responses and metrics.
   */
  readonly code: WebhookVerificationErrorCode;
  /**
   * Recommended HTTP status for the failure.
   */
  readonly status: number;
  /**
   * Create an actionable verification error.
   */
  constructor(code: WebhookVerificationErrorCode, message: string, status: number) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
    this.status = status;
  }
}
/**
 * Storage contract for atomic webhook replay claims.
 *
 * Shared deployments should implement this with a shared cache or database.
 * The in-memory implementation is appropriate only for one process.
 */
export interface WebhookReplayStore {
  /**
   * Atomically claim an event id until `expiresAt`.
   *
   * Return `false` when an unexpired claim already exists.
   */
  claim(id: string, expiresAt: number): Promise<boolean>;
}
/**
 * Single-process replay protection for inbound webhooks.
 */
export class InMemoryWebhookReplayStore implements WebhookReplayStore {
  readonly #claims = new Map<string, number>();
  /**
   * Atomically claim one event id in this process.
   */
  async claim(id: string, expiresAt: number): Promise<boolean> {
    const now = Date.now();
    for (const [key, expiry] of this.#claims) {
      if (expiry <= now) this.#claims.delete(key);
    }
    const existing = this.#claims.get(id);
    if (existing !== undefined && existing > now) return false;
    this.#claims.set(id, expiresAt);
    return true;
  }
}
/**
 * Options controlling inbound webhook verification.
 */
export interface WebhookVerificationOptions {
  /**
   * One active signing secret.
   *
   * Use `secrets` instead when rotating keys.
   */
  secret?: BufferLike;
  /**
   * Active signing secrets accepted during rotation.
   *
   * Every configured key is evaluated without early success.
   */
  secrets?: BufferLike[];
  /**
   * Maximum accepted timestamp age or future skew in seconds.
   *
   * Defaults to five minutes.
   */
  toleranceSeconds?: number;
  /**
   * Clock returning Unix time in milliseconds.
   */
  now?: () => number;
  /**
   * Optional atomic replay store.
   *
   * Signature and timestamp checks complete before the event id is claimed.
   */
  replay?: WebhookReplayStore;
}
/**
 * Authenticated inbound webhook data.
 */
export interface VerifiedWebhook {
  /**
   * Stable event identifier from `webhook-id`.
   */
  id: string;
  /**
   * Verified Unix timestamp in seconds.
   */
  timestamp: number;
  /**
   * Exact body bytes covered by the signature.
   */
  body: Uint8Array;
}
function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null || value.length === 0) {
    throw new WebhookVerificationError('missing_header', `Missing ${name} header`, 400);
  }
  return value;
}
function verificationSecrets(options: WebhookVerificationOptions): BufferLike[] {
  const secrets = options.secrets ?? (options.secret === undefined ? [] : [options.secret]);
  if (secrets.length === 0)
    throw new TypeError('Webhook verification requires at least one secret');
  return secrets;
}
function verifySignature(
  id: string,
  timestamp: number,
  body: Uint8Array,
  header: string,
  secrets: BufferLike[],
): boolean {
  const presented = header.split(/\s+/).filter(Boolean);
  let valid = false;
  for (const secret of secrets) {
    const expected = signatureFor({
      id,
      timestamp,
      body,
      secret,
    });
    for (const candidate of presented) {
      valid = timingSafeEqualString(candidate, expected) || valid;
    }
  }
  return valid;
}
/**
 * Authenticate one Fetch-compatible webhook request.
 *
 * This consumes the supplied request body. Middleware verifies a clone so the
 * downstream handler retains its own readable body.
 */
export async function verifyWebhookRequest(
  request: Request,
  options: WebhookVerificationOptions,
): Promise<VerifiedWebhook> {
  const id = requiredHeader(request.headers, webhookHeaders.id);
  const timestampHeader = requiredHeader(request.headers, webhookHeaders.timestamp);
  const signature = requiredHeader(request.headers, webhookHeaders.signature);
  if (!/^\d+$/.test(timestampHeader)) {
    throw new WebhookVerificationError(
      'invalid_timestamp',
      'webhook-timestamp must be Unix seconds',
      400,
    );
  }
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp)) {
    throw new WebhookVerificationError(
      'invalid_timestamp',
      'webhook-timestamp must be Unix seconds',
      400,
    );
  }
  const nowMs = options.now?.() ?? Date.now();
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new TypeError('Webhook toleranceSeconds must be non-negative');
  }
  if (Math.abs(Math.floor(nowMs / 1e3) - timestamp) > tolerance) {
    throw new WebhookVerificationError(
      'timestamp_outside_tolerance',
      `webhook-timestamp is outside the ${tolerance}s replay window`,
      401,
    );
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (!verifySignature(id, timestamp, body, signature, verificationSecrets(options))) {
    throw new WebhookVerificationError(
      'invalid_signature',
      'Webhook signature does not match the request',
      401,
    );
  }
  if (options.replay !== undefined) {
    const expiresAt = nowMs + tolerance * 1e3;
    if (!(await options.replay.claim(id, expiresAt))) {
      throw new WebhookVerificationError(
        'replay_detected',
        `Webhook '${id}' was already received`,
        409,
      );
    }
  }
  return {
    id,
    timestamp,
    body,
  };
}
/**
 * Create inbound verification middleware for `fino:net/http/app`.
 *
 * Successful verification stores `VerifiedWebhook` on `ctx.webhook`.
 * Verification failures short-circuit with `{ error: { code, message } }`.
 */
export function webhookVerifier(options: WebhookVerificationOptions): Middleware {
  return async (ctx: HttpContext) => {
    try {
      ctx.webhook = await verifyWebhookRequest(ctx.request.clone(), options);
    } catch (error) {
      if (!(error instanceof WebhookVerificationError)) throw error;
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: error.status },
      );
    }
  };
}
/**
 * JSON-compatible input persisted for one outbound delivery.
 */
export interface WebhookDeliveryInput {
  /**
   * Stable event id used for receiver idempotency.
   */
  id: string;
  /**
   * Absolute HTTP or HTTPS receiver URL.
   */
  url: string;
  /**
   * Exact UTF-8 body delivered and signed.
   */
  body: string;
  /**
   * Optional application headers.
   *
   * Signature headers are always replaced by freshly computed values.
   */
  headers?: Record<string, string>;
}
/**
 * Minimal fetch shape accepted by outbound delivery for custom transports and
 * deterministic tests.
 */
export type WebhookFetch = (input: string | Request, init?: FetchInit) => Promise<Response>;
/**
 * Options used to construct the outbound delivery task.
 */
export interface WebhookDeliveryTaskOptions {
  /**
   * HMAC secret retained by the worker and never persisted in job input.
   */
  secret: BufferLike;
  /**
   * Stable task name registered with `fino:jobs`.
   *
   * Defaults to `webhooks.deliver`.
   */
  name?: string;
  /**
   * Clock returning Unix time in milliseconds.
   */
  now?: () => number;
  /**
   * Fetch implementation used for delivery.
   */
  fetch?: WebhookFetch;
}
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
/**
 * Create the task that performs one signed outbound attempt.
 *
 * Network failures and transient HTTP statuses throw retryable errors. Other
 * non-2xx responses throw `NonRetryableJobError` so `fino:jobs` dead-letters
 * them immediately.
 */
export function createWebhookDeliveryTask(options: WebhookDeliveryTaskOptions): Task<
  WebhookDeliveryInput,
  {
    status: number;
  }
> {
  const fetch = options.fetch ?? runtimeFetch;
  return task({
    name: options.name ?? DEFAULT_TASK_NAME,
    description: 'Deliver one HMAC-signed webhook',
    effects: [
      {
        kind: 'network',
        description: 'Send an HTTP webhook to the configured receiver',
      },
    ],
    sideEffects: true,
    run: async (input, ctx) => {
      const url = new URL(input.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new NonRetryableJobError('Webhook URL must use HTTP or HTTPS');
      }
      const timestamp = Math.floor((options.now?.() ?? Date.now()) / 1e3);
      const headers = new Headers(input.headers);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      const signed = signWebhook({
        id: input.id,
        timestamp,
        body: input.body,
        secret: options.secret,
      });
      for (const [name, value] of signed) headers.set(name, value);
      const response = await fetch(url.href, {
        method: 'POST',
        headers,
        body: input.body,
        redirect: 'error',
        signal: ctx.signal,
      });
      const responseBody = await response.text();
      if (response.status >= 200 && response.status < 300) {
        return { status: response.status };
      }
      const detail = responseBody.trim().slice(0, 256);
      const message = `Webhook receiver returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
      if (isRetryableStatus(response.status)) throw new Error(message);
      throw new NonRetryableJobError(message);
    },
  });
}
/**
 * Queue options for durable outbound delivery.
 */
export interface EnqueueWebhookOptions {
  /**
   * Registered delivery task name.
   *
   * Must match `createWebhookDeliveryTask({ name })`.
   */
  task?: string;
  /**
   * Queue name. Defaults to `webhooks`.
   */
  queue?: string;
  /**
   * Retry policy passed through to `fino:jobs`.
   */
  retry?: Partial<JobRetryPolicy>;
  /**
   * Per-attempt timeout in milliseconds.
   */
  timeoutMs?: number;
}
/**
 * Persist an outbound webhook in `fino:jobs`.
 *
 * The event id is also the active-job dedupe key. Delivery remains at-least-once
 * across crashes, so receivers must make applying that id idempotent.
 */
export function enqueueWebhook(
  jobs: Pick<Jobs, 'push'>,
  input: WebhookDeliveryInput,
  options: EnqueueWebhookOptions = {},
): Promise<JobRecord> {
  return jobs.push(options.task ?? DEFAULT_TASK_NAME, input, {
    queue: options.queue ?? 'webhooks',
    key: input.id,
    retry: options.retry ?? {
      maxAttempts: 5,
      baseMs: 1e3,
      factor: 2,
      maxMs: 6e4,
      jitter: true,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
