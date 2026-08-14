/**
 * fino:ai/tools — the ready-made workspace tool set for coding agents.
 *
 * Where `fino:ai/tool` defines one tool, this module ships the set every
 * coding agent needs: listing, reading, and searching files, and — when
 * writes are enabled — writing files, editing them in place, and running
 * shell commands. Each tool is an ordinary `fino:ai` `Tool`, so it can be
 * handed to an `Agent`, mounted on an MCP server, or invoked directly.
 *
 * The mutating tools (`write_file`, `edit_file`, `shell`) declare
 * `requiresApproval` unless `auto` is set, so an interactive harness suspends
 * for a human decision before they run. Relative paths resolve against `cwd`;
 * absolute paths are followed as given, since an agent working on a machine
 * rather than in a sandbox routinely reaches a scratch file or a neighbouring
 * checkout. Pass `confine` to refuse anything outside `cwd` — worth doing for
 * a set handed to something that should stay in one project, though it binds
 * only these tools, not `shell`. Output is capped so one call cannot flood a context window.
 *
 * ```ts no_run
 * import { agent, openai } from 'fino:ai';
 * import { createWorkspaceTools } from 'fino:ai/tools';
 *
 * const coder = agent({
 *   model: openai({ model: 'gpt-4o' }),
 *   tools: createWorkspaceTools({ cwd: '/repo' }),
 * });
 * ```
 */
import { tool, Tool } from 'fino:ai/tool';
import { v } from 'fino:validate';
import { DiskFileSystem, Glob } from 'fino:file';
import { dirname, join, relative, resolve, sep } from 'fino:file/path';
import { kill, Process, SIGKILL } from 'fino:process';

/**
 * Options for one workspace tool.
 *
 * ```ts no_run
 * import { readFileTool } from 'fino:ai/tools';
 *
 * const read = readFileTool({ cwd: '/repo' });
 * ```
 */
export interface WorkspaceToolOptions {
  /**
   * Workspace root that relative tool paths resolve against.
   */
  cwd: string;
  /**
   * Refuse paths that resolve outside {@link cwd}. Defaults to `false`,
   * because an absolute path to a file elsewhere is ordinary for an agent
   * working on a machine rather than in a sandbox — a checkout next door, a
   * scratch file in `/tmp`, a config in the home directory. Turn it on for a
   * tool set handed to something that should not reach past one project.
   *
   * Note that it confines these tools only: a set that also includes
   * {@link shellTool} can still reach anywhere the process can.
   */
  confine?: boolean;
}

/**
 * Options for a workspace tool that changes files or system state.
 *
 * ```ts no_run
 * import { shellTool } from 'fino:ai/tools';
 *
 * const shell = shellTool({ cwd: '/repo', auto: true });
 * ```
 */
export interface MutatingToolOptions extends WorkspaceToolOptions {
  /**
   * Drop `requiresApproval` so the tool executes without suspending for a
   * human decision. Defaults to `false`.
   */
  auto?: boolean;
}

/**
 * Options for `createWorkspaceTools()`.
 *
 * ```ts no_run
 * import { createWorkspaceTools, WorkspaceToolsOptions } from 'fino:ai/tools';
 *
 * const opts: WorkspaceToolsOptions = { cwd: '/repo', writes: false };
 * const tools = createWorkspaceTools(opts);
 * ```
 */
export interface WorkspaceToolsOptions extends MutatingToolOptions {
  /**
   * Include the mutating tools (`write_file`, `edit_file`, `shell`).
   *
   * Defaults to `true`. Set `false` for a read-only tool set, such as an
   * agent's planning mode or an unprivileged MCP mount.
   */
  writes?: boolean;
}

const MAX_OUTPUT_CHARS = 48_000;
const MAX_FILE_LINES = 2_000;
const MAX_LINE_CHARS = 500;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1_048_576;
const SKIP_DIRS = new Set([
  '.git',
  '.fino',
  'node_modules',
  'target',
  'dist',
  'build',
  'coverage',
  'vendor',
  'docs',
]);

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[output truncated at ${limit} characters]`;
}

function resolvePath(cwd: string, path: string, confine = false): string | null {
  const root = resolve(cwd).toString();
  const target = resolve(root, path).toString();
  if (!confine) return target;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(prefix) ? target : null;
}

function escapeError(path: string): { content: string; isError: true } {
  return { content: `Path ${path} resolves outside the workspace root`, isError: true };
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

/**
 * Build the `list_files` tool: glob the workspace for file paths.
 *
 * Results are sorted, reported relative to `cwd`, and capped at 500 entries.
 * Read-only.
 *
 * ```ts no_run
 * import { listFilesTool } from 'fino:ai/tools';
 *
 * const list = listFilesTool({ cwd: '/repo' });
 * ```
 */
export function listFilesTool(opts: WorkspaceToolOptions): Tool {
  const fs = new DiskFileSystem();
  const cwd = opts.cwd;
  const confine = opts.confine ?? false;
  return tool({
    name: 'list_files',
    description:
      'List files matching a glob pattern relative to the project root, e.g. "js/**/*.ts" ' +
      'or "tests/ai/*.test.ts". Prefer specific patterns; "**" walks everything including ' +
      'build output. Read-only.',
    parameters: v.object({
      pattern: v.string().describe('Glob pattern; ** matches across path segments'),
    }),
    execute: async ({ pattern }: { pattern: string }, ctx) => {
      const paths: string[] = [];
      let truncated = false;
      for await (const entry of fs.glob(pattern, {
        cwd,
        onlyFiles: true,
        signal: ctx.signal,
      })) {
        const rel = relative(cwd, entry.path).toString();
        paths.push(rel.length > 0 ? rel : entry.path.toString());
        if (paths.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          break;
        }
      }
      paths.sort();
      if (paths.length === 0) return `No files match ${pattern}`;
      return paths.join('\n') + (truncated ? `\n[truncated at ${MAX_LIST_ENTRIES} entries]` : '');
    },
  });
}

/**
 * Build the `read_file` tool: read a text file with line numbers.
 *
 * Long lines are clipped, the page is capped at 2000 lines, and the result
 * tells the model the offset to continue from. Read-only.
 *
 * ```ts no_run
 * import { readFileTool } from 'fino:ai/tools';
 *
 * const read = readFileTool({ cwd: '/repo' });
 * ```
 */
export function readFileTool(opts: WorkspaceToolOptions): Tool {
  const fs = new DiskFileSystem();
  const cwd = opts.cwd;
  const confine = opts.confine ?? false;
  return tool({
    name: 'read_file',
    description:
      'Read a text file with line numbers. Use offset/limit to page through large files. Read-only.',
    parameters: v.object({
      path: v.string().describe('File path, relative to the project root or absolute'),
      offset: v.integer().min(1).optional().describe('1-based first line to read'),
      limit: v.integer().min(1).optional().describe(`Line count, default ${MAX_FILE_LINES}`),
    }),
    execute: async ({
      path,
      offset = 1,
      limit = MAX_FILE_LINES,
    }: {
      path: string;
      offset?: number;
      limit?: number;
    }) => {
      const target = resolvePath(cwd, path, confine);
      if (target === null) return escapeError(path);
      let text: string;
      try {
        text = new TextDecoder().decode(await fs.readFile(target));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `Cannot read ${path}: ${message}`, isError: true };
      }
      const lines = text.split('\n');
      const start = Math.min(offset - 1, Math.max(0, lines.length - 1));
      const slice = lines.slice(start, start + Math.min(limit, MAX_FILE_LINES));
      const numbered = slice.map((line, index) => {
        const clipped = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line;
        return `${String(start + index + 1).padStart(5)}\t${clipped}`;
      });
      const remaining = lines.length - (start + slice.length);
      const suffix =
        remaining > 0
          ? `\n[${remaining} more lines; continue with offset=${start + slice.length + 1}]`
          : '';
      return truncate(numbered.join('\n') + suffix);
    },
  });
}

async function* walkProjectFiles(
  fs: DiskFileSystem,
  root: string,
  rel: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const dir = rel.length > 0 ? join(root, rel).toString() : root;
  for await (const entry of fs.glob('*', { cwd: dir, signal })) {
    if (signal.aborted) return;
    const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkProjectFiles(fs, root, childRel, signal);
    } else if (entry.isFile()) {
      yield childRel;
    }
  }
}

/**
 * Build the `search_files` tool: grep the workspace with a regular expression.
 *
 * The walk skips build output and dot directories, ignores files over 1 MiB or
 * containing NUL bytes, and caps results at 200 matches. Read-only.
 *
 * ```ts no_run
 * import { searchFilesTool } from 'fino:ai/tools';
 *
 * const search = searchFilesTool({ cwd: '/repo' });
 * ```
 */
export function searchFilesTool(opts: WorkspaceToolOptions): Tool {
  const fs = new DiskFileSystem();
  const cwd = opts.cwd;
  const confine = opts.confine ?? false;
  return tool({
    name: 'search_files',
    description:
      'Search project files line-by-line with a regular expression, like grep. Skips ' +
      'binary-sized files, dot directories, and build output (node_modules, target, dist, ' +
      'docs). Returns path:line: text matches. Read-only.',
    parameters: v.object({
      pattern: v.string().describe('JavaScript regular expression source'),
      glob: v
        .string()
        .optional()
        .describe('Restrict to paths matching this glob, e.g. "js/**/*.ts"'),
      ignoreCase: v.boolean().optional().describe('Case-insensitive matching'),
    }),
    execute: async (
      {
        pattern,
        glob,
        ignoreCase = false,
      }: {
        pattern: string;
        glob?: string;
        ignoreCase?: boolean;
      },
      ctx,
    ) => {
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignoreCase ? 'i' : undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `Invalid pattern: ${message}`, isError: true };
      }
      const filter = glob ? new Glob(glob) : null;
      const matches: string[] = [];
      let truncated = false;
      for await (const rel of walkProjectFiles(fs, cwd, '', ctx.signal)) {
        if (filter && !filter.test(rel)) continue;
        let bytes: Uint8Array;
        try {
          bytes = await fs.readFile(join(cwd, rel).toString());
        } catch (_) {
          continue;
        }
        if (bytes.byteLength > MAX_SEARCH_FILE_BYTES) continue;
        if (bytes.subarray(0, 4096).includes(0)) continue;
        const lines = new TextDecoder().decode(bytes).split('\n');
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          if (!re.test(line)) continue;
          const clipped = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line;
          matches.push(`${rel}:${index + 1}: ${clipped.trim()}`);
          if (matches.length >= MAX_SEARCH_MATCHES) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      if (matches.length === 0) return `No matches for /${pattern}/`;
      return truncate(
        matches.join('\n') + (truncated ? `\n[truncated at ${MAX_SEARCH_MATCHES} matches]` : ''),
      );
    },
  });
}

async function mkdirRecursive(fs: DiskFileSystem, dir: string): Promise<void> {
  try {
    await fs.mkdir(dir);
    return;
  } catch (_) {
    // fall through: parent may be missing, or the directory already exists
  }
  const parent = dirname(dir).toString();
  if (parent !== dir) {
    await mkdirRecursive(fs, parent);
    try {
      await fs.mkdir(dir);
    } catch (_) {
      // already exists
    }
  }
}

/**
 * Build the `write_file` tool: create or overwrite one file.
 *
 * Parent directories are created as needed. Declares `requiresApproval`
 * unless `auto` is set.
 *
 * ```ts no_run
 * import { writeFileTool } from 'fino:ai/tools';
 *
 * const write = writeFileTool({ cwd: '/repo' });
 * ```
 */
export function writeFileTool(opts: MutatingToolOptions): Tool {
  const fs = new DiskFileSystem();
  const cwd = opts.cwd;
  const confine = opts.confine ?? false;
  return tool({
    name: 'write_file',
    description:
      'Create or overwrite one file with the given content, creating parent directories as ' +
      'needed. This changes files on disk; prefer edit_file for small changes to existing files.',
    parameters: v.object({
      path: v.string().describe('File path, relative to the project root or absolute'),
      content: v.string().describe('Full new file content'),
    }),
    risk: 'writes files',
    sideEffects: true,
    requiresApproval: !(opts.auto ?? false),
    execute: async ({ path, content }: { path: string; content: string }) => {
      const target = resolvePath(cwd, path, confine);
      if (target === null) return escapeError(path);
      await mkdirRecursive(fs, dirname(target).toString());
      await fs.writeFile(target, new TextEncoder().encode(content));
      return `Wrote ${content.length} characters to ${path}`;
    },
  });
}

/**
 * Build the `edit_file` tool: replace text in one file.
 *
 * `oldText` must match exactly once unless `replaceAll` is set, so an
 * ambiguous edit fails instead of guessing. Declares `requiresApproval`
 * unless `auto` is set.
 *
 * ```ts no_run
 * import { editFileTool } from 'fino:ai/tools';
 *
 * const edit = editFileTool({ cwd: '/repo' });
 * ```
 */
export function editFileTool(opts: MutatingToolOptions): Tool {
  const fs = new DiskFileSystem();
  const cwd = opts.cwd;
  const confine = opts.confine ?? false;
  return tool({
    name: 'edit_file',
    description:
      'Replace text in one file. oldText must match exactly once unless replaceAll is set; ' +
      'include enough surrounding context to make it unique. This changes files on disk.',
    parameters: v.object({
      path: v.string().describe('File path, relative to the project root or absolute'),
      oldText: v.string().describe('Exact text to replace'),
      newText: v.string().describe('Replacement text'),
      replaceAll: v.boolean().optional().describe('Replace every occurrence'),
    }),
    risk: 'writes files',
    sideEffects: true,
    requiresApproval: !(opts.auto ?? false),
    execute: async ({
      path,
      oldText,
      newText,
      replaceAll = false,
    }: {
      path: string;
      oldText: string;
      newText: string;
      replaceAll?: boolean;
    }) => {
      const target = resolvePath(cwd, path, confine);
      if (target === null) return escapeError(path);
      let text: string;
      try {
        text = new TextDecoder().decode(await fs.readFile(target));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `Cannot read ${path}: ${message}`, isError: true };
      }
      if (oldText.length === 0) {
        return { content: 'oldText must not be empty', isError: true };
      }
      const count = text.split(oldText).length - 1;
      if (count === 0) {
        return { content: `oldText not found in ${path}`, isError: true };
      }
      if (count > 1 && !replaceAll) {
        return {
          content: `oldText matches ${count} times in ${path}; add context or set replaceAll`,
          isError: true,
        };
      }
      const next = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText);
      await fs.writeFile(target, new TextEncoder().encode(next));
      return `Edited ${path} (${replaceAll ? count : 1} replacement${count > 1 ? 's' : ''})`;
    },
  });
}

/**
 * Build the `shell` tool: run a command from the workspace root.
 *
 * The command runs under `/bin/sh -c`, is killed on timeout or run
 * cancellation, and reports exit code, stdout, and stderr. A non-zero exit is
 * an `isError` tool result. Declares `requiresApproval` unless `auto` is set.
 *
 * ```ts no_run
 * import { shellTool } from 'fino:ai/tools';
 *
 * const shell = shellTool({ cwd: '/repo' });
 * ```
 */
export function shellTool(opts: MutatingToolOptions): Tool {
  const cwd = opts.cwd;
  const confine = opts.confine ?? false;
  return tool({
    name: 'shell',
    description:
      'Run a shell command from the project root and return its exit code, stdout, and ' +
      'stderr. Use for builds, tests (fino test, cargo test), git, and other project ' +
      'commands. This can change system state.',
    parameters: v.object({
      command: v.string().describe('Command line passed to /bin/sh -c'),
      timeoutMs: v
        .integer()
        .min(1)
        .max(600_000)
        .optional()
        .describe('Kill the command after this many milliseconds (default 120000)'),
    }),
    risk: 'executes commands',
    sideEffects: true,
    requiresApproval: !(opts.auto ?? false),
    timeoutMs: 630_000,
    execute: async (
      {
        command,
        timeoutMs = 120_000,
      }: {
        command: string;
        timeoutMs?: number;
      },
      ctx,
    ) => {
      const proc = new Process('/bin/sh', ['-c', command], { cwd });
      proc.stdin.close();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          kill(proc.pid, SIGKILL);
        } catch (_) {
          // already exited
        }
      }, timeoutMs);
      const onAbort = () => {
        try {
          kill(proc.pid, SIGKILL);
        } catch (_) {
          // already exited
        }
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const [stdout, stderr, result] = await Promise.all([
          readAllText(proc.stdout),
          readAllText(proc.stderr),
          proc.wait(),
        ]);
        const sections = [
          timedOut ? `[killed after ${timeoutMs}ms]` : `exit code: ${result.code ?? 'signal'}`,
        ];
        if (stdout.trim().length > 0) sections.push(`stdout:\n${stdout.trimEnd()}`);
        if (stderr.trim().length > 0) sections.push(`stderr:\n${stderr.trimEnd()}`);
        const content = truncate(sections.join('\n'));
        const failed = timedOut || (result.code !== 0 && result.code !== null);
        return failed ? { content, isError: true } : content;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
  });
}

/**
 * Build the workspace tool set.
 *
 * Always includes the read-only tools (`list_files`, `read_file`,
 * `search_files`). When `writes` is enabled (the default) the mutating tools
 * (`write_file`, `edit_file`, `shell`) are appended; they declare
 * `requiresApproval` unless `auto` is set, so an interactive session suspends
 * for a decision before they run.
 *
 * ```ts no_run
 * import { createWorkspaceTools } from 'fino:ai/tools';
 *
 * const planning = createWorkspaceTools({ cwd: '/repo', writes: false });
 * const full = createWorkspaceTools({ cwd: '/repo', auto: true });
 * ```
 */
export function createWorkspaceTools(opts: WorkspaceToolsOptions): Tool[] {
  const cwd = opts.cwd;
  const confine = opts.confine ?? false;
  const auto = opts.auto ?? false;
  const tools = [listFilesTool({ cwd }), readFileTool({ cwd }), searchFilesTool({ cwd })];
  if (opts.writes ?? true) {
    tools.push(writeFileTool({ cwd, auto }), editFileTool({ cwd, auto }), shellTool({ cwd, auto }));
  }
  return tools;
}
