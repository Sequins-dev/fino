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
