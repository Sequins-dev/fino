import { startCluster, type StartClusterOptions } from 'fino:cluster';
import * as loop from 'internal:runtime/loop';

const START_TIMEOUT_MS = 2_000;

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

export function startClusterOnAvailablePort(
  options: Omit<StartClusterOptions, 'port'>,
  label = 'startCluster',
  timeoutMs = START_TIMEOUT_MS,
): Promise<number> {
  return withTimeout(startCluster({ ...options, port: 0 }), timeoutMs, label);
}
