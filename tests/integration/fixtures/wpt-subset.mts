export interface WptFixture {
  path: string;
  area: string;
  source: string;
}

export const WPT_SUBSET: WptFixture[] = [
  {
    path: 'url/urlsearchparams-sort.any.js',
    area: 'URL/URLSearchParams',
    source: `
test(() => {
  const params = new URLSearchParams('z=1&a=2&a=1');
  params.sort();
  assert_equals(params.toString(), 'a=2&a=1&z=1');
}, 'URLSearchParams sort is stable and orders by name');

test(() => {
  const url = new URL('../b?x=1#f', 'https://example.test/a/c');
  assert_equals(url.href, 'https://example.test/b?x=1#f');
}, 'URL resolves relative path dot segments');

test(() => {
  assert_true(URL.canParse('/path', 'https://example.test'));
  assert_false(URL.canParse('/path', 'not-a-url'));
  assert_equals(URL.parse('/path', 'https://example.test/base').href, 'https://example.test/path');
  assert_equals(URL.parse('not a url'), null);
}, 'URL static parse helpers accept valid input and reject invalid input');

test(() => {
  const params = new URLSearchParams('a=1&b=2');
  assert_array_equals([...params.keys()], ['a', 'b']);
  assert_array_equals([...params.values()], ['1', '2']);
  assert_array_equals([...params.entries()].map(([name, value]) => name + '=' + value), ['a=1', 'b=2']);
}, 'URLSearchParams iterates keys values and entries in insertion order');
`,
  },
  {
    path: 'url/urlpattern-basic.any.js',
    area: 'URLPattern',
    source: `
test(() => {
  const pattern = new URLPattern({ hostname: 'example.com', pathname: '/users/:id' });
  assert_true(pattern.test('https://example.com/users/42'));
  assert_false(pattern.test('https://example.com/posts/42'));
}, 'URLPattern test matches object pattern components');

test(() => {
  const pattern = new URLPattern({ pathname: '/users/:id' });
  const result = pattern.exec('/users/42', 'https://example.test');
  assert_true(result !== null);
  assert_equals(result.pathname.input, '/users/42');
  assert_equals(result.pathname.groups.id, '42');
  assert_array_equals(result.inputs, ['/users/42', 'https://example.test']);
}, 'URLPattern exec resolves relative input against baseURL');
`,
  },
  {
    path: 'encoding/textencoder-textdecoder.any.js',
    area: 'Encoding UTF-8',
    source: `
test(() => {
  const bytes = new TextEncoder().encode('\\u00e9');
  assert_array_equals(Array.from(bytes), [0xc3, 0xa9]);
}, 'TextEncoder emits UTF-8 bytes');

test(() => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xf0, 0x9f, 0x9a, 0x80]));
  assert_equals(text, '\\ud83d\\ude80');
}, 'TextDecoder decodes valid four byte UTF-8');
`,
  },
  {
    path: 'html/webappapis/structured-clone/structured-clone.any.js',
    area: 'DOMException/structuredClone/base64',
    source: `
test(() => {
  const err = new DOMException('failed', 'NetworkError');
  assert_equals(err.name, 'NetworkError');
  assert_equals(err.message, 'failed');
}, 'DOMException exposes name and message');

test(() => {
  const original = { nested: { value: 1 }, items: ['a', 'b'] };
  const clone = structuredClone(original);
  assert_array_equals(clone.items, ['a', 'b']);
  clone.nested.value = 2;
  assert_equals(original.nested.value, 1);
}, 'structuredClone copies nested ordinary objects');

test(() => {
  assert_equals(atob('SGVsbG8='), 'Hello');
  assert_equals(btoa('Hello'), 'SGVsbG8=');
}, 'atob and btoa roundtrip ASCII bytes');
`,
  },
  {
    path: 'dom/abort/abort-signal.any.js',
    area: 'AbortController/AbortSignal',
    source: `
test(() => {
  const controller = new AbortController();
  assert_false(controller.signal.aborted);
  controller.abort('done');
  assert_true(controller.signal.aborted);
  assert_equals(controller.signal.reason, 'done');
}, 'AbortController aborts its signal with reason');

test(() => {
  const first = new AbortController();
  const second = new AbortController();
  const signal = AbortSignal.any([first.signal, second.signal]);
  second.abort('second');
  assert_true(signal.aborted);
  assert_equals(signal.reason, 'second');
  first.abort('first');
  assert_equals(signal.reason, 'second');
}, 'AbortSignal.any uses first abort reason');

test(() => {
  const reason = new Error('stop');
  const signal = AbortSignal.abort(reason);
  assert_throws_js(Error, () => signal.throwIfAborted());
}, 'AbortSignal.throwIfAborted throws abort reason');
`,
  },
  {
    path: 'fetch/api/basic/request-response.any.js',
    area: 'Headers/Request/Response',
    source: `
test(() => {
  const headers = new Headers([['Content-Type', 'text/plain'], ['X-Test', 'a']]);
  headers.append('x-test', 'b');
  assert_equals(headers.get('content-type'), 'text/plain');
  assert_equals(headers.get('X-Test'), 'a, b');
}, 'Headers normalizes names and combines appended values');

test(() => {
  const request = new Request('https://example.test/path', {
    method: 'POST',
    body: 'payload',
    headers: { 'content-type': 'text/plain' },
  });
  assert_equals(request.method, 'POST');
  assert_equals(request.url, 'https://example.test/path');
  assert_equals(request.headers.get('content-type'), 'text/plain');
}, 'Request stores method URL headers and body metadata');

promise_test(async () => {
  const response = Response.json({ ok: true }, { status: 201, headers: { 'x-test': 'yes' } });
  assert_equals(response.status, 201);
  assert_equals(response.headers.get('content-type'), 'application/json');
  assert_equals(response.headers.get('x-test'), 'yes');
  assert_equals((await response.json()).ok, true);
}, 'Response.json creates a JSON response body');

promise_test(async () => {
  const request = new Request('https://example.test/', { method: 'POST', body: 'request-body' });
  const copy = request.clone();
  assert_false(request.bodyUsed);
  assert_equals(await request.text(), 'request-body');
  assert_true(request.bodyUsed);
  assert_equals(await copy.text(), 'request-body');
}, 'Request clone preserves body before consumption');

promise_test(async () => {
  const response = new Response('response-body', { headers: { 'content-type': 'text/plain' } });
  const copy = response.clone();
  assert_false(response.bodyUsed);
  assert_equals(await response.text(), 'response-body');
  assert_true(response.bodyUsed);
  assert_equals(await copy.text(), 'response-body');
}, 'Response clone preserves body before consumption');

test(() => {
  const redirected = Response.redirect('https://example.test/login', 303);
  assert_equals(redirected.status, 303);
  assert_equals(redirected.headers.get('location'), 'https://example.test/login');
  assert_throws_js(RangeError, () => Response.redirect('https://example.test/', 200));
}, 'Response.redirect validates redirect status values');
`,
  },
  {
    path: 'fetch/api/basic/fetch.any.js',
    area: 'fetch',
    source: `
promise_test(async () => {
  const response = await fetch(new URL('/fetch-json', __wpt.httpUrl), {
    headers: { 'x-wpt-test': 'fetch' },
  });
  assert_true(response.ok);
  assert_equals(response.headers.get('x-wpt-response'), 'ok');
  const body = await response.json();
  assert_equals(body.method, 'GET');
  assert_equals(body.header, 'fetch');
}, 'fetch resolves loopback HTTP response with headers and JSON body');
`,
  },
  {
    path: 'streams/readable-streams/pipe-through.any.js',
    area: 'Streams',
    source: `
promise_test(async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue('a');
      controller.enqueue('b');
      controller.close();
    },
  }).pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk.toUpperCase());
    },
  }));
  const reader = stream.getReader();
  const first = await reader.read();
  const second = await reader.read();
  const done = await reader.read();
  assert_equals(first.value, 'A');
  assert_equals(second.value, 'B');
  assert_true(done.done);
}, 'ReadableStream pipeThrough applies TransformStream');
`,
  },
  {
    path: 'streams/constructors/queuing-strategies.any.js',
    area: 'Stream constructors/controllers',
    source: `
test(() => {
  const count = new CountQueuingStrategy({ highWaterMark: 4 });
  const bytes = new ByteLengthQueuingStrategy({ highWaterMark: 8 });
  assert_equals(count.highWaterMark, 4);
  assert_equals(count.size('chunk'), 1);
  assert_equals(bytes.highWaterMark, 8);
  assert_equals(bytes.size(new Uint8Array(3)), 3);
}, 'Queuing strategies expose highWaterMark and size algorithms');

promise_test(async () => {
  let writableController;
  const writable = new WritableStream({
    start(controller) {
      writableController = controller;
    },
  });
  assert_true(writableController instanceof WritableStreamDefaultController);
  const writer = writable.getWriter();
  assert_true(writer instanceof WritableStreamDefaultWriter);
  await writer.close();
}, 'WritableStream exposes default controller and writer types');

test(() => {
  let readableController;
  const readable = new ReadableStream({
    start(controller) {
      readableController = controller;
      controller.close();
    },
  });
  assert_true(readableController instanceof ReadableStreamDefaultController);
  assert_true(readable.getReader() instanceof ReadableStreamDefaultReader);
}, 'ReadableStream exposes default controller and reader types');
`,
  },
  {
    path: 'dom/events/EventTarget.any.js',
    area: 'Abort/EventTarget',
    source: `
test(() => {
  const target = new EventTarget();
  const controller = new AbortController();
  let count = 0;
  target.addEventListener('x', () => count++, { signal: controller.signal });
  controller.abort();
  target.dispatchEvent(new Event('x'));
  assert_equals(count, 0);
}, 'AbortSignal removes EventTarget listener');

test(() => {
  const target = new EventTarget();
  let count = 0;
  target.addEventListener('x', () => count++, { once: true });
  target.dispatchEvent(new Event('x'));
  target.dispatchEvent(new Event('x'));
  assert_equals(count, 1);
}, 'EventTarget once listener fires once');
`,
  },
  {
    path: 'dom/events/Event-constructor.any.js',
    area: 'Event/CustomEvent',
    source: `
test(() => {
  const event = new Event('submit', { bubbles: true, cancelable: true, composed: true });
  assert_equals(event.type, 'submit');
  assert_true(event.bubbles);
  assert_true(event.cancelable);
  assert_true(event.composed);
  assert_false(event.defaultPrevented);
  event.preventDefault();
  assert_true(event.defaultPrevented);
}, 'Event constructor initializes flags and preventDefault state');

test(() => {
  assert_equals(Event.NONE, 0);
  assert_equals(Event.CAPTURING_PHASE, 1);
  assert_equals(Event.AT_TARGET, 2);
  assert_equals(Event.BUBBLING_PHASE, 3);
}, 'Event exposes phase constants');

test(() => {
  const event = new CustomEvent('update', { detail: { id: 5 } });
  assert_true(event instanceof Event);
  assert_true(event instanceof CustomEvent);
  assert_equals(event.type, 'update');
  assert_equals(event.detail.id, 5);
}, 'CustomEvent stores detail and inherits from Event');

test(() => {
  const target = new EventTarget();
  const event = new Event('x');
  let observedTarget = null;
  let observedCurrentTarget = null;
  let observedPhase = 0;
  target.addEventListener('x', (ev) => {
    observedTarget = ev.target;
    observedCurrentTarget = ev.currentTarget;
    observedPhase = ev.eventPhase;
    assert_array_equals(ev.composedPath(), [target]);
  });
  assert_true(target.dispatchEvent(event));
  assert_equals(observedTarget, target);
  assert_equals(observedCurrentTarget, target);
  assert_equals(observedPhase, Event.AT_TARGET);
  assert_equals(event.currentTarget, null);
}, 'EventTarget dispatch sets target currentTarget eventPhase and composedPath');
`,
  },
  {
    path: 'html/webappapis/timers/timers-and-microtasks.any.js',
    area: 'Timers/queueMicrotask/performance',
    source: `
promise_test(async () => {
  const order = [];
  const timeout = new Promise((resolve) => setTimeout(() => {
    order.push('timeout');
    resolve(undefined);
  }, 0));
  queueMicrotask(() => order.push('microtask'));
  await timeout;
  assert_array_equals(order, ['microtask', 'timeout']);
}, 'queueMicrotask runs before a zero delay timer task');

promise_test(async () => {
  let count = 0;
  const id = setInterval(() => {
    count++;
    clearInterval(id);
  }, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert_equals(count, 1);
}, 'clearInterval stops an interval');

test(() => {
  const before = performance.now();
  const after = performance.now();
  assert_true(after >= before);
}, 'performance.now is monotonic within a realm');
`,
  },
  {
    path: 'streams/readable-byte-streams/byob-reader.any.js',
    area: 'Readable byte streams/BYOB',
    source: `
promise_test(async () => {
  let controller;
  const stream = new ReadableStream({
    type: 'bytes',
    start(ctrl) {
      controller = ctrl;
      ctrl.enqueue(new Uint8Array([1, 2, 3]));
      ctrl.close();
    },
  });
  assert_true(controller instanceof ReadableByteStreamController);
  const reader = stream.getReader({ mode: 'byob' });
  assert_true(reader instanceof ReadableStreamBYOBReader);
  const result = await reader.read(new Uint8Array(3));
  assert_false(result.done);
  assert_array_equals(Array.from(result.value), [1, 2, 3]);
  reader.releaseLock();
}, 'ReadableStreamBYOBReader reads queued byte stream data');

promise_test(async () => {
  let request = null;
  const stream = new ReadableStream({
    type: 'bytes',
    pull(controller) {
      request = controller.byobRequest;
      assert_true(request instanceof ReadableStreamBYOBRequest);
      new Uint8Array(request.view.buffer, request.view.byteOffset, 2).set([8, 9]);
      request.respond(2);
      controller.close();
    },
  });
  const reader = stream.getReader({ mode: 'byob' });
  const result = await reader.read(new Uint8Array(2));
  assert_false(result.done);
  assert_array_equals(Array.from(result.value), [8, 9]);
  assert_true(request instanceof ReadableStreamBYOBRequest);
  reader.releaseLock();
}, 'ReadableStreamBYOBRequest responds to pending BYOB reads');
`,
  },
  {
    path: 'FileAPI/blob/Blob-text.any.js',
    area: 'Blob/File/FormData',
    source: `
promise_test(async () => {
  const blob = new Blob(['hello'], { type: 'text/plain' });
  assert_equals(blob.size, 5);
  assert_equals(blob.type, 'text/plain');
  assert_equals(await blob.text(), 'hello');
}, 'Blob exposes size type and text');

test(() => {
  const file = new File(['abc'], 'data.txt', { type: 'text/plain' });
  assert_equals(file.name, 'data.txt');
  assert_equals(file.size, 3);
  assert_equals(file.type, 'text/plain');
}, 'File exposes name size and type');

test(() => {
  const form = new FormData();
  form.append('a', '1');
  form.append('a', '2');
  assert_array_equals(form.getAll('a'), ['1', '2']);
}, 'FormData preserves duplicate names');

promise_test(async () => {
  const blob = new Blob(['abcdef'], { type: 'TEXT/PLAIN' });
  const slice = blob.slice(1, 4, 'text/custom');
  assert_equals(slice.size, 3);
  assert_equals(slice.type, 'text/custom');
  assert_equals(await slice.text(), 'bcd');
  const bytes = await blob.bytes();
  bytes[0] = 0xff;
  assert_equals(new Uint8Array(await blob.arrayBuffer())[0], 97);
}, 'Blob slice returns bytes and Blob reads return copies');

promise_test(async () => {
  const chunks = [];
  for await (const chunk of new Blob(['abc']).stream()) {
    chunks.push(...Array.from(chunk));
  }
  assert_array_equals(chunks, [97, 98, 99]);
}, 'Blob stream yields blob bytes');

test(() => {
  const file = new File(['x'], 'data.txt', { type: 'Text/Plain', lastModified: 1234 });
  assert_true(file instanceof Blob);
  assert_equals(file.name, 'data.txt');
  assert_equals(file.type, 'text/plain');
  assert_equals(file.lastModified, 1234);
}, 'File inherits Blob and exposes file metadata');

test(() => {
  const form = new FormData();
  const blob = new Blob(['data'], { type: 'text/plain' });
  form.append('file', blob, 'upload.txt');
  form.append('field', 'value');
  const file = form.get('file');
  assert_true(file instanceof File);
  assert_equals(file.name, 'upload.txt');
  assert_array_equals([...form.keys()], ['file', 'field']);
  assert_array_equals([...form.entries()].map(([name]) => name), ['file', 'field']);
}, 'FormData wraps Blob values as File and iterates entries');
`,
  },
  {
    path: 'WebCryptoAPI/crypto-basic.any.js',
    area: 'crypto',
    source: `
test(() => {
  assert_equals(typeof crypto, 'object');
  assert_equals(typeof crypto.subtle, 'object');
  assert_equals(typeof cryptoAvailable, 'boolean');
}, 'crypto global and availability flag are exposed');

promise_test(async () => {
  if (!cryptoAvailable) {
    assert_throws_js(Error, () => crypto.getRandomValues(new Uint8Array(1)));
    return;
  }
  const bytes = new Uint8Array(16);
  const returned = crypto.getRandomValues(bytes);
  assert_equals(returned, bytes);
  assert_true(bytes.some((byte) => byte !== 0));
  assert_true(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
  const hex = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert_equals(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
}, 'crypto random values UUID and SHA-256 digest work when OpenSSL is available');
`,
  },
  {
    path: 'html/webappapis/global-object.any.js',
    area: 'self/navigator',
    source: `
test(() => {
  assert_equals(self, globalThis);
}, 'self aliases globalThis');

test(() => {
  assert_equals(typeof navigator, 'object');
  assert_equals(navigator.userAgent, 'Fino/0.1');
}, 'navigator exposes the runtime userAgent');

test(() => {
  assert_equals(typeof console, 'object');
  assert_equals(typeof console.log, 'function');
  assert_equals(typeof console.error, 'function');
  console.log('wpt-subset console smoke');
  console.error('wpt-subset console smoke');
}, 'console exposes logging functions');

test(() => {
  assert_equals(typeof tlsAvailable, 'boolean');
}, 'tlsAvailable exposes TLS backend availability');
`,
  },
  {
    path: 'html/webappapis/channel-messaging/message-channel.any.js',
    area: 'MessageEvent/MessageChannel/MessagePort/BroadcastChannel',
    source: `
test(() => {
  const event = new MessageEvent('message', { data: { ok: true }, origin: 'https://example.test' });
  assert_equals(event.type, 'message');
  assert_equals(event.data.ok, true);
  assert_equals(event.origin, 'https://example.test');
}, 'MessageEvent exposes data and origin');

promise_test(async () => {
  const channel = new MessageChannel();
  const received = __wpt.event(channel.port1, 'message');
  channel.port1.start();
  channel.port2.postMessage({ value: 7 });
  const event = await received;
  assert_equals(event.data.value, 7);
  channel.port1.close();
  channel.port2.close();
}, 'MessageChannel delivers a posted message');

promise_test(async () => {
  const name = 'wpt-subset-' + Math.random();
  const sender = new BroadcastChannel(name);
  const receiver = new BroadcastChannel(name);
  const received = __wpt.event(receiver, 'message');
  sender.postMessage('hello');
  const event = await received;
  assert_equals(event.data, 'hello');
  sender.close();
  receiver.close();
}, 'BroadcastChannel delivers to another channel with the same name');
`,
  },
  {
    path: 'eventsource/eventsource-basic.any.js',
    area: 'EventSource',
    source: `
promise_test(async () => {
  const source = new EventSource(new URL('/events', __wpt.httpUrl));
  assert_equals(source.readyState, EventSource.CONNECTING);
  const open = await __wpt.event(source, 'open');
  assert_equals(open.type, 'open');
  assert_equals(source.readyState, EventSource.OPEN);
  const message = await __wpt.event(source, 'update');
  assert_equals(message.data, 'hello');
  assert_equals(message.lastEventId, '7');
  source.close();
  assert_equals(source.readyState, EventSource.CLOSED);
}, 'EventSource opens an SSE stream and dispatches named events');
`,
  },
  {
    path: 'compression/compression-stream-gzip.any.js',
    area: 'CompressionStream',
    source: `
promise_test(async () => {
  const encoded = new TextEncoder().encode('gzip data');
  const compressed = await __wpt.collect(new Response(encoded).body.pipeThrough(new CompressionStream('gzip')));
  const decompressed = await __wpt.collect(new Response(compressed).body.pipeThrough(new DecompressionStream('gzip')));
  assert_equals(new TextDecoder().decode(decompressed), 'gzip data');
}, 'CompressionStream gzip roundtrips through DecompressionStream');

promise_test(async () => {
  const encoded = new TextEncoder().encode('deflate data');
  const compressed = await __wpt.collect(new Response(encoded).body.pipeThrough(new CompressionStream('deflate')));
  const decompressed = await __wpt.collect(new Response(compressed).body.pipeThrough(new DecompressionStream('deflate')));
  assert_equals(new TextDecoder().decode(decompressed), 'deflate data');
}, 'CompressionStream deflate roundtrips through DecompressionStream');

promise_test(async () => {
  const encoded = new TextEncoder().encode('raw deflate data');
  const compressed = await __wpt.collect(new Response(encoded).body.pipeThrough(new CompressionStream('deflate-raw')));
  const decompressed = await __wpt.collect(new Response(compressed).body.pipeThrough(new DecompressionStream('deflate-raw')));
  assert_equals(new TextDecoder().decode(decompressed), 'raw deflate data');
}, 'CompressionStream deflate-raw roundtrips through DecompressionStream');

test(() => {
  assert_throws_js(TypeError, () => new CompressionStream('brotli'));
  assert_throws_js(TypeError, () => new DecompressionStream('brotli'));
}, 'CompressionStream and DecompressionStream reject unsupported formats');
`,
  },
  {
    path: 'webtransport/webtransport-constructor.any.js',
    area: 'WebTransport',
    source: `
test(() => {
  assert_equals(typeof WebTransport, 'function');
  assert_throws_js(TypeError, () => new WebTransport('http://example.test/session'));
}, 'WebTransport constructor requires an https URL');

promise_test(async () => {
  const transport = WebTransport.unavailable('https://example.test/session', 'not available in WPT subset');
  assert_equals(transport.url, 'https://example.test/session');
  assert_equals(transport.responseHeaders, null);
  assert_equals(transport.protocol, '');
  assert_equals(transport.reliability, 'supports-unreliable');
  assert_equals(transport.congestionControl, 'default');
  assert_equals(transport.supportsReliableOnly, false);
  let rejected = false;
  try {
    await transport.ready;
  } catch (error) {
    rejected = error instanceof Error && /not available/.test(error.message);
  }
  assert_true(rejected);
}, 'WebTransport exposes failed transport state when HTTP/3 is unavailable');
`,
  },
  {
    path: 'websockets/interfaces/WebSocket/events.any.js',
    area: 'WebSocket client/API',
    source: `
test(() => {
  const close = new CloseEvent('close', { code: 1000, reason: 'done', wasClean: true });
  assert_true(close instanceof Event);
  assert_equals(close.type, 'close');
  assert_equals(close.code, 1000);
  assert_equals(close.reason, 'done');
  assert_true(close.wasClean);
}, 'CloseEvent exposes close code reason and cleanliness');

test(() => {
  const err = new Error('boom');
  const event = new ErrorEvent('error', { error: err });
  assert_true(event instanceof Event);
  assert_equals(event.type, 'error');
  assert_equals(event.error, err);
}, 'ErrorEvent exposes the underlying error');

test(() => {
  assert_equals(WebSocket.CONNECTING, 0);
  assert_equals(WebSocket.OPEN, 1);
  assert_equals(WebSocket.CLOSING, 2);
  assert_equals(WebSocket.CLOSED, 3);
}, 'WebSocket exposes readyState constants');

promise_test(async () => {
  const ws = new WebSocket(__wpt.wsUrl);
  assert_equals(ws.readyState, WebSocket.CONNECTING);
  await __wpt.event(ws, 'open');
  assert_equals(ws.readyState, WebSocket.OPEN);
  ws.close(1000, 'done');
  const close = await __wpt.event(ws, 'close');
  assert_equals(close.code, 1000);
}, 'WebSocket readyState transitions and close event');

promise_test(async () => {
  const ws = new WebSocket(__wpt.wsUrl);
  await __wpt.event(ws, 'open');
  ws.send('hello');
  const message = await __wpt.event(ws, 'message');
  assert_equals(message.data, 'hello');
  ws.close();
  await __wpt.event(ws, 'close');
}, 'WebSocket sends and receives text');
`,
  },
];
