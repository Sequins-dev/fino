import { describe, it } from 'fino:test/test';
import { App } from 'fino:net/http/app';
import { Jobs } from 'fino:jobs';
import {
  WebhookVerificationError,
  createWebhookDeliveryTask,
  enqueueWebhook,
  signWebhook,
  verifyWebhookRequest,
  webhookVerifier,
} from 'fino:webhooks';
import { memoryStore } from 'fino:store';
const secret = 'webhook-test-secret';
function signedRequest(
  body: string,
  options: {
    id?: string;
    timestamp?: number;
  } = {},
): Request {
  const id = options.id ?? 'evt_123';
  const timestamp = options.timestamp ?? 18e8;
  const headers = signWebhook({
    id,
    timestamp,
    body,
    secret,
  });
  return new Request('https://example.test/hooks', {
    method: 'POST',
    headers,
    body,
  });
}
describe('fino:webhooks inbound verification', () => {
  it('verifies signed bytes, enforces the replay window, and rejects duplicate ids', async (t) => {
    const replay = memoryStore();
    const request = signedRequest('{"ok":true}');
    const verified = await verifyWebhookRequest(request, {
      secret,
      now: () => 18000001e5,
      toleranceSeconds: 300,
      replay,
    });
    t.equal(verified.id, 'evt_123', 'verified event id is returned');
    t.equal(
      new TextDecoder().decode(verified.body),
      '{"ok":true}',
      'signature covers the raw body bytes',
    );
    await t.rejects(
      () =>
        verifyWebhookRequest(signedRequest('{"ok":true}'), {
          secret,
          now: () => 18000001e5,
          toleranceSeconds: 300,
          replay,
        }),
      (error) => error instanceof WebhookVerificationError && error.code === 'replay_detected',
      'a claimed event id cannot be replayed',
    );
    await t.rejects(
      () =>
        verifyWebhookRequest(
          signedRequest('{"ok":true}', {
            id: 'evt_old',
            timestamp: 1799999e3,
          }),
          {
            secret,
            now: () => 18000001e5,
            toleranceSeconds: 300,
          },
        ),
      (error) =>
        error instanceof WebhookVerificationError && error.code === 'timestamp_outside_tolerance',
      'stale timestamps are rejected',
    );
  });
  it('rejects tampering and supports signing-key rotation', async (t) => {
    const request = signedRequest('original', { id: 'evt_rotate' });
    const tampered = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: 'tampered',
    });
    await t.rejects(
      () =>
        verifyWebhookRequest(tampered, {
          secrets: ['next-secret', secret],
          now: () => 18000001e5,
        }),
      (error) => error instanceof WebhookVerificationError && error.code === 'invalid_signature',
      'body tampering invalidates the signature',
    );
    const verified = await verifyWebhookRequest(signedRequest('rotated', { id: 'evt_rotated' }), {
      secrets: ['next-secret', secret],
      now: () => 18000001e5,
    });
    t.equal(verified.id, 'evt_rotated', 'any configured rotation key may verify');
  });
  it('provides middleware with actionable errors and preserves the handler body', async (t) => {
    const app = new App();
    app
      .use(
        webhookVerifier({
          secret,
          now: () => 18000001e5,
        }),
      )
      .post('/hooks')
      .handle(async (ctx) =>
        Response.json({
          id: ctx.webhook.id,
          body: await ctx.request.text(),
        }),
      );
    const accepted = await app.handle(signedRequest('payload', { id: 'evt_middleware' }));
    t.equal(accepted.status, 200, 'valid middleware request continues');
    t.deepEqual(
      await accepted.json(),
      {
        id: 'evt_middleware',
        body: 'payload',
      },
      'middleware verifies a clone and leaves the handler body readable',
    );
    const rejected = await app.handle(
      new Request('https://example.test/hooks', {
        method: 'POST',
        body: 'unsigned',
      }),
    );
    t.equal(rejected.status, 400, 'missing signature headers are a bad request');
    t.deepEqual(
      await rejected.json(),
      {
        error: {
          code: 'missing_header',
          message: 'Missing webhook-id header',
        },
      },
      'middleware returns an actionable machine-readable error',
    );
  });
});
describe('fino:webhooks outbound delivery', () => {
  it('queues signed delivery through fino:jobs with retry and a stable idempotency id', async (t) => {
    let attempts = 0;
    const received: Array<{
      body: string;
      id: string | null;
      signature: string | null;
      timestamp: string | null;
    }> = [];
    const delivery = createWebhookDeliveryTask({
      secret,
      now: () => 18000001e5,
      fetch: async (_url, init) => {
        attempts++;
        const headers = new Headers(init?.headers);
        received.push({
          body: String(init?.body),
          id: headers.get('webhook-id'),
          signature: headers.get('webhook-signature'),
          timestamp: headers.get('webhook-timestamp'),
        });
        return new Response(null, { status: attempts === 1 ? 503 : 204 });
      },
    });
    await using jobs = await Jobs.open({
      path: `/tmp/fino-webhooks-test-${Math.floor(Math.random() * 1e9)}.db`,
      tasks: [delivery],
      pollIntervalMs: 10,
    });
    const queued = await enqueueWebhook(
      jobs,
      {
        id: 'evt_delivery',
        url: 'https://receiver.test/hooks',
        body: '{"event":"created"}',
      },
      {
        retry: {
          maxAttempts: 2,
          baseMs: 10,
          maxMs: 10,
          jitter: false,
        },
      },
    );
    const done = await jobs.wait(queued.id, { timeoutMs: 1e4 });
    t.equal(done.status, 'done', 'transient HTTP failure is retried to completion');
    t.equal(attempts, 2, 'delivery used the jobs retry policy');
    t.equal(received[0].id, 'evt_delivery', 'the event id is the receiver idempotency key');
    t.equal(received[1].id, 'evt_delivery', 'the id remains stable across attempts');
    t.equal(received[0].body, '{"event":"created"}', 'the exact body is delivered');
    t.ok(
      received.every((attempt) => attempt.signature?.startsWith('v1,') === true),
      'every attempt is HMAC signed',
    );
    t.ok(
      received.every((attempt) => attempt.timestamp === '1800000100'),
      'timestamp header is included',
    );
  });
});
