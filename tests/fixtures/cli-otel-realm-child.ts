import { getLoggerProvider, getMeterProvider, getTracerProvider } from 'fino:opentelemetry';
import { port } from 'fino:realm/self';
const realmPort = (globalThis as {
  realmPort?: {
    postMessage(message: unknown): void;
  };
}).realmPort;
const activePort = port ?? realmPort;
if (activePort === undefined) {
  throw new Error('cli-otel-realm-child: expected a child messaging port');
}
globalThis.fetch = async function otelRealmChildFetch(url) {
  console.log(`child-export:${String(url)}`);
  return new Response('{}', { status: 200 });
};
const tracer = getTracerProvider().getTracer('cli.realm.child', '1.0.0');
const logger = getLoggerProvider().getLogger('cli.realm.child', '1.0.0');
const meter = getMeterProvider().getMeter('cli.realm.child', '1.0.0');
const counter = meter.createCounter('cli.realm.child.counter', { unit: '1' });
const span = tracer.startSpan('realm-child-span');
logger.info('realm-child-log');
counter.add(1);
span.end();
activePort.postMessage({ type: 'done' });
