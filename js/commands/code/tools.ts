/**
 * fino:commands/code/tools — the tool set behind `fino code` and `fino mcp`.
 *
 * `createCodeTools()` builds validated `fino:ai` tools for developing on the
 * Fino platform: full-text documentation search and symbol lookup backed by
 * the `fino doc` index, guide reading, file listing/reading/searching, and —
 * when enabled — file writing, in-place editing, and shell execution. The
 * same tools power the interactive coding agent and the MCP server, so the
 * capability policy (read-only versus write, approval-gated versus
 * auto-approved) is decided here once via options.
 *
 * ```ts no_run
 * import { createCodeTools } from 'fino:commands/code/tools';
 *
 * const tools = createCodeTools({ cwd: '/repo', writes: true });
 * const names = tools.map((t) => t.name);
 * // ['docs_search', 'docs_show', 'read_doc', 'list_files', 'read_file',
 * //  'search_files', 'write_file', 'edit_file', 'shell']
 * ```
 */
import { tool, Tool } from 'fino:ai/tool';
import { v } from 'fino:validate';
import { DiskFileSystem, Glob } from 'fino:file';
import { dirname, isAbsolute, join, relative } from 'fino:file/path';
import { kill, Process, SIGKILL } from 'fino:process';
import type { Task } from '../../task.ts';

/**
 * Options for `createCodeTools()`.
 */
export interface CodeToolsOptions {
  /**
   * Project root that relative tool paths resolve against.
   */
  cwd: string;
  /**
   * Directory holding a `fino doc build` output tree, used by `read_doc` to
   * resolve guide paths. Defaults to `<cwd>/docs`.
   */
  docsDir?: string;
  /**
   * Include the mutating tools (`write_file`, `edit_file`, `shell`).
   *
   * Defaults to `true`. Set `false` for a read-only tool set, such as the
   * coding agent's planning mode or an unprivileged MCP mount.
   */
  writes?: boolean;
  /**
   * Drop `requiresApproval` from the mutating tools so they execute without
   * suspending for approval. Defaults to `false`.
   */
  auto?: boolean;
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

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path).toString();
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

async function loadDocTask(): Promise<Task> {
  const mod = (await import('fino:commands/doc')) as { default: Task };
  return mod.default;
}

interface DocJsonResult {
  found?: boolean;
  output?: string;
}

const DOC_BUILD_HINT =
  'No documentation index found. Build one first with: fino doc build --types runtime-builtins.d.ts js ' +
  '(from the fino repository root), or point the tools at a project that has run `fino doc build`.';

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
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('no prior doc build')) {
          return { content: DOC_BUILD_HINT, isError: true };
        }
        return { content: `docs_search failed: ${message}`, isError: true };
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
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('no prior doc build')) {
          return { content: DOC_BUILD_HINT, isError: true };
        }
        return { content: `docs_show failed: ${message}`, isError: true };
      }
    },
  });
}

function readDocTool(fs: DiskFileSystem, cwd: string, docsDir: string): Tool {
  return tool({
    name: 'read_doc',
    description:
      'Read an authored Fino guide by its markdown path, e.g. "ai.md", "realm/facades.md", ' +
      'or "cli/test.md". Guides are resolved against the docs build directory, then the ' +
      'repository js/ tree. Read-only.',
    parameters: v.object({
      path: v.string().describe('Guide path ending in .md, relative to the docs root'),
    }),
    execute: async ({ path }: { path: string }) => {
      if (!path.endsWith('.md') || path.includes('..') || isAbsolute(path)) {
        return { content: 'path must be a relative .md guide path', isError: true };
      }
      const candidates = [join(docsDir, path).toString(), join(cwd, 'js', path).toString()];
      for (const candidate of candidates) {
        try {
          const bytes = await fs.readFile(candidate);
          return truncate(new TextDecoder().decode(bytes));
        } catch (_) {
          continue;
        }
      }
      return {
        content: `Guide not found: ${path} (looked in ${candidates.join(', ')})`,
        isError: true,
      };
    },
  });
}

function listFilesTool(fs: DiskFileSystem, cwd: string): Tool {
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

function readFileTool(fs: DiskFileSystem, cwd: string): Tool {
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
      const target = resolvePath(cwd, path);
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

function searchFilesTool(fs: DiskFileSystem, cwd: string): Tool {
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

function writeFileTool(fs: DiskFileSystem, cwd: string, auto: boolean): Tool {
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
    requiresApproval: !auto,
    execute: async ({ path, content }: { path: string; content: string }) => {
      const target = resolvePath(cwd, path);
      await mkdirRecursive(fs, dirname(target).toString());
      await fs.writeFile(target, new TextEncoder().encode(content));
      return `Wrote ${content.length} characters to ${path}`;
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

function editFileTool(fs: DiskFileSystem, cwd: string, auto: boolean): Tool {
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
    requiresApproval: !auto,
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
      const target = resolvePath(cwd, path);
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

function shellTool(cwd: string, auto: boolean): Tool {
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
    requiresApproval: !auto,
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
 * Build the Fino coding tool set.
 *
 * Always includes the read-only tools (`docs_search`, `docs_show`,
 * `read_doc`, `list_files`, `read_file`, `search_files`). When
 * `writes` is enabled (the default) the mutating tools (`write_file`,
 * `edit_file`, `shell`) are appended; they declare `requiresApproval` unless
 * `auto` is set, so an interactive session suspends for a decision before
 * they run.
 *
 * ```ts no_run
 * import { createCodeTools } from 'fino:commands/code/tools';
 *
 * const planning = createCodeTools({ cwd: '/repo', writes: false });
 * const full = createCodeTools({ cwd: '/repo', auto: true });
 * ```
 */
export function createCodeTools(opts: CodeToolsOptions): Tool[] {
  const fs = new DiskFileSystem();
  const cwd = opts.cwd;
  const docsDir = opts.docsDir ?? join(cwd, 'docs').toString();
  const tools = [
    docsSearchTool(),
    docsShowTool(),
    readDocTool(fs, cwd, docsDir),
    listFilesTool(fs, cwd),
    readFileTool(fs, cwd),
    searchFilesTool(fs, cwd),
  ];
  if (opts.writes ?? true) {
    tools.push(
      writeFileTool(fs, cwd, opts.auto ?? false),
      editFileTool(fs, cwd, opts.auto ?? false),
      shellTool(cwd, opts.auto ?? false),
    );
  }
  return tools;
}
