/**
 * internal/commands/install — internal runtime module.
 *
 * Builds the `fino install` command. The command lazily loads the internal
 * package manager so normal CLI startup does not pay the installer cost unless
 * installation is requested.
 *
 * ```js
 * import { createInstallCommand } from 'internal:commands/install';
 * const command = createInstallCommand();
 * console.log(command.name);
 * ```
 *
 * @internal
 */

import { Command, type CommandContext } from '../../process/argv.mts';
import { installPackages } from '../package_manager.mts';

/**
 * Create the `install` subcommand used by the root Fino CLI.
 *
 * Positional package names are optional. When present, the installer adds them
 * to `package.json` before resolving dependencies and writing the `.fino`
 * package map. With no packages, it installs the dependencies already declared
 * by the current project. The command returns an empty string on success and
 * lets installer failures propagate as errors.
 *
 * ```js
 * import { createInstallCommand } from 'internal:commands/install';
 * const install = createInstallCommand();
 * await install.parse(['@scope/pkg@^1.2.0']);
 * ```
 *
 * @returns A configured `Command` instance for `fino install`.
 * @internal
 */
export function createInstallCommand(): Command {
  return new Command({
    name: 'install',
    description: 'Install npm packages into .fino and generate a package map',
    run: async function runInstallCommand(ctx: CommandContext) {
      const packages = Array.isArray(ctx.args.packages) ? ctx.args.packages.map(String) : undefined;
      await installPackages(packages);
      return '';
    },
    positionals: [
      { name: 'packages', type: 'string', multiple: true, description: 'Packages to add to package.json before installing' },
    ],
  });
}
