/**
 * Tests for fino:net/http/eventsource — EventSourceReader, EventSourceWriter, and EventSource.
 */

import { describe, it } from 'fino:test/test';
import { EventSourceReader, EventSourceWriter, EventSource } from 'fino:net/http/eventsource';
import { serve } from 'fino:net/http/server';
import { Response } from 'fino:net/http';
import * as loop from 'internal:runtime/loop';
type EventSourceMessage = { type: string; data: string; lastEventId: string };
const encodeUtf8 = (s: string) => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView) => new TextDecoder().decode(b);
const tlsAvailable = (globalThis as typeof globalThis & { tlsAvailable?: boolean }).tlsAvailable;
const skipTls = !tlsAvailable && 'OpenSSL (libssl) not available';
const CERT_PATH = new URL('./fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH  = new URL('./fixtures/test.key', import.meta.url).pathname;

async function* source(str: string): AsyncIterable<Uint8Array> {
  yield encodeUtf8(str);
}

async function* chunkedSource(str: string, size: number): AsyncIterable<Uint8Array> {
  const bytes = encodeUtf8(str);
  let pos = 0;
  while (pos < bytes.byteLength) {
    const end   = Math.min(pos + size, bytes.byteLength);
    const chunk = bytes.subarray(pos, end);
    pos = end;
    yield chunk;
  }
}

async function collect<T>(reader: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const event of reader) events.push(event);
  return events;
}

function mockWriter() {
  const parts: Uint8Array[] = [];
  return {
    write(bytes: ArrayBuffer | Uint8Array) {
      parts.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      return Promise.resolve(bytes.byteLength);
    },
    output() {
      let total = 0;
      for (const p of parts) total += p.byteLength;
      const out = new Uint8Array(total);
      let pos = 0;
      for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
      return decodeUtf8(out);
    },
  };
}

function sseBody(...items: Array<string | { retry?: number; event?: string; id?: string; data: string }>) {
  let body = '';
  for (const item of items) {
    if (typeof item === 'string') {
      body += item;
    } else {
      if (item.retry !== undefined) body += `retry: ${item.retry}\n`;
      if (item.event !== undefined) body += `event: ${item.event}\n`;
      if (item.id    !== undefined) body += `id: ${item.id}\n`;
      body += `data: ${item.data}\n`;
      body += '\n';
    }
  }
  return body;
}

function sseResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}

describe('EventSourceReader', () => {
  it('basic single event', async (t) => {
    const events = await collect(new EventSourceReader(source('data: hello\n\n')));
    t.equal(events.length, 1);
    t.equal(events[0]!.type, 'message');
    t.equal(events[0]!.data, 'hello');
    t.equal(events[0]!.id, null);
    t.equal(events[0]!.retry, null);
  });

  it('multi-line data joined with newline', async (t) => {
    const events = await collect(new EventSourceReader(source('data: line1\ndata: line2\ndata: line3\n\n')));
    t.equal(events.length, 1);
    t.equal(events[0]!.data, 'line1\nline2\nline3');
  });

  it('named event type', async (t) => {
    const events = await collect(new EventSourceReader(source('event: update\ndata: payload\n\n')));
    t.equal(events[0]!.type, 'update');
    t.equal(events[0]!.data, 'payload');
  });

  it('event id field', async (t) => {
    const events = await collect(new EventSourceReader(source('id: 42\ndata: hello\n\n')));
    t.equal(events[0]!.id, '42');
  });

  it('lastEventId persists across events', async (t) => {
    const str = 'id: 1\ndata: first\n\ndata: second\n\nid: 3\ndata: third\n\n';
    const reader = new EventSourceReader(source(str));
    const events = await collect(reader);
    t.equal(events[0]!.id, '1');
    t.equal(events[1]!.id, null);
    t.equal(events[2]!.id, '3');
    t.equal(reader.lastEventId, '3');
  });

  it('empty id field resets lastEventId to empty string', async (t) => {
    const str = 'id: 42\ndata: first\n\nid:\ndata: second\n\n';
    const reader = new EventSourceReader(source(str));
    const events = await collect(reader);
    t.equal(events[0]!.id, '42');
    t.equal(events[1]!.id, '');
    t.equal(reader.lastEventId, '');
  });

  it('id with null character is ignored', async (t) => {
    const str = 'id: bad\0id\ndata: hello\n\n';
    const reader = new EventSourceReader(source(str));
    const events = await collect(reader);
    t.equal(events[0]!.id, null, 'id with null char should be ignored');
    t.equal(reader.lastEventId, '', 'lastEventId unchanged');
  });

  it('retry field parsed as integer', async (t) => {
    const events = await collect(new EventSourceReader(source('retry: 5000\ndata: hello\n\n')));
    t.equal(events[0]!.retry, 5000);
  });

  it('invalid retry (non-digits) is ignored', async (t) => {
    const events = await collect(new EventSourceReader(source('retry: 1.5\ndata: hello\n\n')));
    t.equal(events[0]!.retry, null, 'non-integer retry ignored');
  });

  it('invalid retry (with text) is ignored', async (t) => {
    const events = await collect(new EventSourceReader(source('retry: 100ms\ndata: hello\n\n')));
    t.equal(events[0]!.retry, null, 'retry with letters ignored');
  });

  it('comment lines are ignored', async (t) => {
    const str = ': this is a comment\ndata: real data\n: another comment\n\n';
    const events = await collect(new EventSourceReader(source(str)));
    t.equal(events.length, 1);
    t.equal(events[0]!.data, 'real data');
  });

  it('unknown fields are ignored', async (t) => {
    const str = 'foo: bar\ndata: hello\nbaz: qux\n\n';
    const events = await collect(new EventSourceReader(source(str)));
    t.equal(events.length, 1);
    t.equal(events[0]!.data, 'hello');
  });

  it('field name only (no colon) has empty value', async (t) => {
    const events = await collect(new EventSourceReader(source('data\n\n')));
    t.equal(events.length, 1);
    t.equal(events[0]!.data, '');
  });

  it('events without data are not dispatched', async (t) => {
    const str = 'event: update\nid: 99\n\ndata: real\n\n';
    const events = await collect(new EventSourceReader(source(str)));
    t.equal(events.length, 1, 'only one event — the one with data');
    t.equal(events[0]!.data, 'real');
  });

  it('multiple events from one stream', async (t) => {
    const str = 'data: one\n\ndata: two\n\ndata: three\n\n';
    const events = await collect(new EventSourceReader(source(str)));
    t.equal(events.length, 3);
    t.equal(events[0]!.data, 'one');
    t.equal(events[1]!.data, 'two');
    t.equal(events[2]!.data, 'three');
  });

  it('LF line terminator', async (t) => {
    const events = await collect(new EventSourceReader(source('data: lf\n\n')));
    t.equal(events[0]!.data, 'lf');
  });

  it('CRLF line terminator', async (t) => {
    const events = await collect(new EventSourceReader(source('data: crlf\r\n\r\n')));
    t.equal(events[0]!.data, 'crlf');
  });

  it('bare CR line terminator', async (t) => {
    const events = await collect(new EventSourceReader(source('data: cr\r\r')));
    t.equal(events[0]!.data, 'cr');
  });

  it('mixed line terminators', async (t) => {
    const str = 'data: line1\r\ndata: line2\ndata: line3\r\r';
    const events = await collect(new EventSourceReader(source(str)));
    t.equal(events[0]!.data, 'line1\nline2\nline3');
  });

  it('stream ends without trailing blank line still dispatches', async (t) => {
    const events = await collect(new EventSourceReader(source('data: no-trailing-newline')));
    t.equal(events.length, 1);
    t.equal(events[0]!.data, 'no-trailing-newline');
  });

  it('leading space stripped from field value', async (t) => {
    const events = await collect(new EventSourceReader(source('data: hello\n\n')));
    t.equal(events[0]!.data, 'hello');
  });

  it('no space after colon — value starts immediately', async (t) => {
    const events = await collect(new EventSourceReader(source('data:hello\n\n')));
    t.equal(events[0]!.data, 'hello');
  });

  it('data split across many small chunks', async (t) => {
    const str = 'event: update\ndata: hello world\nid: 7\n\n';
    const events = await collect(new EventSourceReader(chunkedSource(str, 3)));
    t.equal(events.length, 1);
    t.equal(events[0]!.type, 'update');
    t.equal(events[0]!.data, 'hello world');
    t.equal(events[0]!.id, '7');
  });

  it('CRLF split across chunk boundary', async (t) => {
    const str = 'data: split-crlf\r\n\r\n';
    const events = await collect(new EventSourceReader(chunkedSource(str, 1)));
    t.equal(events.length, 1);
    t.equal(events[0]!.data, 'split-crlf');
  });

  it('empty data line preserved in multi-line', async (t) => {
    const events = await collect(new EventSourceReader(source('data: a\ndata:\ndata: b\n\n')));
    t.equal(events[0]!.data, 'a\n\nb');
  });
});

describe('EventSourceWriter', () => {
  it('basic event with data only', async (t) => {
    const w = mockWriter();
    await new EventSourceWriter(w).event({ data: 'hello' });
    t.equal(w.output(), 'data: hello\n\n');
  });

  it('event with all fields', async (t) => {
    const w = mockWriter();
    await new EventSourceWriter(w).event({ event: 'update', data: 'payload', id: '42', retry: 5000 });
    const out = w.output();
    t.ok(out.includes('event: update\n'), 'event field present');
    t.ok(out.includes('data: payload\n'), 'data field present');
    t.ok(out.includes('id: 42\n'), 'id field present');
    t.ok(out.includes('retry: 5000\n'), 'retry field present');
    t.ok(out.endsWith('\n\n'), 'blank line terminates event');
  });

  it('multi-line data split into separate lines', async (t) => {
    const w = mockWriter();
    await new EventSourceWriter(w).event({ data: 'line1\nline2\nline3' });
    t.equal(w.output(), 'data: line1\ndata: line2\ndata: line3\n\n');
  });

  it('omits optional fields when not provided', async (t) => {
    const w = mockWriter();
    await new EventSourceWriter(w).event({ data: 'x' });
    const out = w.output();
    t.ok(!out.includes('event:'), 'no event field');
    t.ok(!out.includes('id:'), 'no id field');
    t.ok(!out.includes('retry:'), 'no retry field');
  });

  it('comment writes colon-prefixed line with blank line', async (t) => {
    const w = mockWriter();
    await new EventSourceWriter(w).comment('keep-alive');
    t.equal(w.output(), ': keep-alive\n\n');
  });

  it('empty comment', async (t) => {
    const w = mockWriter();
    await new EventSourceWriter(w).comment();
    t.equal(w.output(), ': \n\n');
  });

  it('multi-line comment', async (t) => {
    const w = mockWriter();
    await new EventSourceWriter(w).comment('line1\nline2');
    t.equal(w.output(), ': line1\n: line2\n\n');
  });

  it('retry writes standalone retry field', async (t) => {
    const w = mockWriter();
    await new EventSourceWriter(w).retry(3000);
    t.equal(w.output(), 'retry: 3000\n\n');
  });

  it('round-trip — write then parse', async (t) => {
    const w = mockWriter();
    const esw = new EventSourceWriter(w);
    await esw.event({ event: 'ping', data: 'hello\nworld', id: '5', retry: 1000 });
    await esw.event({ data: 'second' });

    const events = await collect(new EventSourceReader(source(w.output())));
    t.equal(events.length, 2);
    t.equal(events[0]!.type, 'ping');
    t.equal(events[0]!.data, 'hello\nworld');
    t.equal(events[0]!.id, '5');
    t.equal(events[0]!.retry, 1000);
    t.equal(events[1]!.type, 'message');
    t.equal(events[1]!.data, 'second');
  });
});

describe('EventSource integration', () => {
  it('readyState constants', (t) => {
    t.equal(EventSource.CONNECTING, 0);
    t.equal(EventSource.OPEN, 1);
    t.equal(EventSource.CLOSED, 2);
  });

  it('receives message events via onmessage', async (t) => {
    const received: string[] = [];

    const server = serve({ port: 19960 }, async (_req) =>
      sseResponse(sseBody({ data: 'hello' }, { data: 'world' })),
    );

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19960/events');
      es.onmessage = (e) => {
        received.push(e.data);
        if (received.length >= 2) { es.close(); resolve(); }
      };
    });

    t.equal(received.length, 2);
    t.equal(received[0], 'hello');
    t.equal(received[1], 'world');

    await server.close();
  });

  it('onopen fires when connection established', async (t) => {
    let opened = false;

    const server = serve({ port: 19961 }, async (_req) =>
      sseResponse(sseBody({ data: 'trigger' })),
    );

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19961/events');
      es.onopen = () => { opened = true; };
      es.onmessage = () => { es.close(); resolve(); };
    });

    t.equal(opened, true, 'onopen fired before first message');

    await server.close();
  });

  it('readyState is OPEN while receiving events', async (t) => {
    let stateWhenOpen = -1;

    const server = serve({ port: 19962 }, async (_req) =>
      sseResponse(sseBody({ data: 'check' })),
    );

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19962/events');
      es.onmessage = () => {
        stateWhenOpen = es.readyState;
        es.close();
        resolve();
      };
    });

    t.equal(stateWhenOpen, EventSource.OPEN, 'readyState is OPEN during event dispatch');

    await server.close();
  });

  it('readyState is CLOSED after close()', async (t) => {
    const server = serve({ port: 19963 }, async (_req) =>
      sseResponse(sseBody({ data: 'x' })),
    );

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19963/events');
      es.onmessage = () => {
        es.close();
        t.equal(es.readyState, EventSource.CLOSED, 'readyState is CLOSED immediately after close()');
        resolve();
      };
    });

    await server.close();
  });

  it('addEventListener for named event type', async (t) => {
    const updateEvents: string[] = [];
    let messageCount = 0;

    const server = serve({ port: 19964 }, async (_req) =>
      sseResponse(sseBody(
        { event: 'update', data: 'payload' },
        { data: 'default-message' },
      )),
    );

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19964/events');
      es.addEventListener('update', (e) => { updateEvents.push((e as unknown as EventSourceMessage).data); });
      es.onmessage = () => { messageCount++; es.close(); resolve(); };
    });

    t.equal(updateEvents.length, 1, 'update listener fired once');
    t.equal(updateEvents[0], 'payload');
    t.equal(messageCount, 1, 'onmessage fired for default-type event');

    await server.close();
  });

  it('HTTP 204 closes without reconnecting', async (t) => {
    let errorFired = false;

    const server = serve({ port: 19965 }, async (_req) =>
      new Response(null, { status: 204 }),
    );

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19965/events');
      es.onerror = () => { errorFired = true; };
      loop.timeout(200).then(() => {
        t.equal(es.readyState, EventSource.CLOSED, 'CLOSED after 204');
        t.equal(errorFired, false, 'no error event on graceful 204 close');
        resolve();
      });
    });

    await server.close();
  });

  it('wrong content-type causes fatal error (no reconnect)', async (t) => {
    let errorCount = 0;

    const server = serve({ port: 19966 }, async (_req) =>
      new Response('not sse', { headers: { 'content-type': 'text/html' } }),
    );

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19966/events');
      es.onerror = () => {
        errorCount++;
        loop.timeout(150).then(resolve);
      };
    });

    t.equal(errorCount, 1, 'exactly one error event — no reconnect loop');

    await server.close();
  });

  it('Last-Event-ID sent on reconnect', async (t) => {
    const seenIds: Array<string | null> = [];
    let connectionCount = 0;

    let resolveReconnect: (() => void) | undefined;
    const reconnected = new Promise<void>((resolve) => { resolveReconnect = resolve; });

    const server = serve({ port: 19967 }, async (req) => {
      connectionCount++;
      const lastId = req.headers.get('last-event-id');
      seenIds.push(lastId);

      if (connectionCount === 1) {
        return sseResponse(sseBody({ retry: 50, id: '99', data: 'first' }));
      }
      resolveReconnect?.();
      return new Response(null, { status: 204 });
    });

    new EventSource('http://127.0.0.1:19967/events');
    await reconnected;
    await loop.timeout(50);

    t.equal(connectionCount, 2, 'exactly 2 connections (one reconnect)');
    t.equal(seenIds[0], null, 'no Last-Event-ID on first connection');
    t.equal(seenIds[1], '99', 'Last-Event-ID: 99 sent on reconnect');

    await server.close();
  });

  it('retry field from server updates reconnect interval', async (t) => {
    let received = null;

    const server = serve({ port: 19968 }, async (_req) =>
      sseResponse(sseBody('retry: 100\n', { data: 'after-retry' })),
    );

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19968/events');
      es.onmessage = (e) => { received = e.data; es.close(); resolve(); };
    });

    t.equal(received, 'after-retry', 'message received after retry field');

    await server.close();
  });

  it('MessageEvent has correct properties', async (t) => {
    let receivedEvent: EventSourceMessage | null = null;

    const server = serve({ port: 19969 }, async (_req) =>
      sseResponse(sseBody({ event: 'update', data: 'payload', id: '7' })),
    );

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19969/events');
      es.addEventListener('update', (e) => { receivedEvent = e as unknown as EventSourceMessage; es.close(); resolve(); });
    });

    t.ok(receivedEvent !== null, 'event received');
    const event = receivedEvent as unknown as EventSourceMessage;
    t.equal(event.type, 'update');
    t.equal(event.data, 'payload');
    t.equal(event.lastEventId, '7', 'lastEventId on MessageEvent');

    await server.close();
  });

  it('empty id: field sends Last-Event-ID with empty value on reconnect', async (t) => {
    // Regression for the lastEventId null-vs-empty-string fix.
    // An `id:` line with no value sets lastEventId to '' and must be sent as
    // `Last-Event-ID: ` (empty) on reconnect — not omitted as if no id was seen.
    const seenIds: Array<string | null> = [];
    let connectionCount = 0;
    let resolveReconnect!: () => void;
    const reconnected = new Promise<void>((r) => { resolveReconnect = r; });

    const server = serve({ port: 19971 }, async (req) => {
      connectionCount++;
      seenIds.push(req.headers.get('last-event-id'));
      if (connectionCount === 1) {
        // Send an event with an empty id: field, then close.
        return sseResponse(sseBody({ retry: 50, id: '', data: 'empty-id-event' }));
      }
      resolveReconnect();
      return new Response(null, { status: 204 });
    });

    new EventSource('http://127.0.0.1:19971/events');
    await reconnected;
    await loop.timeout(50);

    t.equal(seenIds[0], null, 'no Last-Event-ID on first connection');
    // After receiving an empty id:, the reconnect MUST include Last-Event-ID: ''
    t.equal(seenIds[1], '', 'Last-Event-ID with empty value sent on reconnect');

    await server.close();
  });

  it('follows local redirects with relative Location before opening the stream', async (t) => {
    const seenPaths: string[] = [];
    const server = serve({ port: 19972 }, async (req) => {
      const path = new URL(req.url).pathname;
      seenPaths.push(path);
      if (path === '/events') {
        return new Response(null, { status: 302, headers: { location: '/events-final' } });
      }
      return sseResponse(sseBody({ data: 'redirected' }));
    });

    let received = '';
    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19972/events');
      es.onmessage = (e) => { received = e.data; es.close(); resolve(); };
    });

    t.deepEqual(seenPaths, ['/events', '/events-final'], 'redirect is followed with a relative Location');
    t.equal(received, 'redirected', 'message received from redirected SSE endpoint');

    await server.close();
  });

  it('caps redirect loops and fails closed', async (t) => {
    let requests = 0;
    const server = serve({ port: 19973 }, async () => {
      requests++;
      return new Response(null, { status: 307, headers: { location: '/events' } });
    });

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19973/events');
      es.onerror = () => {
        t.equal(es.readyState, EventSource.CLOSED, 'redirect loop closes the EventSource');
        resolve();
      };
    });

    t.equal(requests, 21, 'redirect cap stops after the original request plus 20 redirects');

    await server.close();
  });

  it('sends explicit headers on the SSE request', async (t) => {
    let auth: string | null = null;
    let marker: string | null = null;
    const server = serve({ port: 19974 }, async (req) => {
      auth = req.headers.get('authorization');
      marker = req.headers.get('x-fino-test');
      return sseResponse(sseBody({ data: 'headers' }));
    });

    await new Promise<void>((resolve) => {
      const es = new EventSource('http://127.0.0.1:19974/events', {
        headers: { authorization: 'Bearer token', 'x-fino-test': 'yes' },
      });
      es.onmessage = () => { es.close(); resolve(); };
    });

    t.equal(auth, 'Bearer token', 'authorization header is sent explicitly');
    t.equal(marker, 'yes', 'custom header is sent explicitly');

    await server.close();
  });

  it('connects to HTTPS SSE with a fixture CA', { skip: skipTls }, async (t) => {
    const server = serve(
      { port: 19975, hostname: '127.0.0.1', tls: { cert: CERT_PATH, key: KEY_PATH } },
      async () => sseResponse(sseBody({ data: 'secure' })),
    );

    let received = '';
    await new Promise<void>((resolve) => {
      const es = new EventSource('https://localhost:19975/events', { tls: { ca: CERT_PATH } });
      es.onmessage = (e) => { received = e.data; es.close(); resolve(); };
    });

    t.equal(received, 'secure', 'HTTPS SSE message received with trusted fixture CA');

    await server.close();
  });
});
