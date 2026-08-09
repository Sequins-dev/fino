/**
 * fino:commands/mcp — serve the Fino coding tools over the Model Context Protocol.
 *
 * `fino mcp` mounts the same tool set that powers `fino code` — documentation
 * search and symbol lookup, guide reading, file listing/reading/searching,
 * and optionally file writing and shell execution — on an MCP server, so
 * other coding agents and MCP-capable editors can develop with Fino too. By
 * default the server speaks newline-delimited JSON-RPC over this process's
 * stdio (the transport MCP hosts use to launch server commands) and exposes
 * only the read-only tools; `--allow-write` and `--allow-shell` opt into the
 * mutating tools, and `--http <port>` serves the Streamable HTTP transport
 * instead. Authored guides from the docs build are also listed as MCP
 * resources.
 *
 * ```sh
 * fino mcp                       # stdio, read-only tools
 * fino mcp --allow-write --allow-shell
 * fino mcp --http 8090           # Streamable HTTP on 127.0.0.1:8090/mcp
 * ```
 */
import { Task } from '../task.ts';
import { cwd } from '../process.ts';

interface McpCommandInput {
  'allow-write'?: boolean;
  'allow-shell'?: boolean;
  http?: number;
  'docs-dir'?: string;
}

const MCP_INSTRUCTIONS = [
  'Fino platform development tools. Fino is a JS/TS runtime with a thin native core;',
  'its standard library lives in fino:* modules. Use docs_search first to discover which',
  'module serves a use case, docs_show for exact symbol reference, and read_doc for full',
  'guides. File and shell tools operate relative to the server process working directory.',
].join(' ');

const command = new Task({
  name: 'mcp',
  description: 'Serve the Fino coding tools over the Model Context Protocol',
  outputMode: 'text',
  run: async function runMcpCommand(input: McpCommandInput, ctx) {
    const root = ctx.cwd ?? cwd();
    const { mcpServer, stdioServerTransport } = await import('fino:ai/mcp');
    const { createCodeTools } = await import('fino:commands/code/tools');
    const { DiskFileSystem } = await import('fino:file');
    const { join } = await import('fino:file/path');
    const allowWrite = input['allow-write'] ?? false;
    const allowShell = input['allow-shell'] ?? false;
    const docsDir = input['docs-dir'] ?? join(root, 'docs').toString();
    let tools = createCodeTools({
      cwd: root,
      docsDir,
      writes: allowWrite || allowShell,
      auto: true,
    });
    if (allowWrite || allowShell) {
      tools = tools.filter((t) => {
        if (t.name === 'shell') return allowShell;
        if (t.name === 'write_file' || t.name === 'edit_file') return allowWrite;
        return true;
      });
    }
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
      { flags: '--allow-write', type: 'boolean', description: 'Expose write_file and edit_file' },
      { flags: '--allow-shell', type: 'boolean', description: 'Expose the shell tool' },
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
