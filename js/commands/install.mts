import { Command, type CommandContext } from '../util/argv.mts';

export function createInstallCommand(): Command {
  return new Command({
    name: 'install',
    description: 'Install npm packages into .fino and generate a package map',
    run: async function runInstallCommand(ctx: CommandContext) {
      const { installPackages } = await import('../internal/package_manager.mts');
      const packages = Array.isArray(ctx.args.packages) ? ctx.args.packages.map(String) : undefined;
      await installPackages(packages);
      return '';
    },
    positionals: [
      { name: 'packages', type: 'string', multiple: true, description: 'Packages to add to package.json before installing' },
    ],
  });
}
