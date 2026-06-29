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

import { Task } from '../../task.ts';
import { installPackages } from '../package_manager.ts';

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
 * @returns A configured `Task` instance for `fino install`.
 * @internal
 */
export function createInstallCommand(): Task {
  return new Task({
    name: 'install',
    description: 'Install npm packages into .fino and generate a package map',
    outputMode: 'both',
    run: async function runInstallCommand(input: { packages?: unknown[] }, ctx) {
      const packages = Array.isArray(input.packages) ? input.packages.map(String) : undefined;
      await installPackages(packages);
      if (ctx.writer.mode === 'json') {
        const result = { command: 'install', ok: true, packages: packages ?? [] };
        await ctx.writer.writeJson(result);
        return result;
      }
      return '';
    },
    cli: {
      positionals: [
        { name: 'packages', type: 'string', multiple: true, description: 'Packages to add to package.json before installing' },
      ],
    },
  });
}
