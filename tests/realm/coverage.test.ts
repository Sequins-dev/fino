/** Realm coverage channel integration tests. */
import { describe, it } from 'fino:test/test';
import { runCli, withTempProject } from '../commands/cli-test-helpers.ts';

describe('Realm coverage channel', () => {
  it('publishes child coverage before the Realm finishes', async (t) => {
    await withTempProject(
      {
        'worker.ts': 'export default function double(value: number) { return value * 2; }\n',
        'coverage-channel.test.ts': [
          "import { describe, it } from 'fino:test/test';",
          "import { EnvelopeKind } from 'internal:realm/envelope';",
          "import type { TransportObserver } from 'internal:realm/transport-port';",
          "import { Realm } from 'fino:realm';",
          "const entry = new URL('./worker.ts', import.meta.url).pathname;",
          "describe('child coverage transport', () => {",
          "  it('observes the coverage frame', async (t) => {",
          '    const realm = new Realm<(value: number) => number>({ entry });',
          '    const coverageFrames: number[] = [];',
          '    const port = realm.port as typeof realm.port & {',
          '      observe(observer: TransportObserver): () => void;',
          '    };',
          '    const stop = port.observe({',
          '      filter: (metadata) => metadata.kind === EnvelopeKind.Coverage,',
          '      next: (frame) => coverageFrames.push(frame.sequence),',
          '    });',
          '    try {',
          "      t.equal(await realm.call(21), 42, 'child returns its result');",
          '      await realm.run();',
          '    } finally {',
          '      stop();',
          '    }',
          "    t.equal(coverageFrames.length, 1, 'child publishes one coverage frame');",
          '  });',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const run = await runCli(
          ['test', `--coverage=${dir}/coverage.json`, `${dir}/coverage-channel.test.ts`],
          { cwd: dir },
        );
        t.equal(run.result.code, 0, 'coverage-enabled child publishes before shutdown');
        t.equal(run.stderr, '', 'coverage transport does not write stderr');
      },
    );
  });

  it('retains simulation coverage through child shutdown', async (t) => {
    await withTempProject(
      {
        'worker.ts': 'export default function double(value: number) { return value * 2; }\n',
        'simulation.test.ts': [
          "import { describe, it } from 'fino:test/test';",
          "import { simulate } from 'fino:sim';",
          "const entry = new URL('./worker.ts', import.meta.url).pathname;",
          "describe('simulation coverage', () => {",
          "  it('runs the simulated guest', async (t) => {",
          '    const report = await simulate<number>({ entry, args: [21] });',
          "    t.equal(report.result, 42, 'simulation returns its result');",
          '  });',
          '});',
          '',
        ].join('\n'),
      },
      async (dir, fs) => {
        const run = await runCli(
          ['test', `--coverage=${dir}/coverage.json`, `${dir}/simulation.test.ts`],
          { cwd: dir },
        );
        t.equal(run.result.code, 0, 'coverage-enabled simulation exits successfully');
        const artifact = JSON.parse(
          (await fs.readFile(`${dir}/coverage.json`)) as unknown as string,
        ) as { realms: Array<{ entry: string | null; status: string }> };
        const simulated = artifact.realms.find((realm) => realm.entry === 'internal:sim/guest');
        t.equal(simulated?.status, 'complete', 'simulation submits its final coverage shard');
      },
    );
  });
});
