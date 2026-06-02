/**
 * internal/commands/bench — internal runtime module.
 *
 * 
 * @internal
 */

import { cwd } from '../../process.mts';
import { Command, type CommandContext } from '../../process/argv.mts';

function normalizeModuleSpecifier(path: string): string {
  if (path.startsWith('file://')) return path;
  if (path.startsWith('/')) return `file://${path}`;
  if (path.startsWith('./') || path.startsWith('../')) return `file://${cwd()}/${path}`;
  if (path.includes(':')) return path;
  return `file://${cwd()}/./${path}`;
}

export function createBenchCommand(): Command {
  return new Command({
    name: 'bench',
    description: 'Run benchmark files',
    run: async function runBenchCommand(ctx: CommandContext) {
      const benchFiles = Array.isArray(ctx.args.files) ? ctx.args.files : [];
      const filter = typeof ctx.options.filter === 'string' ? ctx.options.filter : undefined;
      if (benchFiles.length === 0) {
        throw new Error('fino bench: no benchmark files specified');
      }

      for (const file of benchFiles) await import(normalizeModuleSpecifier(String(file)));
      const { run } = await import('fino:bench');
      return filter === undefined ? run({}) : run({ filter });
    },
    options: [
      { flags: '--filter', type: 'string', description: 'Run only benchmark groups whose full path contains the filter text' },
    ],
    positionals: [
      { name: 'files', type: 'string', multiple: true, required: true, description: 'Benchmark files to import and run' },
    ],
  });
}
