import { getRealmData } from 'internal:realm-bridge';
import { getLoggerProvider, getMeterProvider, getTracerProvider } from 'fino:opentelemetry';
import { port } from 'fino:realm/self';

const realmPort = (
  globalThis as {
    realmPort?: {
      postMessage(message: unknown): void;
    };
  }
).realmPort;
const activePort = port ?? realmPort;
if (activePort === undefined) {
  throw new Error('cli-otel-realm-child: expected a child messaging port');
}

// Child logs may arrive after a parent lifecycle marker. Attribute exports by
// Realm identity rather than their position in the combined stdout stream.
const { label } = JSON.parse(getRealmData()!);
if (!['inherited', 'override', 'disabled'].includes(label))
  throw new Error('missing OTEL fixture label');

globalThis.fetch = async function otelRealmChildFetch(url) {
  // Exercise shutdown exports that complete after the old 20ms parent grace.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  console.log(`child-export:${label}:${String(url)}`);
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
