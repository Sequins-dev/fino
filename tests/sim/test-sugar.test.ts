/**
 * fino:test/sim ties a cassette to the test that owns it: record once, then
 * replay and fail on divergence.
 */
import { describe, it } from 'fino:test/test';
import { simulated } from 'fino:test/sim';
import { DiskFileSystem } from 'fino:file';
const KV_GUEST = new URL('./fixtures/kv-guest.ts', import.meta.url).pathname;
const DIR = '/tmp/fino-sim-cassettes';
function world() {
  const store = new Map<string, unknown>();
  return {
    'app:kv': {
      get: async (k: unknown) => store.get(String(k)),
      set: async (k: unknown, v: unknown) => {
        store.set(String(k), v);
        return null;
      },
    },
  };
}
describe('fino:test/sim', () => {
  it('records on the first run and replays afterwards', async (t) => {
    const fs = new DiskFileSystem();
    const file = `${DIR}/record-replay.json`;
    // The cassette is the point of the test, so it must start absent: leaving a
    // previous run's file in place would silently test replay twice.
    try {
      await fs.unlink(file);
    } catch {}
    const first = await simulated(
      { name: 'record replay' },
      { entry: KV_GUEST, seed: 4, world: world(), cassetteDir: DIR, cassetteName: 'record-replay' },
    );
    t.ok(first.cassette !== undefined, 'first run recorded a cassette');
    const written = await fs.readFile(file);
    t.ok(written.byteLength > 0, 'cassette written to disk');
    // Second run: providers would answer differently if consulted.
    const second = await simulated(
      { name: 'record replay' },
      {
        entry: KV_GUEST,
        seed: 4,
        world: { 'app:kv': { get: async () => 'WRONG', set: async () => null } },
        cassetteDir: DIR,
        cassetteName: 'record-replay',
      },
    );
    t.deepEqual(second.result, first.result, 'second run replayed the recording');
    t.ok(second.cassette === undefined, 'replay does not re-record');
  });
  it('noCassette runs live every time', async (t) => {
    const report = await simulated(
      { name: 'no cassette' },
      { entry: KV_GUEST, seed: 4, world: world(), noCassette: true },
    );
    t.ok(report.cassette === undefined, 'no cassette produced');
    t.equal((report.result as { value: unknown }).value, 'hello', 'ran against the live world');
  });
});
