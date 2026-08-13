import { describe, it } from 'fino:test/test';
import { MCPClient, mcpServer } from 'fino:ai/mcp';
import { createCodeTools } from 'fino:commands/code/tools';
import mcpCommand from 'fino:commands/mcp';
import { env, execPath, Process } from 'fino:process';
import * as loop from 'internal:runtime/loop';
import type { Transport } from 'fino:jsonrpc';

class MessageQueue {
  #buf: string[] = [];
  #waiters: Array<(s: string) => void> = [];
  #closed = false;
  push(msg: string): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(msg);
    else this.#buf.push(msg);
  }
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter('');
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      if (this.#buf.length > 0) {
        yield this.#buf.shift()!;
        continue;
      }
      if (this.#closed) return;
      const msg = await new Promise<string>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (msg === '' && this.#closed) return;
      if (msg) yield msg;
    }
  }
}

function loopbackPair(): [Transport, Transport] {
  const aToB = new MessageQueue();
  const bToA = new MessageQueue();
  const a: Transport = {
    send: (msg) => {
      aToB.push(msg);
    },
    receive: () => bToA,
    close: () => {
      aToB.close();
      bToA.close();
    },
  };
  const b: Transport = {
    send: (msg) => {
      bToA.push(msg);
    },
    receive: () => aToB,
    close: () => {
      aToB.close();
      bToA.close();
    },
  };
  return [a, b];
}

describe('fino:commands/mcp — coding tools over MCP', () => {
  it('answers initialization over a real stdio process', async (t) => {
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[key] = value;
    }
    childEnv.FINO_REACTOR_THREADS = '1';
    const proc = new Process(execPath, ['mcp'], { env: childEnv });
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

  it('lists the read-only tool set and executes docs-independent tools', async (t) => {
    const dir = `/tmp/fino-mcp-test-${Date.now().toString(36)}`;
    const tools = createCodeTools({ cwd: dir, writes: false, auto: true });
    const server = mcpServer({ name: 'fino', version: '0.1.0', tools });
    const [clientSide, serverSide] = loopbackPair();
    void server.serve(serverSide);
    const client = new MCPClient({ transport: clientSide });
    await client.connect();
    const listed = await client.listTools();
    const names = listed.map((entry) => entry.name).sort();
    t.deepEqual(
      names,
      ['docs_search', 'docs_show', 'list_files', 'read_file', 'search_files'],
      'read-only tools exposed',
    );
    const listFiles = listed.find((entry) => entry.name === 'list_files')!;
    const result = await listFiles.run({ pattern: '**/*' });
    t.ok(String(result).length > 0, 'remote tool call returns content');
    await client.close();
  });

  it('exposes gated tools only when the policy enables them', async (t) => {
    const all = createCodeTools({ cwd: '/tmp', writes: true, auto: true });
    const shellOnly = all.filter((tool) => tool.name !== 'write_file' && tool.name !== 'edit_file');
    const server = mcpServer({ name: 'fino', tools: shellOnly });
    const [clientSide, serverSide] = loopbackPair();
    void server.serve(serverSide);
    const client = new MCPClient({ transport: clientSide });
    await client.connect();
    const names = (await client.listTools()).map((entry) => entry.name);
    t.ok(names.includes('shell'), 'shell exposed when allowed');
    t.ok(!names.includes('write_file'), 'write_file absent without --allow-write');
    await client.close();
  });

  it('declares the expected CLI surface', (t) => {
    const help = mcpCommand.help();
    t.ok(help.includes('mcp [options]'), 'usage line');
    t.ok(help.includes('--allow-write'), 'write gate flag');
    t.ok(help.includes('--allow-shell'), 'shell gate flag');
    t.ok(help.includes('--http'), 'http mode flag');
  });
});
