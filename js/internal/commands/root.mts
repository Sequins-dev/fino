/**
 * internal/commands/root — internal runtime module.
 *
 * 
 * @internal
 */

import { Command } from '../../process/argv.mts';
import { createTestCommand } from './test.mts';
import { createBenchCommand } from './bench.mts';
import { createInstallCommand } from './install.mts';
import { createInitCommand } from './init.mts';
import { createDocCommand } from './doc.mts';
import { createReplCommand, runReplCommand } from './repl.mts';
import { createRunCommand, runScriptCommand } from './run.mts';

export function createRootCommand(): Command {
  return new Command({
    name: 'fino',
    description: 'Fino runtime CLI',
    options: [
      {
        flags: '--otlp-endpoint',
        type: 'string',
        description: 'Enable OpenTelemetry export to the given OTLP/HTTP collector endpoint',
      },
      {
        flags: '--watch',
        type: 'boolean',
        description: 'Re-run the script whenever any imported file changes',
      },
    ],
    run: async function runRootCommand(ctx) {
      const script = ctx.args.script;
      if (script === undefined) return runReplCommand();
      return runScriptCommand(ctx);
    },
    positionals: [
      { name: 'script', type: 'string', description: 'Script module to execute' },
    ],
    commands: [
      createRunCommand(),
      createTestCommand(),
      createBenchCommand(),
      createInstallCommand(),
      createInitCommand(),
      createDocCommand(),
      createReplCommand(),
    ],
  });
}
