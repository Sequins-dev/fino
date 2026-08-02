/**
 * The test runner has to fail when a test file cannot run.
 *
 * A test file that failed to load reported nothing and exited zero, and it silenced
 * every other file in the same invocation — so a single bad import turned a whole suite
 * green while executing none of it. Nothing catches that but a check of the runner
 * itself, because by construction the broken file reports success.
 *
 * Each case runs `fino test` in a child process against a fixture under
 * `tests/fixtures/failing-tests/`. They are named `.fixture.ts` rather than `.test.ts` so
 * the suite's own glob does not collect files whose entire purpose is to fail.
 */
import { describe, it } from 'fino:test/test';
import { Process, execPath } from 'fino:process';

const decoder = new TextDecoder();

/** Run `fino test` over the given paths and collect what it reported. */
async function runTests(...paths: string[]): Promise<{ code: number; output: string }> {
  const proc = new Process(execPath, ['test', ...paths]);
  proc.stdin.close();
  const chunks: Uint8Array[] = [];
  for await (const chunk of proc.stdout) chunks.push(chunk);
  for await (const chunk of proc.stderr) chunks.push(chunk);
  const result = await proc.wait();
  return {
    code: result.code ?? -1,
    output: chunks.map((chunk) => decoder.decode(chunk)).join(''),
  };
}

const FIXTURES = 'tests/fixtures/failing-tests';

describe('test runner failures', () => {
  it('fails when a test file cannot be imported', async (t) => {
    const { code, output } = await runTests(`${FIXTURES}/bad-import.fixture.ts`);
    t.ok(code !== 0, `exits non-zero (got ${code})`);
    t.ok(
      output.includes('no-such-module-exists'),
      'names the specifier it could not resolve',
    );
  });

  it('names the file that could not be imported', async (t) => {
    const { output } = await runTests(`${FIXTURES}/bad-import.fixture.ts`);
    t.ok(
      output.includes('bad-import.fixture.ts'),
      'names the importer, so the file is findable without a bisect',
    );
  });

  it('fails when a test file throws a falsy value', async (t) => {
    // `throw undefined` is legal, and the runner used the error value as its own
    // "did it fail" flag — so this exact case reported success.
    const { code } = await runTests(`${FIXTURES}/throws-undefined.fixture.ts`);
    t.ok(code !== 0, `exits non-zero (got ${code})`);
  });

  it('does not let one broken file silence the rest', async (t) => {
    const { code } = await runTests(
      `${FIXTURES}/bad-import.fixture.ts`,
      `${FIXTURES}/passing.fixture.ts`,
    );
    t.ok(code !== 0, `a run containing a broken file fails (got ${code})`);
  });

  it('still passes a file that is fine', async (t) => {
    const { code, output } = await runTests(`${FIXTURES}/passing.fixture.ts`);
    t.equal(code, 0, 'exits zero');
    // Reported as run rather than merely not failing: a runner that executes nothing
    // also exits zero, which is the whole problem these cases exist for.
    t.ok(output.includes('# pass  1'), 'and reports the assertion it ran');
  });

  it('fails when nothing matches, rather than passing vacuously', async (t) => {
    const { code } = await runTests(`${FIXTURES}/no-such-file-*.fixture.ts`);
    t.ok(code !== 0, `exits non-zero (got ${code})`);
  });
});
