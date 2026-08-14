/**
 * internal:commands/tools — the tools that drive Fino itself.
 *
 * One tool set serves every Fino-aware agent surface: `fino code` mounts it
 * alongside the general-purpose workspace tools of `fino:ai/tools`, and
 * `fino mcp` serves it on its own. Both want the same thing — the Fino
 * documentation index (`docs_search`, `docs_show`) and Fino's own commands as
 * `fino_*` tools — so the gating policy is decided here once.
 *
 * Almost every tool runs its command as an in-process `Task`: the command
 * modules are `Task`s already, so a tool call is a `parse()` away, and a
 * console capture around the call keeps a command's own diagnostics out of the
 * host's stdout while folding them into the tool result. The two exceptions
 * are `fino_test` and `fino_bench`, which spawn the `fino` binary. That is
 * required, not stylistic: `fino test` imports test modules into the calling
 * isolate, and the module cache has no invalidation hook, so a second
 * in-process run re-executes the code from the first one — an agent that edits
 * a file and re-runs its tests would be told the old code still passes. Running
 * project tests in the host isolate would also permanently lift the loader's
 * `internal:*` restriction there (`fino test` calls `allowInternalForTests()`)
 * and let a test `chdir` or exit the host process.
 *
 * ```ts no_run
 * import { createFinoTools } from 'internal:commands/tools';
 *
 * const tools = createFinoTools({ cwd: '/repo', writes: true, shell: true });
 * const names = tools.map((entry) => entry.name);
 * // ['docs_search', 'docs_show', 'fino_lint', 'fino_fmt',
 * //  'fino_install', 'fino_init', 'fino_test', 'fino_bench']
 * ```
 *
 * @internal
 */
import { tool, Tool } from 'fino:ai/tool';
import { v } from 'fino:validate';
import { execPath, kill, Process, SIGKILL } from 'fino:process';
import { _pushConsoleCapture, type ConsoleCaptureRecord } from '../../globals/console.ts';
import type { Task } from '../../task.ts';

/**
 * Options for `createFinoTools()`.
 *
 * ```ts no_run
 * import { createFinoTools, type FinoToolsOptions } from 'internal:commands/tools';
 *
 * const opts: FinoToolsOptions = { cwd: '/repo', writes: true };
 * const tools = createFinoTools(opts);
 * ```
 *
 * @internal
 */
export interface FinoToolsOptions {
  /**
   * Project root the commands operate against.
   *
   * Fino's source discovery resolves relative paths against the process
   * working directory, which is what both `fino code` and `fino mcp` pass
   * here; the value is forwarded to every command as its task working
   * directory and used as the child process directory for `fino_test` and
   * `fino_bench`.
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
  /**
   * Drop `requiresApproval` from the tools that write files or run project
   * code, so they execute without suspending for a human decision. Defaults
   * to `false`.
   */
  auto?: boolean;
}

const MAX_OUTPUT_CHARS = 48_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const TOOL_TIMEOUT_MS = MAX_TIMEOUT_MS + 30_000;

const DOC_BUILD_HINT =
  'No documentation index found. Build one first with: fino doc build --types runtime-builtins.d.ts js ' +
  '(from the fino repository root), or point the tools at a project that has run `fino doc build`.';

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[output truncated at ${limit} characters]`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type CommandResult = string | { content: string; isError: true };

// ---------------------------------------------------------------------------
// Documentation tools
// ---------------------------------------------------------------------------

async function loadDocTask(): Promise<Task> {
  const mod = (await import('fino:commands/doc')) as { default: Task };
  return mod.default;
}

interface DocJsonResult {
  found?: boolean;
  output?: string;
}

function docsFailure(label: string, err: unknown): { content: string; isError: true } {
  const message = errorMessage(err);
  if (message.includes('no prior doc build')) return { content: DOC_BUILD_HINT, isError: true };
  return { content: `${label} failed: ${message}`, isError: true };
}

function docsSearchTool(): Tool {
  return tool({
    name: 'docs_search',
    description:
      'Full-text search the Fino documentation index (guides and generated API reference). ' +
      'Use this first when deciding which fino:* module or symbol serves a use case. Read-only.',
    parameters: v.object({
      query: v.string().describe('Search terms, e.g. "http server routing" or "kqueue"'),
    }),
    execute: async ({ query }: { query: string }) => {
      const doc = await loadDocTask();
      const search = doc.child('search');
      if (!search) return { content: 'doc search command unavailable', isError: true };
      try {
        const result = (await search.run(
          { query: query.split(/\s+/).filter((term) => term.length > 0) },
          { outputMode: 'json' },
        )) as DocJsonResult;
        return truncate(result.output ?? 'No results.');
      } catch (err) {
        return docsFailure('docs_search', err);
      }
    },
  });
}

function docsShowTool(): Tool {
  return tool({
    name: 'docs_show',
    description:
      'Show the generated API reference for one Fino symbol by qualified name, e.g. ' +
      '"agent", "Session.approveTool", or "net/http/app.App". Read-only.',
    parameters: v.object({
      symbol: v.string().describe('Symbol or module name, optionally member-qualified'),
    }),
    execute: async ({ symbol }: { symbol: string }) => {
      const doc = await loadDocTask();
      const show = doc.child('show');
      if (!show) return { content: 'doc show command unavailable', isError: true };
      try {
        const result = (await show.run({ symbol }, { outputMode: 'json' })) as DocJsonResult;
        return truncate(result.output ?? 'No result.');
      } catch (err) {
        return docsFailure('docs_show', err);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// In-process command tools
// ---------------------------------------------------------------------------

/**
 * Pull the human-readable body out of a command's `--json` result object.
 *
 * `test` and `bench` carry their whole report in `output`; the rest report a
 * one-line `message`. A command with neither (such as `install`) says
 * everything it has to say through the console, which the caller captures
 * separately.
 */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  const record = value as { output?: unknown; message?: unknown };
  if (typeof record.output === 'string' && record.output.length > 0) return record.output;
  if (typeof record.message === 'string') return record.message;
  return '';
}

/**
 * Run one Fino command in this isolate and render its result as tool content.
 *
 * The command is a `Task`, so it is driven through `parse()` with the same
 * argv the CLI would receive, asking for `json` output — that is the mode in
 * which every command hands back a structured result instead of printing one.
 * A console capture wraps the call because the tooling commands report their
 * detail through `console`: `lint` and `fmt` group their diagnostics onto
 * stderr and throw only an aggregate count, and `install` warns about skipped
 * optional and peer dependencies. Capturing turns all of that into tool
 * content and, just as importantly, keeps it out of a stdout that may be
 * carrying JSON-RPC.
 */
async function runFinoTask(
  loadTask: () => Promise<Task>,
  label: string,
  emptyMessage: string,
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<CommandResult> {
  const records: ConsoleCaptureRecord[] = [];
  let json: unknown;
  let failure: unknown;
  let task: Task;
  try {
    task = await loadTask();
  } catch (err) {
    return { content: `${label} could not start: ${errorMessage(err)}`, isError: true };
  }
  const release = _pushConsoleCapture((record) => records.push(record));
  try {
    await task.parse(args, {
      outputMode: 'json',
      writer: {
        mode: 'json',
        writeJson: (value) => {
          json = value;
        },
      },
      signal,
      cwd,
    });
  } catch (err) {
    failure = err;
  } finally {
    release();
  }
  const sections: string[] = [];
  const consoleText = records
    .map((record) => record.text)
    .join('\n')
    .trimEnd();
  if (consoleText.length > 0) sections.push(consoleText);
  const body = resultText(json).trimEnd();
  if (body.length > 0) sections.push(body);
  if (failure !== undefined) sections.push(errorMessage(failure));
  if (sections.length === 0) sections.push(emptyMessage);
  const content = truncate(sections.join('\n\n'));
  return failure === undefined ? content : { content, isError: true };
}

function defaultExport(mod: unknown): Task {
  return (mod as { default: Task }).default;
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

function lintTool(cwd: string, writes: boolean, auto: boolean): Tool {
  const parameters = writes
    ? v.object({
        paths: pathsParameter('lint'),
        fix: v
          .boolean()
          .optional()
          .describe('Apply the safe rule fixes in place; never reformats layout'),
      })
    : v.object({ paths: pathsParameter('lint') });
  const gated = writes
    ? { risk: 'rewrites source files when fix is set', sideEffects: true, requiresApproval: !auto }
    : {};
  return tool({
    name: 'fino_lint',
    description:
      "Run Fino's TypeScript/JavaScript linter over the project and report diagnostics " +
      'grouped by file. Errors when any diagnostic remains. Read-only unless fix is set.',
    parameters,
    ...gated,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (
      { paths, fix = false }: { paths?: string[]; fix?: boolean },
      ctx,
    ): Promise<CommandResult> => {
      const args: string[] = [];
      if (writes && fix) args.push('--fix');
      args.push(...stringArgs(paths));
      return await runFinoTask(
        async () => defaultExport(await import('fino:commands/lint')),
        'fino lint',
        'fino lint: no output',
        cwd,
        args,
        ctx.signal,
      );
    },
  });
}

function fmtTool(cwd: string, auto: boolean): Tool {
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
    }),
    risk: 'rewrites source files',
    sideEffects: true,
    requiresApproval: !auto,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (
      { paths, check = false }: { paths?: string[]; check?: boolean },
      ctx,
    ): Promise<CommandResult> => {
      const args: string[] = [];
      if (check) args.push('--check');
      args.push(...stringArgs(paths));
      return await runFinoTask(
        async () => defaultExport(await import('fino:commands/fmt')),
        'fino fmt',
        'fino fmt: no output',
        cwd,
        args,
        ctx.signal,
      );
    },
  });
}

function installTool(cwd: string, auto: boolean): Tool {
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
    }),
    risk: 'downloads packages and writes package.json',
    sideEffects: true,
    requiresApproval: !auto,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async ({ packages }: { packages?: string[] }, ctx): Promise<CommandResult> => {
      const named = stringArgs(packages);
      // `fino install` reports nothing on a clean run — no diagnostics, no
      // summary line — so the tool supplies the acknowledgement itself.
      const done =
        named.length === 0
          ? 'fino install: reinstalled the dependencies package.json declares'
          : `fino install: installed ${named.join(', ')}`;
      return await runFinoTask(
        async () => defaultExport(await import('fino:commands/install')),
        'fino install',
        done,
        cwd,
        named,
        ctx.signal,
      );
    },
  });
}

function initTool(cwd: string, auto: boolean): Tool {
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
    }),
    risk: 'writes package.json',
    sideEffects: true,
    requiresApproval: !auto,
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
      },
      ctx,
    ): Promise<CommandResult> => {
      // `--yes` suppresses the interactive field prompts: a tool call has no
      // TTY to answer them on, and every field is already a parameter.
      const args = ['--yes'];
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
      return await runFinoTask(
        async () => defaultExport(await import('fino:commands/init')),
        'fino init',
        'fino init: no output',
        cwd,
        args,
        ctx.signal,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Child-process command tools
// ---------------------------------------------------------------------------

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

/**
 * Run one Fino command as a child `fino` process and render its output.
 *
 * Reserved for `fino_test` and `fino_bench`. Both import project modules for
 * their registration side effects, which is only correct in a fresh isolate:
 * the loader's module cache has no invalidation hook, so a repeat run in this
 * isolate would replay the code as it was at first import, and registrations
 * from an earlier run would be replayed alongside the new ones.
 */
async function runFinoChild(
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

function testTool(cwd: string, auto: boolean): Tool {
  return tool({
    name: 'fino_test',
    description:
      "Run Fino's test runner over the given files, directories, or globs and return its " +
      'TAP output. Errors when any test fails. This executes project code, in a separate ' +
      'process, so every call sees the current source.',
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
    requiresApproval: !auto,
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
    ): Promise<CommandResult> => {
      const files = stringArgs(patterns);
      if (files.length === 0) {
        return { content: 'fino_test: patterns must name at least one test file', isError: true };
      }
      const args = ['test'];
      if (filter !== undefined) args.push('--filter', filter);
      if (showOutput !== undefined) args.push('--show-output', showOutput);
      if (durations) args.push('--durations');
      args.push(...files);
      return await runFinoChild(cwd, args, ctx.signal, timeoutMs);
    },
  });
}

function benchTool(cwd: string, auto: boolean): Tool {
  return tool({
    name: 'fino_bench',
    description:
      "Run Fino's benchmark runner over the given files, directories, or globs and return " +
      'its measurements. This executes project code, in a separate process, so every call ' +
      'sees the current source.',
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
    requiresApproval: !auto,
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
    ): Promise<CommandResult> => {
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
      return await runFinoChild(cwd, args, ctx.signal, timeoutMs);
    },
  });
}

/**
 * Build the Fino tool set for one capability policy.
 *
 * `docs_search`, `docs_show`, and `fino_lint` are unconditional: the first two
 * only read the `fino doc build` index, and the linter only reads sources
 * unless `writes` also enables its `fix` parameter. `writes` appends
 * `fino_fmt`, `fino_install`, and `fino_init`, all of which change files on
 * disk. `shell` appends `fino_test` and `fino_bench`, which run arbitrary
 * project code and so carry the same risk as a shell. Every appended tool
 * declares `requiresApproval` unless `auto` is set.
 *
 * ```ts no_run
 * import { createFinoTools } from 'internal:commands/tools';
 *
 * const readOnly = createFinoTools({ cwd: '/repo' });
 * // ['docs_search', 'docs_show', 'fino_lint']
 * ```
 *
 * @internal
 */
export function createFinoTools(opts: FinoToolsOptions): Tool[] {
  const cwd = opts.cwd;
  const writes = opts.writes ?? false;
  const auto = opts.auto ?? false;
  const tools = [docsSearchTool(), docsShowTool(), lintTool(cwd, writes, auto)];
  if (writes) tools.push(fmtTool(cwd, auto), installTool(cwd, auto), initTool(cwd, auto));
  if (opts.shell ?? false) tools.push(testTool(cwd, auto), benchTool(cwd, auto));
  return tools;
}
