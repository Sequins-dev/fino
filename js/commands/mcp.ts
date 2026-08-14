/**
 * fino:commands/mcp — serve the Fino-specific development tools over MCP.
 *
 * `fino mcp` exposes only what a host cannot already do for itself. Generic
 * file listing, reading, and searching are left to the MCP client; what ships
 * here is the Fino documentation index (`docs_search`, `docs_show`) plus
 * Fino's own commands as `fino_*` tools — the test runner, benchmark runner,
 * linter, formatter, package installer, and project scaffolder. Authored
 * guides from the docs build are listed as MCP resources under `fino-doc://`.
 *
 * By default the server speaks newline-delimited JSON-RPC over this process's
 * stdio (the transport MCP hosts use to launch server commands) and exposes
 * only the read-only tools: `docs_search`, `docs_show`, and `fino_lint`.
 * `--allow-write` adds the tools that change files — `write_file`,
 * `edit_file`, `fino_fmt`, `fino_install`, `fino_init`. `--allow-shell` adds
 * `shell` plus `fino_test` and `fino_bench`, which run arbitrary project code
 * and so carry the same risk as a shell. `--http <port>` serves the Streamable
 * HTTP transport instead of stdio.
 *
 * ```sh
 * fino mcp                       # stdio, read-only tools
 * fino mcp --allow-write --allow-shell
 * fino mcp --http 8090           # Streamable HTTP on 127.0.0.1:8090/mcp
 * ```
 */
import { Task } from '../task.ts';
import { cwd } from '../process.ts';
import type { Tool } from 'fino:ai/tool';

/**
 * Options for `createMcpTools()`.
 */
export interface McpToolsOptions {
  /**
   * Project root the tools operate against, normally the server process
   * working directory.
   */
  cwd: string;
  /**
   * Directory holding a `fino doc build` output tree used by `docs_search`
   * and `docs_show`. Defaults to `<cwd>/docs`.
   */
  docsDir?: string;
  /**
   * Expose the tools that change files: `write_file`, `edit_file`,
   * `fino_fmt`, `fino_install`, `fino_init`. Defaults to `false`.
   */
  allowWrite?: boolean;
  /**
   * Expose the tools that execute code: `shell`, `fino_test`, `fino_bench`.
   * Defaults to `false`.
   */
  allowShell?: boolean;
}

/**
 * Build the tool set `fino mcp` mounts for one policy.
 *
 * Only `docs_search`, `docs_show`, and `fino_lint` are unconditional. The
 * generic file tools that `fino code` uses (`list_files`, `read_file`,
 * `search_files`) are deliberately dropped here — every MCP host already has
 * them, so the server keeps to what is unique to Fino.
 *
 * ```ts no_run
 * import { createMcpTools } from 'fino:commands/mcp';
 *
 * const tools = await createMcpTools({ cwd: '/repo' });
 * // ['docs_search', 'docs_show', 'fino_lint']
 * ```
 */
export async function createMcpTools(opts: McpToolsOptions): Promise<Tool[]> {
  const { createCodeTools } = await import('fino:commands/code/tools');
  const { createFinoCommandTools } = await import('fino:commands/mcp/tools');
  const { join } = await import('fino:file/path');
  const allowWrite = opts.allowWrite ?? false;
  const allowShell = opts.allowShell ?? false;
  const exposed = new Set(['docs_search', 'docs_show']);
  if (allowWrite) {
    exposed.add('write_file');
    exposed.add('edit_file');
  }
  if (allowShell) exposed.add('shell');
  const tools = createCodeTools({
    cwd: opts.cwd,
    docsDir: opts.docsDir ?? join(opts.cwd, 'docs').toString(),
    writes: allowWrite || allowShell,
    auto: true,
  }).filter((t) => exposed.has(t.name));
  tools.push(...createFinoCommandTools({ cwd: opts.cwd, writes: allowWrite, shell: allowShell }));
  return tools;
}

interface McpCommandInput {
  'allow-write'?: boolean;
  'allow-shell'?: boolean;
  http?: number;
  'docs-dir'?: string;
}

const MCP_INSTRUCTIONS = [
  'Fino platform development tools. Fino is a JS/TS runtime with a thin native core;',
  'its standard library lives in fino:* modules. Use docs_search first to discover which',
  'module serves a use case, then docs_show for exact symbol reference. Full authored',
  'guides are MCP resources, not tools: list resources and read the fino-doc:// URI you',
  'need. The fino_* tools run the project Fino toolchain — fino_lint, fino_fmt,',
  'fino_test, fino_bench, fino_install, fino_init — relative to the server process',
  'working directory. Read and edit source files with your own tools.',
].join(' ');

const command = new Task({
  name: 'mcp',
  description: 'Serve the Fino coding tools over the Model Context Protocol',
  outputMode: 'text',
  run: async function runMcpCommand(input: McpCommandInput, ctx) {
    const root = ctx.cwd ?? cwd();
    const { mcpServer, stdioServerTransport } = await import('fino:ai/mcp');
    const { DiskFileSystem } = await import('fino:file');
    const { join } = await import('fino:file/path');
    const docsDir = input['docs-dir'] ?? join(root, 'docs').toString();
    const tools = await createMcpTools({
      cwd: root,
      docsDir,
      allowWrite: input['allow-write'] ?? false,
      allowShell: input['allow-shell'] ?? false,
    });
    const fs = new DiskFileSystem();
    const server = mcpServer({
      name: 'fino',
      version: '0.1.0',
      instructions: MCP_INSTRUCTIONS,
      tools,
      resources: async () => {
        const resources = [];
        try {
          for await (const entry of fs.glob('**/*.md', { cwd: docsDir, onlyFiles: true })) {
            const rel = entry.path.toString().slice(docsDir.length + 1);
            resources.push({
              uri: `fino-doc://${rel}`,
              name: rel,
              mimeType: 'text/markdown',
            });
          }
        } catch (_) {
          // no docs build; expose no resources
        }
        return resources;
      },
      readResource: async (uri) => {
        if (!uri.startsWith('fino-doc://')) throw new Error(`Unknown resource: ${uri}`);
        const rel = uri.slice('fino-doc://'.length);
        if (rel.includes('..') || rel.startsWith('/')) throw new Error(`Invalid resource: ${uri}`);
        const bytes = await fs.readFile(join(docsDir, rel).toString());
        return {
          uri,
          mimeType: 'text/markdown',
          text: new TextDecoder().decode(bytes),
        };
      },
    });
    if (input.http !== undefined) {
      const { App } = await import('fino:net/http/app');
      const { mountMcp } = await import('fino:ai/mcp');
      const app = new App();
      mountMcp(app, '/mcp', server);
      await ctx.writer.writeText?.(
        `fino mcp: serving Streamable HTTP on http://127.0.0.1:${input.http}/mcp\n`,
      );
      await app.listen({ port: input.http });
      await new Promise<void>(() => {});
      return '';
    }
    await server.serve(stdioServerTransport());
    return '';
  },
  cli: {
    usage: 'fino mcp [options]',
    options: [
      {
        flags: '--allow-write',
        type: 'boolean',
        description:
          'Expose the tools that change files: write_file, edit_file, fino_fmt, fino_install, fino_init',
      },
      {
        flags: '--allow-shell',
        type: 'boolean',
        description: 'Expose the tools that execute code: shell, fino_test, fino_bench',
      },
      {
        flags: '--http',
        type: 'number',
        description: 'Serve Streamable HTTP on this port instead of stdio',
      },
      { flags: '--docs-dir', type: 'string', description: 'Docs build directory (default ./docs)' },
    ],
  },
});

export { command as default };
