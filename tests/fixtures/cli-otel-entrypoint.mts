import {
  getLoggerProvider,
  getMeterProvider,
  getTracerProvider,
  runWithActiveSpan,
} from 'fino:opentelemetry';
import { decompress } from 'fino:compress';
import { argv } from 'fino:process';

function headerValue(headers, key) {
  return headers?.[key] || headers?.[key.toLowerCase()] || headers?.[key.toUpperCase()] || '';
}

async function bodyBytes(body) {
  if (!body) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body.text === 'function') return new TextEncoder().encode(await body.text());
  const parts = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    parts.push(bytes);
    total += bytes.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

if (argv[1] !== 'test') {
  globalThis.fetch = async function otelEntrypointFetch(url) {
    console.log(`export:${String(url)}`);
    const options = arguments[1] || {};
    const headers = options.headers && typeof options.headers[Symbol.iterator] === 'function'
      ? Object.fromEntries(options.headers)
      : options.headers || {};
    console.log(JSON.stringify(headers));
    const bytes = await bodyBytes(options.body);
    const decoded = headerValue(headers, 'content-encoding') === 'gzip'
      ? decompress(bytes, { format: 'gzip' })
      : bytes;
    console.log(new TextDecoder().decode(decoded));
    return new Response('{}', { status: 200 });
  };
}

const tracer = getTracerProvider().getTracer('cli.entrypoint', '1.0.0');
const logger = getLoggerProvider().getLogger('cli.entrypoint', '1.0.0');
const meter = getMeterProvider().getMeter('cli.entrypoint', '1.0.0');
const counter = meter.createCounter('cli.entrypoint.counter', { unit: '1' });
const span = tracer.startSpan('entrypoint-span');

await runWithActiveSpan(span, async () => {
  logger.info('entrypoint-log', { source: 'entrypoint' });
  counter.add(1, { source: 'entrypoint' });
});

span.end();

await new Promise((resolve) => setTimeout(resolve, 1200));
console.log('entrypoint-finished');
