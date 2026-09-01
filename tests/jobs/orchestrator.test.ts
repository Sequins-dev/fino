/**
 * End-to-end test for fino:jobs client mode: an app script run under the
 * orchestrator uses the injected control facade, with inline processing,
 * durable signals, and an orchestrator-hosted worker pool.
 */
import { describe, it } from 'fino:test/test';
import { Process, execPath } from 'fino:process';
import { sqliteAvailable } from 'fino:database/sqlite';
import { env, exit } from 'fino:process';

if (!sqliteAvailable) {
  if (env.FINO_REQUIRE_SQLITE === '1') throw new Error('sqlite required but unavailable');
  console.log('SKIP: sqlite unavailable');
  exit(0);
}

async function readAll(stream: {
  read(
    max: number,
  ): Promise<
    { done: false; value: ArrayBuffer | ArrayBufferView } | { done: true; value: undefined }
  >;
}): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const result = await stream.read(65536);
    if (result.done) break;
    out += decoder.decode(result.value, { stream: true });
  }
  return out;
}

describe('fino:jobs under the orchestrator', () => {
  it('client mode round-trips inline, durable, and pool jobs', async (t) => {
    const script = new URL('./fixtures/client-app.ts', import.meta.url).pathname;
    const dbPath = `/tmp/fino-jobs-e2e-${Math.floor(Math.random() * 1e9)}.db`;
    const proc = new Process(execPath, [script, dbPath]);
    const [stdout, stderr, result] = await Promise.all([
      readAll(proc.stdout),
      readAll(proc.stderr),
      proc.wait(),
    ]);
    t.equal(result.code, 0, `app exited cleanly (stderr: ${stderr.slice(0, 400)})`);
    t.ok(stdout.includes('double:42'), `inline job ran via the control facade (stdout: ${stdout})`);
    t.ok(stdout.includes('gate:true'), 'durable signal round-tripped through the facade store');
    t.ok(stdout.includes('pool:8'), 'orchestrator-hosted pool executed the job');
  });
});
