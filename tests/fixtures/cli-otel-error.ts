import {
  getTracerProvider,
} from 'fino:opentelemetry';
import { argv } from 'fino:process';

if (argv[1] !== 'test') {
  globalThis.fetch = async function otelCliFetch() {
    throw new Error('collector offline');
  };
}

const tracer = getTracerProvider().getTracer('cli.error', '1.0.0');
const span = tracer.startSpan('error-work');
span.end();
