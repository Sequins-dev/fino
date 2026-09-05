import { ping, tail } from 'app:latency';

export default async function observeFacadeLatency(): Promise<{
  random: number;
  elapsed: number;
  order: string[];
  chunkTimes: number[];
}> {
  const random = Math.random();
  const started = Date.now();
  await ping();
  const elapsed = Date.now() - started;

  const order: string[] = [];
  const timer = new Promise<void>((resolve) => {
    setTimeout(() => {
      order.push('timer');
      resolve();
    }, 10);
  });
  const response = ping().then(() => {
    order.push('response');
  });
  await Promise.all([timer, response]);

  const streamStarted = Date.now();
  const chunkTimes: number[] = [];
  for await (const _chunk of tail()) chunkTimes.push(Date.now() - streamStarted);
  return { random, elapsed, order, chunkTimes };
}
