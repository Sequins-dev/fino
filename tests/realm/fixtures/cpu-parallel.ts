/**
 * Fixture — runs four CPU-bound realms and reports overlap.
 *
 * Driven as a child process by tests/realm/reactor.test.ts with
 * FINO_REACTOR_THREADS set, because the reactor pool's thread count is fixed
 * for the life of a process. Every Realm signals after bootstrap so the timing
 * window measures CPU execution rather than isolate initialization.
 */
import { Realm } from 'fino:realm';

const entry = new URL('./cpu-spin.ts', import.meta.url).pathname;
const spinMs = 250;
const realms = Array.from({ length: 4 }, () => new Realm<(ms: number) => number>({ entry }));
await Promise.all(
  realms.map(
    (realm) =>
      new Promise<void>((resolve) => {
        const onMessage = (event: MessageEvent): void => {
          if (event.data !== 'ready') return;
          realm.port.removeEventListener('message', onMessage);
          resolve();
        };
        realm.port.addEventListener('message', onMessage);
        realm.port.start();
      }),
  ),
);
const started = performance.now();
await Promise.all(realms.map((realm) => realm.call(spinMs)));
const elapsed = Math.round(performance.now() - started);
console.log(`elapsed=${elapsed} serial=${spinMs * realms.length}`);
