/** Measures facade round trips against the virtual clock, and their ordering
 * relative to a timer scheduled before the call. */
import { ping, tail } from 'app:api';
export default async function main(): Promise<{
  elapsed: number[];
  order: string[];
  chunks: string[];
  chunkTimes: number[];
}> {
  const elapsed: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    await ping();
    elapsed.push(Date.now() - start);
  }
  const order: string[] = [];
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      order.push('timer-50');
      resolve();
    }, 50),
  );
  const call = ping().then(() => {
    order.push('response');
  });
  await Promise.all([timer, call]);
  const chunks: string[] = [];
  const chunkTimes: number[] = [];
  const streamStart = Date.now();
  for await (const chunk of tail()) {
    chunks.push(String(chunk));
    chunkTimes.push(Date.now() - streamStart);
  }
  return { elapsed, order, chunks, chunkTimes };
}
