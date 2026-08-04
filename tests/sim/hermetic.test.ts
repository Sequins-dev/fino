/**
 * Things a simulated realm must refuse because they cannot be replayed.
 */
import { describe, it } from 'fino:test/test';
import { simulate } from 'fino:sim';
import { ImportMap, Realm } from 'fino:realm';
const SAB_GUEST = new URL('./fixtures/shared-memory-guest.ts', import.meta.url).pathname;
const AMBIENT_IO_GUEST = new URL('./fixtures/ambient-io-probe.ts', import.meta.url).pathname;
describe('hermetic guarantees', () => {
  it('closes ambient network APIs unless a simulation facade serves them', async (t) => {
    const report = await simulate({ entry: AMBIENT_IO_GUEST, seed: 1 });
    t.deepEqual(report.result, [], 'no ambient network path reached the host');
  });
  it('refuses shared memory, which is written outside the simulation', async (t) => {
    const report = await simulate({ entry: SAB_GUEST, seed: 1 });
    t.ok(
      /SharedArrayBuffer is unavailable/.test(report.result as string),
      `guest was refused shared memory: ${String(report.result)}`,
    );
  });
  it('leaves SharedArrayBuffer alone outside a simulation', async (t) => {
    const realm = new Realm<() => Promise<string>>({
      overrides: ImportMap.deny([{ pattern: 'internal:runtime/loop', directive: 'inherit' }]),
      entry: SAB_GUEST,
    });
    const result = await realm.call();
    t.equal(result, 'allocated 64', 'an ordinary realm still has shared memory');
  });
  it('rejects remote simulation instead of widening the cluster protocol', (t) => {
    t.throws(
      () =>
        new Realm({
          entry: SAB_GUEST,
          remote: true,
          sim: { seed: 1 },
        }),
      /sim is not supported with remote/,
      'remote simulation is explicitly out of scope',
    );
  });
});
