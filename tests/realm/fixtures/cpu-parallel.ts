/**
 * Fixture — runs four CPU-bound realms and reports overlap.
 *
 * Driven as a child process by tests/realm/reactor.test.ts with
 * FINO_REACTOR_THREADS set, because the reactor pool's thread count is fixed
 * for the life of a process and defaults to one.
 */
import { Realm } from 'fino:realm';

const entry = new URL('./cpu-spin.ts', import.meta.url).pathname;
const spinMs = 250;
const realms = Array.from({ length: 4 }, () => new Realm<(ms: number) => number>({ entry }));
const started = performance.now();
await Promise.all(realms.map((realm) => realm.call(spinMs)));
const elapsed = Math.round(performance.now() - started);
console.log(`elapsed=${elapsed} serial=${spinMs * realms.length}`);
