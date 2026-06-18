import {
  getMeterProvider,
} from 'fino:opentelemetry';
import { argv } from 'fino:process';

if (argv[1] !== 'test') {
  globalThis.fetch = async function otelCliFetch(url) {
    console.log(`export:${String(url)}`);
    return new Response('{}', { status: 200 });
  };
}

const meter = getMeterProvider().getMeter('cli.live.metric', '1.0.0');
const counter = meter.createCounter('cli.live.metric.counter', { unit: '1' });
counter.add(1, { source: 'cli-live-metric' });

await new Promise((resolve) => setTimeout(resolve, 1200));
console.log('still-running');
