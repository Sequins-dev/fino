import { getLoggerProvider, getMeterProvider, getTracerProvider, runWithActiveSpan } from 'fino:opentelemetry';
import { argv } from 'fino:process';
if (argv[1] !== 'test') {
  globalThis.fetch = async function otelCliFetch(url) {
    console.log(String(url));
    console.log(String(arguments[1]?.headers?.['content-type'] || ''));
    return new Response('{}', { status: 200 });
  };
}
await new Promise((resolve) => setTimeout(resolve, 0));
const tracer = getTracerProvider().getTracer('cli.async', '1.0.0');
const logger = getLoggerProvider().getLogger('cli.async', '1.0.0');
const meter = getMeterProvider().getMeter('cli.async', '1.0.0');
const counter = meter.createCounter('async.counter', { unit: '1' });
const span = tracer.startSpan('async-work');
await runWithActiveSpan(span, async () => {
  logger.info('async log', { source: 'async' });
  counter.add(1, { source: 'async' });
});
span.end();
