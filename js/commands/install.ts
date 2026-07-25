/**
* fino:commands/install — reusable `fino install` command task.
*
* Builds the `fino install` command as a `Task` so the same logic can be
* mounted as a subcommand of the root CLI, parsed standalone, or invoked
* programmatically. The heavy lifting is delegated to the internal package
* manager, which resolves npm package specs, downloads and integrity-checks
* tarballs, extracts each package under `.fino/packages`, and writes the
* `.fino/package-map.json` consumed by the module loader at import time.
*
* Positional arguments are npm-style specs — `name` or `name@range` (scoped
* names like `@scope/pkg@^1.2.0` work too). When specs are given they are
* recorded in the project's `package.json` `dependencies` before resolution,
* creating a minimal manifest if none exists. With no specs the command
* reinstalls whatever the existing `package.json` already declares across its
* `dependencies`, `devDependencies`, and `optionalDependencies` groups.
*
* Packages come from the registry named by the `FINO_NPM_REGISTRY` environment
* variable, defaulting to the public npm registry.
*
* ```ts no_run
* import installCommand from 'fino:commands/install';
*
* // Add a package and regenerate the package map:
* await installCommand.parse(['left-pad@^1.3.0']);
*
* // Reinstall everything package.json already declares:
* await installCommand.parse([]);
* ```
*
*/
import { Task } from '../task.ts';
import { installPackages } from '../internal/package_manager.ts';
/**
* The `install` subcommand used by the root Fino CLI.
*
* Positional package specs are optional. When present, each spec is added to
* the project's `package.json` `dependencies` before the installer resolves
* the full dependency graph and writes the `.fino` package map — a
* `name@range` spec records the requested range, while a bare `name` is
* pinned to the exact version that resolution selects. With no specs, it
* installs the dependencies the current project already declares.
*
* Resolution walks transitive `dependencies` and `optionalDependencies`; a
* failing optional dependency downgrades to a warning instead of aborting,
* and peer dependencies are never installed automatically — each one produces
* a warning naming the package that expects it.
*
* In text mode the task resolves to an empty string on success. With `--json`
* it writes and returns a structured result of the shape
* `{ command: 'install', ok: true, packages }`, where `packages` lists the
* specs that were passed (empty when reinstalling declared dependencies).
*
* Throws if no specs are given and `package.json` does not exist, or if
* resolution, download, integrity verification, or extraction fails for a
* required package.
*
* ```ts no_run
* import install from 'fino:commands/install';
*
* // Add a scoped package at a specific range:
* await install.parse(['@scope/pkg@^1.2.0']);
*
* // Machine-readable output for tooling:
* const result = await install.parse(['--json', 'left-pad']);
* ```
*
*/
const command = new Task({
  name: 'install',
  description: 'Install npm packages into .fino and generate a package map',
  outputMode: 'both',
  run: async function runInstallCommand(input: {
    packages?: unknown[];
  }, ctx) {
    const packages = Array.isArray(input.packages) ? input.packages.map(String) : undefined;
    await installPackages(packages);
    if (ctx.writer.mode === 'json') {
      const result = {
        command: 'install',
        ok: true,
        packages: packages ?? []
      };
      await ctx.writer.writeJson(result);
      return result;
    }
    return '';
  },
  cli: { positionals: [{
    name: 'packages',
    type: 'string',
    multiple: true,
    description: 'Packages to add to package.json before installing'
  }] }
});
export { command as default };
