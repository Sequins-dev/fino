import { describe, it } from 'fino:test/test';
import { MCPClient } from 'fino:ai/mcp';
import mcpCommand, { createMcpTools } from 'fino:commands/mcp';
import { DiskFileSystem } from 'fino:file';
import { env, execPath, Process } from 'fino:process';
import * as loop from 'internal:runtime/loop';
import type { Transport } from 'fino:jsonrpc';

/** Tools the host agent brings; the server never exposes them, at any gate. */
const HOST_TOOLS = ['list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'shell'];

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  out.FINO_REACTOR_THREADS = '1';
  return out;
}

async function* splitLines(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) yield line;
      index = buffer.indexOf('\n');
    }
  }
  if (buffer.trim().length > 0) yield buffer.trim();
}

function processTransport(proc: Process): Transport {
  const encoder = new TextEncoder();
  return {
    send: async (message) => {
      await proc.stdin.write(encoder.encode(`${message}\n`));
      await proc.stdin.flush();
    },
    receive: () => splitLines(proc.stdout),
    close: () => {
      proc.stdin.close();
    },
  };
}

async function toolNames(options: {
  allowWrite?: boolean;
  allowShell?: boolean;
}): Promise<string[]> {
  const tools = await createMcpTools({ cwd: '/tmp', ...options });
  return tools.map((entry) => entry.name).sort();
}

async function makeTempProject(name: string, files: Record<string, string>): Promise<string> {
  const fs = new DiskFileSystem();
  const dir = `/tmp/fino-mcp-${name}-${Date.now().toString(36)}`;
  await fs.mkdir(dir);
  const encoder = new TextEncoder();
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(`${dir}/${file}`, encoder.encode(content));
  }
  return dir;
}

describe('fino:commands/mcp — coding tools over MCP', () => {
  it('answers initialization over a real stdio process', async (t) => {
    const proc = new Process(execPath, ['mcp'], { env: childEnv() });
    // Debug-build child startup is ~0.6s cold; leave generous headroom for a
    // loaded test runner — the assertion is about responding at all.
    const timer = loop.timeout(10_000);
    try {
      await proc.stdin.write(
        new TextEncoder().encode(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'fino-test', version: '1.0.0' },
            },
          })}\n`,
        ),
      );
      await proc.stdin.flush();
      const first = proc.stdout[Symbol.asyncIterator]().next();
      const result = await Promise.race([
        first.then((value) => ({ kind: 'response' as const, value })),
        timer.then(() => ({ kind: 'timeout' as const })),
      ]);
      t.equal(result.kind, 'response', 'server responds before the initialization timeout');
      if (result.kind === 'response') {
        const message = JSON.parse(new TextDecoder().decode(result.value.value));
        t.equal(message.id, 1, 'response matches the initialization request');
        t.equal(message.result.serverInfo.name, 'fino', 'response identifies the Fino server');
      }
    } finally {
      timer.cancel();
      proc.stdin.close();
      try {
        proc.kill();
      } catch {}
      await proc.wait();
    }
  });

  it('exposes only Fino-specific tools by default', async (t) => {
    const names = await toolNames({});
    t.deepEqual(names, ['docs_search', 'docs_show', 'fino_lint'], 'read-only tool set');
    for (const generic of HOST_TOOLS) {
      t.ok(!names.includes(generic), `${generic} left to the MCP host`);
    }
    for (const gated of ['fino_fmt', 'fino_install', 'fino_init', 'fino_test', 'fino_bench']) {
      t.ok(!names.includes(gated), `${gated} absent without its flag`);
    }
  });

  it('adds the file-changing commands under --allow-write', async (t) => {
    const names = await toolNames({ allowWrite: true });
    for (const gated of ['fino_fmt', 'fino_install', 'fino_init']) {
      t.ok(names.includes(gated), `${gated} exposed with --allow-write`);
    }
    t.ok(!names.includes('fino_test'), 'fino_test still gated');
    t.ok(!names.includes('fino_bench'), 'fino_bench still gated');
    for (const generic of HOST_TOOLS) {
      t.ok(!names.includes(generic), `${generic} still left to the MCP host`);
    }
  });

  it('adds the code-executing commands under --allow-shell', async (t) => {
    const names = await toolNames({ allowShell: true });
    for (const gated of ['fino_test', 'fino_bench']) {
      t.ok(names.includes(gated), `${gated} exposed with --allow-shell`);
    }
    t.ok(!names.includes('fino_fmt'), 'fino_fmt still gated');
    for (const generic of HOST_TOOLS) {
      t.ok(!names.includes(generic), `${generic} still left to the MCP host`);
    }
  });

  it('gates the fino_lint fix parameter behind --allow-write', async (t) => {
    const readOnly = (await createMcpTools({ cwd: '/tmp' })).find(
      (entry) => entry.name === 'fino_lint',
    )!;
    const writable = (await createMcpTools({ cwd: '/tmp', allowWrite: true })).find(
      (entry) => entry.name === 'fino_lint',
    )!;
    const properties = (schema: unknown) =>
      Object.keys((schema as { properties?: Record<string, unknown> }).properties ?? {});
    t.ok(!properties(readOnly.parameters).includes('fix'), 'no fix parameter by default');
    t.ok(properties(writable.parameters).includes('fix'), 'fix parameter with --allow-write');
  });

  it('runs fino_lint end to end over a real MCP session', async (t) => {
    const dir = await makeTempProject('lint', {
      'clean.ts': 'export const answer = 42;\n',
    });
    const proc = new Process(execPath, ['mcp'], { cwd: dir, env: childEnv() });
    const timer = loop.timeout(60_000);
    try {
      const client = new MCPClient({ transport: processTransport(proc) });
      const session = (async () => {
        await client.connect();
        const listed = await client.listTools();
        const lint = listed.find((entry) => entry.name === 'fino_lint');
        if (!lint) return { names: listed.map((entry) => entry.name), output: '' };
        const output = String(await lint.run({ paths: ['clean.ts'] }));
        return { names: listed.map((entry) => entry.name), output };
      })();
      const result = await Promise.race([
        session.then((value) => ({ kind: 'done' as const, value })),
        timer.then(() => ({ kind: 'timeout' as const })),
      ]);
      t.equal(result.kind, 'done', 'session completes before the timeout');
      if (result.kind === 'done') {
        t.deepEqual(
          result.value.names.sort(),
          ['docs_search', 'docs_show', 'fino_lint'],
          'wire tool list matches the default policy',
        );
        t.ok(
          result.value.output.includes('1 file checked'),
          `fino_lint reports the checked file (got: ${result.value.output})`,
        );
      }
      await client.close();
    } finally {
      timer.cancel();
      proc.stdin.close();
      try {
        proc.kill();
      } catch {}
      await proc.wait();
    }
  });

  it('declares the expected CLI surface', (t) => {
    const help = mcpCommand.help();
    t.ok(help.includes('mcp [options]'), 'usage line');
    t.ok(help.includes('--allow-write'), 'write gate flag');
    t.ok(help.includes('fino_fmt'), 'write gate names the Fino command tools it unlocks');
    t.ok(help.includes('--allow-shell'), 'shell gate flag');
    t.ok(help.includes('fino_test'), 'shell gate names the Fino command tools it unlocks');
    t.ok(help.includes('--http'), 'http mode flag');
  });
});
