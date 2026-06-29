import { getLoggerProvider } from 'fino:opentelemetry';
import { argv } from 'fino:process';
if (argv[1] !== 'test') {
  globalThis.fetch = async function otelCliFetch(url) {
    console.log(`export:${String(url)}`);
    return new Response('{}', { status: 200 });
  };
}
const logger = getLoggerProvider().getLogger('cli.live.log', '1.0.0');
logger.info('live-log-message', { source: 'cli-live-log' });
await new Promise((resolve) => setTimeout(resolve, 80));
console.log('still-running');
