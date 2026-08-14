/**
 * internal:commands/code/tools — the tool set behind `fino code`.
 *
 * `createCodeTools()` is the coding agent's policy layer and nothing more: it
 * lays the Fino-specific tools of `internal:commands/tools` — documentation
 * search and symbol lookup, plus Fino's own commands as `fino_*` tools — over
 * the general-purpose workspace tools of `fino:ai/tools`, and decides from one
 * set of options which capabilities each layer gets. Neither layer is defined
 * here: the Fino tools are shared with `fino mcp`, and file listing, reading,
 * searching, writing, in-place editing, and shell execution are the public
 * `fino:ai/tools` set any coding agent can use.
 *
 * ```ts no_run
 * import { createCodeTools } from 'internal:commands/code/tools';
 *
 * const tools = createCodeTools({ cwd: '/repo', writes: true });
 * const names = tools.map((entry) => entry.name);
 * // ['docs_search', 'docs_show', 'fino_lint', 'fino_fmt', 'fino_install',
 * //  'fino_init', 'fino_test', 'fino_bench', 'list_files', 'read_file',
 * //  'search_files', 'write_file', 'edit_file', 'shell']
 * ```
 */
import type { Tool } from 'fino:ai/tool';
import { createWorkspaceTools } from 'fino:ai/tools';
import { createFinoTools } from 'internal:commands/tools';

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
   * Include the mutating tools — `write_file`, `edit_file`, `shell`, and the
   * `fino_*` commands that change files or run project code.
   *
   * Defaults to `true`. Set `false` for a read-only tool set, such as the
   * coding agent's planning mode.
   */
  writes?: boolean;
  /**
   * Drop `requiresApproval` from the mutating tools so they execute without
   * suspending for approval. Defaults to `false`.
   */
  auto?: boolean;
}

/**
 * Build the Fino coding tool set.
 *
 * The Fino tools lead — `docs_search` and `docs_show`, then the `fino_*`
 * commands — followed by the public workspace tools from `fino:ai/tools`.
 * `writes` gates both layers together: with it off (the coding agent's
 * planning mode) the set narrows to `docs_search`, `docs_show`, `fino_lint`,
 * `list_files`, `read_file`, and `search_files`. With it on, everything that
 * writes a file or runs project code is added and declares `requiresApproval`
 * unless `auto` is set, so an interactive session suspends for a decision
 * before any of it runs.
 *
 * ```ts no_run
 * import { createCodeTools } from 'internal:commands/code/tools';
 *
 * const planning = createCodeTools({ cwd: '/repo', writes: false });
 * const full = createCodeTools({ cwd: '/repo', auto: true });
 * ```
 */
export function createCodeTools(opts: CodeToolsOptions): Tool[] {
  const writes = opts.writes ?? true;
  return [
    ...createFinoTools({ cwd: opts.cwd, writes, shell: writes, auto: opts.auto }),
    ...createWorkspaceTools({ cwd: opts.cwd, writes, auto: opts.auto }),
  ];
}
