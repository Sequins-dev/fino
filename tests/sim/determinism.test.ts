/**
 * The determinism kernel: virtual clock, seeded randomness, virtual timers.
 */
import { describe, it } from 'fino:test/test';
import { ImportMap, Realm } from 'fino:realm';
import type probeFn from './fixtures/determinism-probe.ts';
const PROBE = new URL('./fixtures/determinism-probe.ts', import.meta.url).pathname;
const START = 1_700_000_000_000;
function simRealm(seed: number | string) {
  return new Realm<typeof probeFn>({
    overrides: ImportMap.deny([{ pattern: 'internal:runtime/loop', directive: 'inherit' }]),
    entry: PROBE,
    sim: { seed, startTime: START },
  });
}
describe('deterministic simulation realm', () => {
  it('clock starts at the configured instant and timers run in virtual time', async (t) => {
    const report = await simRealm(1).call();
    t.equal(report.dateNow, START, 'Date.now is the simulated start time');
    t.equal(report.dateCtor, START, 'new Date() reads the virtual clock too');
    t.equal(report.perfOrigin, START, 'performance.timeOrigin is virtual');
    t.deepEqual(
      report.timerOrder,
      ['a-100', 'b-200', 'c-300', 'day'],
      'timers fire in deadline order regardless of scheduling order',
    );
    t.equal(report.longTimerElapsed, 86_400_000, 'a full day of virtual time elapsed');
    t.ok(report.unseededCryptoRejected, 'OpenSSL entropy cannot escape the seeded source');
  });
  it('the same seed produces byte-identical results', async (t) => {
    const first = await simRealm(42).call();
    const second = await simRealm(42).call();
    t.deepEqual(second, first, 'two runs with seed 42 agree on everything');
  });
  it('a different seed produces different randomness', async (t) => {
    const a = await simRealm(42).call();
    const b = await simRealm(43).call();
    t.ok(a.randoms[0] !== b.randoms[0], 'Math.random differs by seed');
    t.ok(a.uuid !== b.uuid, 'randomUUID differs by seed');
    t.deepEqual(a.dateNow, b.dateNow, 'but the clock does not depend on the seed');
  });
  it('string seeds are reproducible', async (t) => {
    const a = await simRealm('checkout-flow').call();
    const b = await simRealm('checkout-flow').call();
    t.deepEqual(a.randoms, b.randoms, 'named seed reproduces');
  });
  it('a non-simulated realm keeps real time and real entropy', async (t) => {
    const realm = new Realm<typeof probeFn>({
      overrides: ImportMap.deny([{ pattern: 'internal:runtime/loop', directive: 'inherit' }]),
      entry: PROBE,
    });
    const before = Date.now();
    const report = await realm.call(5);
    t.ok(report.dateNow >= before, 'real clock, not the simulated instant');
    t.ok(report.longTimerElapsed < 60_000, 'elapsed is real wall time, not virtual');
  });
});
