import {
  getTracerProvider,
} from 'fino:opentelemetry';
import { argv } from 'fino:process';

if (argv[1] !== '--test' && argv[1] !== 'test') {
  globalThis.fetch = async function otelCliFetch(url) {
    console.log(`export:${String(url)}`);
    return new Response('{}', { status: 200 });
  };
}

const tracer = getTracerProvider().getTracer('cli.live', '1.0.0');
const span = tracer.startSpan('live-span');
span.end();

await new Promise((resolve) => setTimeout(resolve, 1200));
console.log('still-running');
