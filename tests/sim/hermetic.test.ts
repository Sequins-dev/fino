/** Hermetic boundaries of the public simulation harness. */
import { describe, it } from 'fino:test/test';
import { simulate } from 'fino:sim';

const AMBIENT_ESCAPE_PROBE = new URL('./fixtures/ambient-escape-probe.ts', import.meta.url)
  .pathname;
const UNDECLARED_IMPORT_PROBE = new URL('./fixtures/undeclared-import-probe.ts', import.meta.url)
  .pathname;

describe('simulation hermeticity', { exclusive: true }, () => {
  it('rejects ambient capabilities that bypass Facades and the journal', async (t) => {
    const report = await simulate({ entry: AMBIENT_ESCAPE_PROBE, seed: 'hermetic' });
    const results = report.result as Record<string, string>;

    t.match(results.fetch, /fetch requires a Facade at fino:net\/fetch/);
    for (const name of [
      'WebSocket',
      'WebTransport',
      'EventSource',
      'BroadcastChannel',
      'SharedArrayBuffer',
    ]) {
      t.equal(results[name], `fino:sim — ${name} is unavailable in a simulation`);
    }
  });

  it('blocks undeclared host modules by default', async (t) => {
    const report = await simulate({ entry: UNDECLARED_IMPORT_PROBE });
    t.deepEqual(report.result, [], 'filesystem, process, and nested Realm imports stay blocked');
  });
});
