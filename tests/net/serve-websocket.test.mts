/**
 * Tests for WebSocket upgrade through serve().
 *
 * Verifies that a serve() handler can return a WebSocketConnection obtained
 * from WebSocketConnection.accept(req), and that the same server also handles
 * plain HTTP requests correctly.
 */

import { describe, it } from 'fino:test/test';
import { serve } from 'fino:net/http/server';
import { WebSocketConnection, MessageEvent, CloseEvent } from 'fino:net/http/websocket';
import type { Event, EventTarget } from 'internal:globals/eventtarget';

// ---------------------------------------------------------------------------
// Helper: wait for a named event on an EventTarget
// ---------------------------------------------------------------------------

import * as loop from 'internal:runtime/loop';

function waitForEvent<T extends Event>(target: EventTarget, name: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = loop.timeout(timeoutMs);
    t.then(() => {
      reject(new Error('waitForEvent timed out waiting for: ' + name));
    }).catch(() => {});
    target.addEventListener(name, function handler(e) {
      t.cancel();
      target.removeEventListener(name, handler);
      resolve(e as T);
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serve() WebSocket upgrade', () => {
  it('handler returns WebSocketConnection.accept(req) — server sends, client receives', async (t) => {
    const server = serve({ port: 0 }, (req) => {
      if (req.headers.get('upgrade') === 'websocket') {
        const ws = WebSocketConnection.accept(req as any);
        // Send from the server as soon as the connection is open.
        ws.addEventListener('open', () => {
          void ws.send('hello from server');
        });
        return ws;
      }
      return new Response('not a ws upgrade', { status: 400 });
    });

    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/ws`);

      // Wait for the client message — open will have fired before message arrives.
      const msgEvt = await waitForEvent<MessageEvent>(client as unknown as EventTarget, 'message');
      t.equal(client.readyState, WebSocketConnection.OPEN, 'client is OPEN after handshake');
      t.equal((msgEvt as MessageEvent).data, 'hello from server', 'client received server message');

      // Close cleanly from client side.
      // Register the close listener before initiating close so we don't miss it.
      const closePromise = waitForEvent<CloseEvent>(client as unknown as EventTarget, 'close');
      await client.close(1000, 'done');
      const closeEvt = await closePromise;
      t.ok(closeEvt.wasClean, 'client close was clean');
    } finally {
      await server.close();
    }
  });

  it('server closes the connection first — client receives close event', async (t) => {
    const server = serve({ port: 0 }, (req) => {
      if (req.headers.get('upgrade') === 'websocket') {
        const ws = WebSocketConnection.accept(req as any);
        ws.addEventListener('open', async () => {
          await ws.send('goodbye');
          await ws.close(1000, 'server done');
        });
        return ws;
      }
      return new Response('not ws', { status: 400 });
    });

    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/`);

      const msgEvt = await waitForEvent<MessageEvent>(client as unknown as EventTarget, 'message');
      t.equal((msgEvt as MessageEvent).data, 'goodbye', 'client received server message before close');

      const closeEvt = await waitForEvent<CloseEvent>(client as unknown as EventTarget, 'close');
      t.ok(closeEvt.wasClean, 'close was clean (code 1000)');
      t.equal(closeEvt.code, 1000, 'close code is 1000');
    } finally {
      await server.close();
    }
  });

  it('non-WebSocket request still works on same server', async (t) => {
    const server = serve({ port: 0 }, (req) => {
      if (req.headers.get('upgrade') === 'websocket') {
        const ws = WebSocketConnection.accept(req as any);
        return ws;
      }
      return new Response('ok');
    });

    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/`);
      t.equal(resp.status, 200, 'HTTP GET returned 200');
      const body = await resp.text();
      t.equal(body, 'ok', 'plain HTTP response body is correct');
    } finally {
      await server.close();
    }
  });
});
