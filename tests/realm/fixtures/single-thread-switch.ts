/**
 * Fixture — repeatedly switches reactor-pooled realms on one worker.
 *
 * The parent test pins FINO_REACTOR_THREADS to one. Every child waits on a
 * timer, forcing the sole worker to exit its isolate before entering another.
 */
import { Realm } from 'fino:realm';
import type asyncFn from './async-fn.ts';

const entry = new URL('./async-fn.ts', import.meta.url).pathname;
const width = 4;
const rounds = 3;

for (let round = 0; round < rounds; round++) {
  const realms = Array.from({ length: width }, () => new Realm<typeof asyncFn>({ entry }));
  const inputs = realms.map((_, index) => round * width + index);
  const results = await Promise.all(realms.map((realm, index) => realm.call(inputs[index])));
  const expected = inputs.map((input) => input * 2);
  if (results.some((result, index) => result !== expected[index])) {
    throw new Error(`realm switch mismatch: ${JSON.stringify({ results, expected })}`);
  }
}

console.log(`switches=${width * rounds}`);
