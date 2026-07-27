import { leaveCluster, startCluster } from 'fino:cluster';
import * as loop from 'internal:runtime/loop';

const START_TIMEOUT_MS = 2_000;
const START_ATTEMPTS = 10;

function randomPort(): number {
  return 34_000 + Math.floor(Math.random() * 5_000);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    loop.timeout(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

export async function startClusterOnAvailablePort(
  options: (port: number) => Parameters<typeof startCluster>[0],
  label = 'startCluster',
): Promise<number> {
  let collision: unknown;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const port = randomPort();
    try {
      await withTimeout(startCluster(options(port)), START_TIMEOUT_MS, label);
      return port;
    } catch (err) {
      leaveCluster();
      if (!(err instanceof Error) || !/address already in use/i.test(err.message)) throw err;
      collision = err;
    }
  }
  throw collision;
}
