/**
 * Realm fixture — burns CPU for a fixed wall-clock duration.
 *
 * Deliberately busy rather than sleeping: a timer would be satisfied by the
 * process reactor regardless of how many threads the pool has, so it would not
 * distinguish parallel execution from interleaved execution.
 */
import { port } from 'fino:realm/self';

port?.postMessage('ready');

export default function cpuSpin(ms: number): number {
  const end = performance.now() + ms;
  let iterations = 0;
  while (performance.now() < end) iterations++;
  return iterations;
}
