/**
 * internal/commands/init — internal runtime module.
 *
 * Builds the `fino init` command. The command creates a `package.json` in the
 * current working directory, deriving defaults from the directory name and Git
 * configuration when available. Interactive prompts are used only when the
 * command context supports them and `--yes` is not set.
 *
 * ```js
 * import { createInitCommand } from 'internal:commands/init';
 * const command = createInitCommand();
 * console.log(command.name);
 * ```
 *
 * @internal
 */

import { Task, type TaskContext } from '../../task.ts';
import { DiskFileSystem } from '../../file/fs.ts';
import { cwd, env, Process } from '../../process.ts';

const fs = new DiskFileSystem();

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
    proc = new Process('/usr/bin/env', ['git', ...args], { cwd: root, env: definedEnv(env) });
  } catch (_) {
    return '';
  }
  proc.stdin.close();
  const [stdout, result] = await Promise.all([
    readAll(proc.stdout),
    proc.wait(),
  ]);
  for await (const _chunk of proc.stderr) {}
  if (result.code !== 0) return '';
  return stdout.trim();
}

async function getDefaultAuthor(root: string): Promise<string> {
  const name = await gitConfig(['config', '--get', 'user.name'], root);
  const email = await gitConfig(['config', '--get', 'user.email'], root);
  if (name && email) return `${name} <${email}>`;
  return name || '';
}

async function getDefaultRepository(root: string): Promise<string> {
  return await gitConfig(['config', '--get', 'remote.origin.url'], root);
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
      defaultValue: currentValue,
    } as { label: string; defaultValue: string; validate?: (value: string) => string | null | undefined };
    if (options.validate !== undefined) promptOptions.validate = options.validate;
    return await ctx.prompt.text(promptOptions);
  }
  return currentValue;
}

/**
 * Create the `init` subcommand used by the root Fino CLI.
 *
 * The returned command writes `package.json` with `name`, `version`, `type`,
 * `description`, `license`, `author`, and `repository` fields. Existing files
 * are preserved unless `--force` is provided. Package names are validated before
 * writing; invalid input and filesystem failures are reported as thrown errors.
 *
 * ```js
 * import { createInitCommand } from 'internal:commands/init';
 * const init = createInitCommand();
 * await init.parse(['--yes', '--name', 'fino-app']);
 * ```
 *
 * @returns A configured `Task` instance for `fino init`.
 * @internal
 */
export function createInitCommand(): Task {
  return new Task({
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
        validate: validatePackageName,
      });
      const version = await resolveField(ctx, input, 'version', {
        label: 'Version',
        defaultValue: String(input.version ?? '1.0.0'),
      });
      const description = await resolveField(ctx, input, 'description', {
        label: 'Description',
        defaultValue: String(input.description ?? ''),
      });
      const license = await resolveField(ctx, input, 'license', {
        label: 'License',
        defaultValue: String(input.license ?? 'MIT'),
      });
      const author = await resolveField(ctx, input, 'author', {
        label: 'Author',
        defaultValue: String(input.author ?? ''),
      });
      const repository = await resolveField(ctx, input, 'repository', {
        label: 'Repository',
        defaultValue: String(input.repository ?? ''),
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
        repository,
      };

      await fs.writeFile(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
      const message = `Wrote ${packageJsonPath}`;
      if (ctx.writer.mode === 'json') {
        const result = { command: 'init', ok: true, path: packageJsonPath, package: pkg, message };
        await ctx.writer.writeJson(result);
        return result;
      }
      return message;
    },
    cli: {
      options: [
        { flags: '--name', type: 'string', description: 'Package name', default() { return basename(cwd()) || 'fino-app'; } },
        { flags: '--version', type: 'string', description: 'Package version', default: '1.0.0' },
        { flags: '--description', type: 'string', description: 'Package description', default: '' },
        { flags: '--license', type: 'string', description: 'Package license', default: 'MIT' },
        { flags: '--author', type: 'string', description: 'Package author', default() { return getDefaultAuthor(cwd()); } },
        { flags: '--repository', type: 'string', description: 'Package repository URL', default() { return getDefaultRepository(cwd()); } },
        { flags: '--yes, -y', type: 'boolean', description: 'Accept defaults for any promptable values' },
        { flags: '--force, -f', type: 'boolean', description: 'Overwrite an existing package.json' },
      ],
    },
  });
}
