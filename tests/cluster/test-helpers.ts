import { leaveCluster, startCluster } from 'fino:cluster';
import * as loop from 'internal:runtime/loop';

const START_TIMEOUT_MS = 2_000;
const START_ATTEMPTS = 10;

function randomPort(): number {
  return 34_000 + Math.floor(Math.random() * 5_000);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timer = loop.timeout(ms);
  timer.unref();
  return Promise.race([
    promise,
    timer.then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]).finally(() => timer.cancel());
}

export async function startClusterOnAvailablePort(
  options: (port: number) => Parameters<typeof startCluster>[0],
  label = 'startCluster',
  timeoutMs = START_TIMEOUT_MS,
): Promise<number> {
  let collision: unknown;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const port = randomPort();
    try {
      await withTimeout(startCluster(options(port)), timeoutMs, label);
      return port;
    } catch (err) {
      await leaveCluster();
      if (!(err instanceof Error) || !/address already in use/i.test(err.message)) throw err;
      collision = err;
    }
  }
  throw collision;
}
