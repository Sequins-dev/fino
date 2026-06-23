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
