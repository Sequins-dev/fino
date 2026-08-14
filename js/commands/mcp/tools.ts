/**
 * fino:commands/mcp/tools — Fino's own CLI commands, exposed as MCP tools.
 *
 * `fino mcp` deliberately does not re-export generic file reading, listing, or
 * searching: every MCP host already has those. What only Fino can offer is
 * Fino itself — its test runner, benchmark runner, linter, formatter, package
 * installer, and project scaffolder. `createFinoCommandTools()` wraps each of
 * those as a `fino_<command>` tool so an agent working on a Fino project can
 * drive the real toolchain.
 *
 * Each tool spawns the running `fino` binary as a child process rather than
 * invoking the command `Task` in-process. That is required, not stylistic:
 * `fino test` and `fino bench` write their results with `console.log`, which
 * over the stdio transport would interleave TAP text into the JSON-RPC stream
 * and break the session, and `fino lint` / `fino fmt` print their diagnostics
 * to stderr while throwing only an aggregate count — so an in-process call
 * would return `4 diagnostics` with the diagnostics themselves lost. Running a
 * child also gives every invocation a fresh isolate, so repeated `fino_test`
 * calls neither accumulate registrations nor serve stale modules from the
 * loader cache.
 *
 * ```ts no_run
 * import { createFinoCommandTools } from 'fino:commands/mcp/tools';
 *
 * const tools = createFinoCommandTools({ cwd: '/repo', writes: true, shell: true });
 * const names = tools.map((t) => t.name);
 * // ['fino_lint', 'fino_fmt', 'fino_install', 'fino_init', 'fino_test', 'fino_bench']
 * ```
 */
import { tool, Tool } from 'fino:ai/tool';
import { v } from 'fino:validate';
import { execPath, kill, Process, SIGKILL } from 'fino:process';

/**
 * Options for `createFinoCommandTools()`.
 */
export interface FinoCommandToolsOptions {
  /**
   * Project root the child `fino` process runs in. Every path, glob, and
   * pattern argument is resolved by the command relative to this directory.
   */
  cwd: string;
  /**
   * Include the tools that modify files: `fino_fmt`, `fino_install`,
   * `fino_init`, and the `fix` parameter of `fino_lint`. Defaults to `false`.
   */
  writes?: boolean;
  /**
   * Include the tools that execute project code: `fino_test` and `fino_bench`.
   * Defaults to `false`.
   */
  shell?: boolean;
}

const MAX_OUTPUT_CHARS = 48_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const TOOL_TIMEOUT_MS = MAX_TIMEOUT_MS + 30_000;

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[output truncated at ${limit} characters]`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readAllText(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function killQuietly(proc: Process): void {
  try {
    kill(proc.pid, SIGKILL);
  } catch (_) {
    // already exited
  }
}

type CommandResult = string | { content: string; isError: true };

async function runFinoCommand(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CommandResult> {
  const label = `fino ${args[0]}`;
  let proc: Process;
  try {
    proc = new Process(execPath, args, { cwd });
  } catch (err) {
    return { content: `${label} could not start: ${errorMessage(err)}`, isError: true };
  }
  proc.stdin.close();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killQuietly(proc);
  }, timeoutMs);
  const onAbort = () => killQuietly(proc);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const [stdout, stderr, result] = await Promise.all([
      readAllText(proc.stdout),
      readAllText(proc.stderr),
      proc.wait(),
    ]);
    const failed = timedOut || result.code !== 0;
    const sections: string[] = [];
    if (timedOut) sections.push(`[killed after ${timeoutMs}ms]`);
    else if (failed) sections.push(`exit code: ${result.code ?? `signal ${result.signal}`}`);
    if (stdout.trim().length > 0) sections.push(stdout.trimEnd());
    if (stderr.trim().length > 0) sections.push(stderr.trimEnd());
    if (sections.length === 0) sections.push(`${label}: no output`);
    const content = truncate(sections.join('\n\n'));
    return failed ? { content, isError: true } : content;
  } catch (err) {
    return { content: `${label} failed: ${errorMessage(err)}`, isError: true };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function timeoutParameter(defaultMs: number) {
  return v
    .integer()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Kill the command after this many milliseconds (default ${defaultMs})`);
}

function pathsParameter(what: string) {
  return v
    .array(v.string())
    .optional()
    .describe(`Files, directories, or globs to ${what}; defaults to the whole project`);
}

function stringArgs(values: string[] | undefined): string[] {
  return (values ?? []).map(String);
}

function lintTool(cwd: string, writes: boolean): Tool {
  const parameters = writes
    ? v.object({
        paths: pathsParameter('lint'),
        fix: v
          .boolean()
          .optional()
          .describe('Apply the safe rule fixes in place; never reformats layout'),
        timeoutMs: timeoutParameter(DEFAULT_TIMEOUT_MS),
      })
    : v.object({
        paths: pathsParameter('lint'),
        timeoutMs: timeoutParameter(DEFAULT_TIMEOUT_MS),
      });
  return tool({
    name: 'fino_lint',
    description:
      "Run Fino's TypeScript/JavaScript linter over the project and report diagnostics " +
      'grouped by file. Errors when any diagnostic remains. Read-only unless fix is set.',
    parameters,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (
      {
        paths,
        fix = false,
        timeoutMs = DEFAULT_TIMEOUT_MS,
      }: {
        paths?: string[];
        fix?: boolean;
        timeoutMs?: number;
      },
      ctx,
    ) => {
      const args = ['lint'];
      if (writes && fix) args.push('--fix');
      args.push(...stringArgs(paths));
      return await runFinoCommand(cwd, args, ctx.signal, timeoutMs);
    },
  });
}

function fmtTool(cwd: string): Tool {
  return tool({
    name: 'fino_fmt',
    description:
      "Run Fino's TypeScript/JavaScript formatter. Rewrites layout in place; set check " +
      'to report which files would change without writing them. Applies no lint fixes.',
    parameters: v.object({
      paths: pathsParameter('format'),
      check: v
        .boolean()
        .optional()
        .describe('Report files that would change instead of writing them'),
      timeoutMs: timeoutParameter(DEFAULT_TIMEOUT_MS),
    }),
    risk: 'rewrites source files',
    sideEffects: true,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (
      {
        paths,
        check = false,
        timeoutMs = DEFAULT_TIMEOUT_MS,
      }: {
        paths?: string[];
        check?: boolean;
        timeoutMs?: number;
      },
      ctx,
    ) => {
      const args = ['fmt'];
      if (check) args.push('--check');
      args.push(...stringArgs(paths));
      return await runFinoCommand(cwd, args, ctx.signal, timeoutMs);
    },
  });
}

function testTool(cwd: string): Tool {
  return tool({
    name: 'fino_test',
    description:
      "Run Fino's test runner over the given files, directories, or globs and return its " +
      'TAP output. Errors when any test fails. This executes project code.',
    parameters: v.object({
      patterns: v
        .array(v.string())
        .describe('Test files, directories, or globs, e.g. ["tests/**/*.test.ts"]'),
      filter: v
        .string()
        .optional()
        .describe('Only run describe groups whose full path contains this text'),
      showOutput: v
        .enum(['failures', 'always', 'never'])
        .optional()
        .describe('When to include captured console output (default failures)'),
      durations: v.boolean().optional().describe('Annotate TAP result lines with durations'),
      timeoutMs: timeoutParameter(DEFAULT_TIMEOUT_MS),
    }),
    risk: 'executes project code',
    sideEffects: true,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (
      {
        patterns,
        filter,
        showOutput,
        durations = false,
        timeoutMs = DEFAULT_TIMEOUT_MS,
      }: {
        patterns: string[];
        filter?: string;
        showOutput?: string;
        durations?: boolean;
        timeoutMs?: number;
      },
      ctx,
    ) => {
      const files = stringArgs(patterns);
      if (files.length === 0) {
        return { content: 'fino_test: patterns must name at least one test file', isError: true };
      }
      const args = ['test'];
      if (filter !== undefined) args.push('--filter', filter);
      if (showOutput !== undefined) args.push('--show-output', showOutput);
      if (durations) args.push('--durations');
      args.push(...files);
      return await runFinoCommand(cwd, args, ctx.signal, timeoutMs);
    },
  });
}

function benchTool(cwd: string): Tool {
  return tool({
    name: 'fino_bench',
    description:
      "Run Fino's benchmark runner over the given files, directories, or globs and return " +
      'its measurements. This executes project code.',
    parameters: v.object({
      patterns: v
        .array(v.string())
        .describe('Benchmark files, directories, or globs, e.g. ["benchmarks/"]'),
      filter: v
        .string()
        .optional()
        .describe('Only run benchmark groups whose full path contains this text'),
      timeoutMs: timeoutParameter(DEFAULT_TIMEOUT_MS),
    }),
    risk: 'executes project code',
    sideEffects: true,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (
      {
        patterns,
        filter,
        timeoutMs = DEFAULT_TIMEOUT_MS,
      }: {
        patterns: string[];
        filter?: string;
        timeoutMs?: number;
      },
      ctx,
    ) => {
      const files = stringArgs(patterns);
      if (files.length === 0) {
        return {
          content: 'fino_bench: patterns must name at least one benchmark file',
          isError: true,
        };
      }
      const args = ['bench'];
      if (filter !== undefined) args.push('--filter', filter);
      args.push(...files);
      return await runFinoCommand(cwd, args, ctx.signal, timeoutMs);
    },
  });
}

function installTool(cwd: string): Tool {
  return tool({
    name: 'fino_install',
    description:
      'Install npm packages into .fino and regenerate the package map the module loader ' +
      'reads. Named packages are added to package.json first; with none, reinstall what ' +
      'package.json already declares.',
    parameters: v.object({
      packages: v
        .array(v.string())
        .optional()
        .describe('npm specs to add, e.g. ["left-pad", "@scope/pkg@^1.2.0"]'),
      timeoutMs: timeoutParameter(MAX_TIMEOUT_MS),
    }),
    risk: 'downloads packages and writes package.json',
    sideEffects: true,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (
      {
        packages,
        timeoutMs = MAX_TIMEOUT_MS,
      }: {
        packages?: string[];
        timeoutMs?: number;
      },
      ctx,
    ) => {
      const args = ['install', ...stringArgs(packages)];
      return await runFinoCommand(cwd, args, ctx.signal, timeoutMs);
    },
  });
}

function initTool(cwd: string): Tool {
  return tool({
    name: 'fino_init',
    description:
      'Scaffold a package.json for a Fino project. Fino packages are ESM-only, so the ' +
      'manifest always gets type: "module". Fails if package.json exists unless force is set.',
    parameters: v.object({
      name: v.string().optional().describe('Package name; defaults to the directory basename'),
      version: v.string().optional().describe('Package version (default 1.0.0)'),
      description: v.string().optional().describe('Package description'),
      license: v.string().optional().describe('SPDX license id (default MIT)'),
      author: v.string().optional().describe('Author; defaults to the local git user'),
      repository: v.string().optional().describe('Repository URL; defaults to git origin'),
      force: v.boolean().optional().describe('Overwrite an existing package.json'),
      timeoutMs: timeoutParameter(DEFAULT_TIMEOUT_MS),
    }),
    risk: 'writes package.json',
    sideEffects: true,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (
      input: {
        name?: string;
        version?: string;
        description?: string;
        license?: string;
        author?: string;
        repository?: string;
        force?: boolean;
        timeoutMs?: number;
      },
      ctx,
    ) => {
      // `--yes` suppresses the interactive field prompts: an MCP session has no TTY
      // to answer them on, and every field is already supplied as a parameter.
      const args = ['init', '--yes'];
      for (const key of [
        'name',
        'version',
        'description',
        'license',
        'author',
        'repository',
      ] as const) {
        const value = input[key];
        if (value !== undefined) args.push(`--${key}`, String(value));
      }
      if (input.force === true) args.push('--force');
      return await runFinoCommand(cwd, args, ctx.signal, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    },
  });
}

/**
 * Build the `fino_*` command tool set for an MCP mount.
 *
 * `fino_lint` is always included: it only reads sources unless `writes` also
 * enables its `fix` parameter. `writes` appends `fino_fmt`, `fino_install`,
 * and `fino_init`, all of which change files on disk. `shell` appends
 * `fino_test` and `fino_bench`, which run arbitrary project code and so carry
 * the same risk as a shell.
 *
 * ```ts no_run
 * import { createFinoCommandTools } from 'fino:commands/mcp/tools';
 *
 * const readOnly = createFinoCommandTools({ cwd: '/repo' });
 * // ['fino_lint']
 * ```
 */
export function createFinoCommandTools(opts: FinoCommandToolsOptions): Tool[] {
  const cwd = opts.cwd;
  const writes = opts.writes ?? false;
  const tools = [lintTool(cwd, writes)];
  if (writes) tools.push(fmtTool(cwd), installTool(cwd), initTool(cwd));
  if (opts.shell ?? false) tools.push(testTool(cwd), benchTool(cwd));
  return tools;
}
