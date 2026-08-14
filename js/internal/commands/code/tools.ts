/**
 * internal:commands/code/tools — the tool set behind `fino code` and `fino mcp`.
 *
 * `createCodeTools()` layers the Fino-specific tools — full-text documentation
 * search and symbol lookup backed by the `fino doc` index — on top of the
 * general-purpose workspace tools from `fino:ai/tools`. Only the documentation
 * tools live here; file listing/reading/searching, writing, in-place editing,
 * and shell execution are the public `fino:ai/tools` set, which any coding
 * agent can use. The same combined set powers the interactive coding agent and
 * the MCP server, so the capability policy (read-only versus write,
 * approval-gated versus auto-approved) is decided here once via options.
 *
 * ```ts no_run
 * import { createCodeTools } from 'internal:commands/code/tools';
 *
 * const tools = createCodeTools({ cwd: '/repo', writes: true });
 * const names = tools.map((t) => t.name);
 * // ['docs_search', 'docs_show', 'list_files', 'read_file',
 * //  'search_files', 'write_file', 'edit_file', 'shell']
 * ```
 */
import { tool, Tool } from 'fino:ai/tool';
import { createWorkspaceTools } from 'fino:ai/tools';
import { v } from 'fino:validate';
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
   * Directory holding a `fino doc build` output tree, surfaced to the model
   * so it can `read_file` guides directly. Defaults to `<cwd>/docs`.
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

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[output truncated at ${limit} characters]`;
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

/**
 * Build the Fino documentation tools (`docs_search`, `docs_show`).
 *
 * Both are read-only and query the `fino doc build` index through the
 * `fino:commands/doc` task, so they only make sense inside a project that has
 * one.
 *
 * ```ts no_run
 * import { createDocsTools } from 'internal:commands/code/tools';
 *
 * const docs = createDocsTools();
 * // ['docs_search', 'docs_show']
 * ```
 */
export function createDocsTools(): Tool[] {
  return [docsSearchTool(), docsShowTool()];
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

/**
 * Build the Fino coding tool set.
 *
 * The Fino documentation tools (`docs_search`, `docs_show`) lead, followed by
 * the public workspace tools from `fino:ai/tools`: the read-only
 * `list_files`, `read_file`, and `search_files`, plus — when `writes` is
 * enabled (the default) — the mutating `write_file`, `edit_file`, and
 * `shell`, which declare `requiresApproval` unless `auto` is set, so an
 * interactive session suspends for a decision before they run.
 *
 * ```ts no_run
 * import { createCodeTools } from 'internal:commands/code/tools';
 *
 * const planning = createCodeTools({ cwd: '/repo', writes: false });
 * const full = createCodeTools({ cwd: '/repo', auto: true });
 * ```
 */
export function createCodeTools(opts: CodeToolsOptions): Tool[] {
  return [
    ...createDocsTools(),
    ...createWorkspaceTools({ cwd: opts.cwd, writes: opts.writes, auto: opts.auto }),
  ];
}
