/**
* fino:commands/init — reusable `fino init` command task.
*
* Builds the `fino init` command, which scaffolds a `package.json` in the
* current working directory. Defaults are derived from the environment where
* possible: the package name comes from the directory basename (falling back
* to `fino-app`), the author from `git config user.name` / `user.email`, and
* the repository from `git config remote.origin.url`. Git lookups fail soft —
* a missing `git` binary or unset config simply yields an empty default.
*
* When the command runs on an interactive terminal, each field that was not
* passed explicitly as a flag is confirmed through a prompt; `--yes` accepts
* all defaults without prompting, and non-interactive contexts behave as if
* `--yes` were set. The generated manifest always includes `type: "module"` —
* fino packages are ESM-only.
*
* An existing `package.json` is never overwritten unless `--force` is passed.
* Package names are validated against the npm-style form
* `@scope/name` / `name` (lowercase letters, digits, dots, underscores,
* hyphens); an invalid name aborts the command before anything is written.
*
* ```ts no_run
* import initCommand from 'fino:commands/init';
*
* // Non-interactive scaffold, accepting derived defaults:
* await initCommand.parse(['--yes', '--name', 'my-tool', '--license', 'Apache-2.0']);
* ```
*
*/
import { Task, type TaskContext } from '../task.ts';
import { DiskFileSystem } from '../file/fs.ts';
import { cwd, env, Process } from '../process.ts';
const fs = new DiskFileSystem();
const textEncoder = new TextEncoder();
function definedEnv(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}
function basename(path: string): string {
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? normalized : normalized.slice(idx + 1);
}
async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (_) {
    return false;
  }
}
function validatePackageName(name: string): string | null {
  if (!name || name.trim().length === 0) return 'Package name must not be empty';
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) {
    return 'Package name must contain only lowercase letters, numbers, dots, underscores, hyphens, and optional scope';
  }
  return null;
}
async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  return new TextDecoder().decode(chunks.reduce((acc, c) => {
    const merged = new Uint8Array(acc.byteLength + c.byteLength);
    merged.set(acc);
    merged.set(c, acc.byteLength);
    return merged;
  }, new Uint8Array(0)));
}
async function gitConfig(args: string[], root: string): Promise<string> {
  let proc: Process;
  try {
    proc = new Process('/usr/bin/env', ['git', ...args], {
      cwd: root,
      env: definedEnv(env)
    });
  } catch (_) {
    return '';
  }
  proc.stdin.close();
  const [stdout, result] = await Promise.all([readAll(proc.stdout), proc.wait()]);
  for await (const _chunk of proc.stderr) {}
  if (result.code !== 0) return '';
  return stdout.trim();
}
async function getDefaultAuthor(root: string): Promise<string> {
  const name = await gitConfig([
    'config',
    '--get',
    'user.name'
  ], root);
  const email = await gitConfig([
    'config',
    '--get',
    'user.email'
  ], root);
  if (name && email) return `${name} <${email}>`;
  return name || '';
}
async function getDefaultRepository(root: string): Promise<string> {
  return await gitConfig([
    'config',
    '--get',
    'remote.origin.url'
  ], root);
}
async function resolveField(ctx: TaskContext, input: Record<string, unknown>, key: string, options: {
  label: string;
  defaultValue: string;
  validate?: (value: string) => string | null;
}): Promise<string> {
  const currentValue = String(input[key] ?? options.defaultValue);
  if (!ctx.optionProvided?.(key) && ctx.prompt?.isInteractive && !input.yes) {
    const promptOptions = {
      label: options.label,
      defaultValue: currentValue
    } as {
      label: string;
      defaultValue: string;
      validate?: (value: string) => string | null | undefined;
    };
    if (options.validate !== undefined) promptOptions.validate = options.validate;
    return await ctx.prompt.text(promptOptions);
  }
  return currentValue;
}
/**
* The `init` subcommand used by the root Fino CLI.
*
* Writes `package.json` with `name`, `version`, `type`, `description`,
* `license`, `author`, and `repository` fields, pretty-printed with two-space
* indentation and a trailing newline. In text mode the task resolves to a
* `Wrote <path>` message; with `--json` it writes and returns a structured
* result of the shape `{ command, ok, path, package, message }`.
*
* Throws if `package.json` already exists and `--force` was not given, if the
* resolved package name fails validation, or if the filesystem write fails.
*
* ```ts no_run
* import init from 'fino:commands/init';
*
* // Interactive: prompts for each field on a TTY.
* await init.parse([]);
*
* // Scripted: accept defaults, overwrite an existing manifest.
* await init.parse(['--yes', '--force', '--name', 'fino-app']);
* ```
*
*/
const command = new Task({
    name: 'init',
    description: 'Create a package.json for the current project',
    outputMode: 'both',
    run: async function runInitCommand(input: Record<string, unknown>, ctx) {
      const root = cwd();
      const packageJsonPath = root + '/package.json';
      if (await exists(packageJsonPath) && !input.force) {
        throw new Error('fino init: package.json already exists (pass --force to overwrite)');
      }
      const name = await resolveField(ctx, input, 'name', {
        label: 'Package name',
        defaultValue: String(input.name ?? ''),
        validate: validatePackageName
      });
      const version = await resolveField(ctx, input, 'version', {
        label: 'Version',
        defaultValue: String(input.version ?? '1.0.0')
      });
      const description = await resolveField(ctx, input, 'description', {
        label: 'Description',
        defaultValue: String(input.description ?? '')
      });
      const license = await resolveField(ctx, input, 'license', {
        label: 'License',
        defaultValue: String(input.license ?? 'MIT')
      });
      const author = await resolveField(ctx, input, 'author', {
        label: 'Author',
        defaultValue: String(input.author ?? '')
      });
      const repository = await resolveField(ctx, input, 'repository', {
        label: 'Repository',
        defaultValue: String(input.repository ?? '')
      });
      const validationError = validatePackageName(String(name));
      if (validationError) throw new Error(`fino init: ${validationError}`);
      const pkg = {
        name,
        version,
        type: 'module',
        description,
        license,
        author,
        repository
      };
      await fs.writeFile(packageJsonPath, textEncoder.encode(JSON.stringify(pkg, null, 2) + '\n'));
      const message = `Wrote ${packageJsonPath}`;
      if (ctx.writer.mode === 'json') {
        const result = {
          command: 'init',
          ok: true,
          path: packageJsonPath,
          package: pkg,
          message
        };
        await ctx.writer.writeJson(result);
        return result;
      }
      return message;
    },
    cli: { options: [
      {
        flags: '--name',
        type: 'string',
        description: 'Package name',
        default() {
          return basename(cwd()) || 'fino-app';
        }
      },
      {
        flags: '--version',
        type: 'string',
        description: 'Package version',
        default: '1.0.0'
      },
      {
        flags: '--description',
        type: 'string',
        description: 'Package description',
        default: ''
      },
      {
        flags: '--license',
        type: 'string',
        description: 'Package license',
        default: 'MIT'
      },
      {
        flags: '--author',
        type: 'string',
        description: 'Package author',
        default() {
          return getDefaultAuthor(cwd());
        }
      },
      {
        flags: '--repository',
        type: 'string',
        description: 'Package repository URL',
        default() {
          return getDefaultRepository(cwd());
        }
      },
      {
        flags: '--yes, -y',
        type: 'boolean',
        description: 'Accept defaults for any promptable values'
      },
      {
        flags: '--force, -f',
        type: 'boolean',
        description: 'Overwrite an existing package.json'
      }
    ] }
});
export { command as default };
