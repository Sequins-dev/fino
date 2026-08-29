/** CLI task integration tests. */
import { describe, it } from 'fino:test/test';
import { runCli, withTempProject } from './cli-test-helpers.ts';

describe('CLI commands: task', () => {
  it('runs tasks loaded from a project tasks directory', async (t) => {
    await withTempProject(
      {
        'tasks/build.ts': [
          "import { task } from 'fino:task';",
          'export default task({',
          "  name: 'build',",
          "  cli: { options: [{ flags: '--name', type: 'string', required: true }] },",
          '  run: async (input, ctx) => {',
          '    await ctx.writer.writeText(`build:${input.name}\\n`);',
          '  }',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', 'build', '--name', 'Ada'], {
          cwd: dir,
        });
        t.equal(result.code, 0, 'project task exits successfully');
        t.equal(stderr, '', 'project task does not write stderr');
        t.ok(stdout.includes('build:Ada'), 'project task wrote expected output');
      },
    );
  });
  it('runs every CLI command inside a process-reactor workload', async (t) => {
    await withTempProject(
      {
        'tasks/location.ts': [
          "import { task } from 'fino:task';",
          "import { currentWorkloadOwner, usesProcessReadiness } from 'internal:scheduler-native';",
          'export default task({',
          "  name: 'location',",
          '  run: async (_input, ctx) => {',
          "    const leaked = Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('__fino'));",
          '    await ctx.writer.writeText(',
          '      `reactor:${usesProcessReadiness()}:${currentWorkloadOwner() > 0}:${leaked.length}\\n`,',
          '    );',
          '  }',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', 'location'], { cwd: dir });
        t.equal(result.code, 0, 'project task exits successfully');
        t.equal(stderr, '', 'project task does not write stderr');
        t.ok(
          stdout.includes('reactor:true:true:0'),
          'project task uses host-owned scheduler state without leaking globals',
        );
      },
    );
  });
  it('loads multiple task files as sibling commands', async (t) => {
    await withTempProject(
      {
        'tasks/build.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'build', run: async (_input, ctx) => ctx.writer.writeText('build\\n') });",
          '',
        ].join('\n'),
        'tasks/deploy.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'deploy', run: async (_input, ctx) => ctx.writer.writeText('deploy\\n') });",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', 'deploy'], { cwd: dir });
        t.equal(result.code, 0, 'second task exits successfully');
        t.equal(stderr, '', 'second task does not write stderr');
        t.ok(stdout.includes('deploy'), 'second task was loaded as a sibling command');
      },
    );
  });
  it('prints help for loaded project tasks', async (t) => {
    await withTempProject(
      {
        'tasks/build.ts': [
          "import { task } from 'fino:task';",
          'export default task({',
          "  name: 'build',",
          "  description: 'Build the application',",
          "  cli: { options: [{ flags: '--watch', type: 'boolean', description: 'Watch files' }] },",
          '  run: async () => undefined',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const rootHelp = await runCli(['task', '--help'], { cwd: dir });
        t.equal(rootHelp.result.code, 0, 'task root help exits successfully');
        t.equal(rootHelp.stderr, '', 'task root help does not write stderr');
        t.ok(rootHelp.stdout.includes('Usage: fino task'), 'task root help shows delegated usage');
        t.ok(rootHelp.stdout.includes('build'), 'task root help lists project task');
        const childHelp = await runCli(['task', 'build', '--help'], { cwd: dir });
        t.equal(childHelp.result.code, 0, 'task child help exits successfully');
        t.equal(childHelp.stderr, '', 'task child help does not write stderr');
        t.ok(
          childHelp.stdout.includes('Usage: fino task build'),
          'task child help shows child usage',
        );
        t.ok(childHelp.stdout.includes('--watch'), 'task child help lists child option');
      },
    );
  });
  it('passes JSON output mode to loaded project tasks', async (t) => {
    await withTempProject(
      {
        'tasks/inspect.ts': [
          "import { task } from 'fino:task';",
          'export default task({',
          "  name: 'inspect',",
          "  outputMode: 'both',",
          '  run: async (_input, ctx) => {',
          "    if (ctx.writer.mode === 'json') {",
          "      await ctx.writer.writeJson({ ok: true, task: 'inspect' });",
          '      return;',
          '    }',
          "    await ctx.writer.writeText('inspect\\n');",
          '  }',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', '--json', 'inspect'], {
          cwd: dir,
        });
        t.equal(result.code, 0, 'json project task exits successfully');
        t.equal(stderr, '', 'json project task does not write stderr');
        t.ok(stdout.includes('"task":"inspect"'), 'project task wrote JSON through shared writer');
      },
    );
  });
  it('loads tasks from a custom directory', async (t) => {
    await withTempProject(
      {
        'custom/deploy.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'deploy', run: async (_input, ctx) => ctx.writer.writeText('custom-deploy\\n') });",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', '--dir', 'custom', 'deploy'], {
          cwd: dir,
        });
        t.equal(result.code, 0, 'custom-directory task exits successfully');
        t.equal(stderr, '', 'custom-directory task does not write stderr');
        t.ok(stdout.includes('custom-deploy'), 'task was loaded from custom directory');
      },
    );
  });
  it('reports task directory loading errors clearly', async (t) => {
    await withTempProject(
      {
        'empty/.keep': '',
        'invalid/bad.ts': "export default { name: 'bad' };\n",
        'duplicate/a.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'same', run: async () => undefined });",
          '',
        ].join('\n'),
        'duplicate/b.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'same', run: async () => undefined });",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const missing = await runCli(['task'], { cwd: dir });
        t.equal(missing.result.code, 1, 'missing tasks directory exits nonzero');
        t.ok(
          missing.stderr.includes('no tasks directory found'),
          'missing directory error names the issue',
        );
        const empty = await runCli(['task', '--dir', 'empty'], { cwd: dir });
        t.equal(empty.result.code, 1, 'empty tasks directory exits nonzero');
        t.ok(empty.stderr.includes('no task files found'), 'empty directory error names the issue');
        const invalid = await runCli(['task', '--dir', 'invalid'], { cwd: dir });
        t.equal(invalid.result.code, 1, 'invalid task export exits nonzero');
        t.ok(invalid.stderr.includes('bad.ts'), 'invalid export error names the file');
        t.ok(
          invalid.stderr.includes('default-export a Task'),
          'invalid export error explains the contract',
        );
        const duplicate = await runCli(['task', '--dir', 'duplicate'], { cwd: dir });
        t.equal(duplicate.result.code, 1, 'duplicate task names exit nonzero');
        t.ok(
          duplicate.stderr.includes('Duplicate task "same"'),
          'duplicate task error names the task',
        );
      },
    );
  });
});
