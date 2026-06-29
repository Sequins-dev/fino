import {
  getLoggerProvider,
  getMeterProvider,
  getTracerProvider,
  runWithActiveSpan,
} from 'fino:opentelemetry';

if (getTracerProvider() && getLoggerProvider() && getMeterProvider()) {
  console.log('dependency providers ready');
}

export async function runDependency(): Promise<void> {
  const tracer = getTracerProvider().getTracer('cli.dependency', '1.0.0');
  const logger = getLoggerProvider().getLogger('cli.dependency', '1.0.0');
  const meter = getMeterProvider().getMeter('cli.dependency', '1.0.0');
  const counter = meter.createCounter('dependency.counter', { unit: '1' });
  const span = tracer.startSpan('dependency-work');

  await runWithActiveSpan(span, async () => {
    logger.info('dependency log', { source: 'dependency' });
    counter.add(1, { source: 'dependency' });
  });

  span.end();
}
