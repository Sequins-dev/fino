import {
  getLoggerProvider,
  getMeterProvider,
  getTracerProvider,
  runWithActiveSpan,
} from 'fino:opentelemetry';
import { argv } from 'fino:process';

if (argv[1] !== '--test' && argv[1] !== 'test') {
  globalThis.fetch = async function otelEntrypointFetch(url) {
    console.log(`export:${String(url)}`);
    const options = arguments[1] || {};
    const text = typeof options.body?.text === 'function'
      ? await options.body.text()
      : typeof options.body === 'string'
        ? options.body
        : options.body instanceof Uint8Array
          ? new TextDecoder().decode(options.body)
          : new TextDecoder().decode(await (async () => {
              if (!options.body) return new Uint8Array(0);
              const parts = [];
              let total = 0;
              for await (const chunk of options.body) {
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
            })());
    console.log(text);
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
