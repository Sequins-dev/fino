import { describe, it } from 'fino:test/test';
import { agentDriver, httpChannel, webhookChannel, websocketChannel } from 'fino:ai/channel';
import { agent } from 'fino:ai/agent';
import { tool } from 'fino:ai/tool';
import { SuspendSignal } from 'fino:ai/runtime';
import type { CheckpointStore } from 'fino:ai/session';
import type { RunState } from 'fino:ai/session';
import type { MessageHistoryEntry, MessageHistoryRevision, MessageHistorySnapshot } from 'fino:ai/context';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Model, ModelStream, GenerateRequest, StreamEvent } from 'fino:ai/model';

function scriptModel(turns: StreamEvent[][]): Model {
  let idx = 0;
  return {
    name: 'script-model',
    dimensions: 0,
    stream(_req: GenerateRequest): ModelStream {
      const turn = turns[idx % turns.length] ?? [];
      idx++;
      async function* gen() { yield* turn; }
      return new ModelStreamImpl(gen());
    },
    async generate(_req: GenerateRequest) { throw new Error('use stream'); },
    async embed() { return []; },
  };
}

function endTurn(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', index: 0, text },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
    { type: 'stop', reason: 'end_turn' },
  ];
}

function toolCallTurn(id: string, name: string, argsJson: string): StreamEvent[] {
  return [
    { type: 'tool_call_start', index: 0, id, name },
    { type: 'tool_call_delta', index: 0, json: argsJson },
    { type: 'tool_call_end', index: 0 },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } },
    { type: 'stop', reason: 'tool_use' },
  ];
}

class MemStore implements CheckpointStore {
  #runs = new Map<string, RunState>();
  #entries = new Map<string, MessageHistoryEntry>();
  #revisions = new Map<string, MessageHistoryRevision>();
  async saveEntry(entry: MessageHistoryEntry): Promise<void> { this.#entries.set(entry.id, entry); }
  async saveRevision(revision: MessageHistoryRevision): Promise<void> { this.#revisions.set(revision.id, revision); }
  async loadRevision(id: string): Promise<MessageHistorySnapshot | null> {
    const revision = this.#revisions.get(id);
    if (!revision) return null;
    const revisions: MessageHistoryRevision[] = [];
    let current: MessageHistoryRevision | undefined = revision;
    while (current) {
      revisions.push(current);
      current = current.parent ? this.#revisions.get(current.parent) : undefined;
    }
    const needed = new Set(revisions.flatMap((r) => r.entryIds));
    return {
      entries: [...needed].map((entryId) => this.#entries.get(entryId)!).filter(Boolean),
      revisions,
      head: id,
    };
  }
  async save(s: RunState): Promise<void> { this.#runs.set(s.runId, s); }
  async load(runId: string): Promise<RunState | null> { return this.#runs.get(runId) ?? null; }
  async list(): Promise<RunState[]> { return [...this.#runs.values()]; }
  async delete(runId: string): Promise<void> { this.#runs.delete(runId); }
}

describe('fino:ai/channel', () => {
  it('agentDriver.handle() returns text reply via agent.generate when no store', async (t) => {
    const a = agent({ model: scriptModel([endTurn('hello from agent')]) });
    const driver = agentDriver({ agent: a });

    const reply = await driver.handle({ text: 'hi' });
    t.equal(reply.text, 'hello from agent', 'reply text from agent');
    t.equal(reply.status, undefined, 'no status when no store');
  });

  it('agentDriver.stream() yields chunks from agent.stream()', async (t) => {
    const a = agent({ model: scriptModel([endTurn('chunk-by-chunk')]) });
    const driver = agentDriver({ agent: a });

    const chunks: string[] = [];
    for await (const chunk of driver.stream({ text: 'go' })) {
      chunks.push(chunk);
    }
    t.ok(chunks.length > 0, 'received at least one chunk');
    t.equal(chunks.join(''), 'chunk-by-chunk', 'chunks compose to full text');
  });

  it('httpChannel round-trip via fetch', async (t) => {
    const a = agent({ model: scriptModel([endTurn('pong')]) });
    const driver = agentDriver({ agent: a });
    const channel = httpChannel(driver);
    const server = channel.listen({ port: 0 });
    await server.ready;

    try {
      const res = await fetch(`http://localhost:${server.port}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'ping' }),
      });
      t.equal(res.status, 200, 'status 200');
      const body = await res.json() as { text: string };
      t.equal(body.text, 'pong', 'reply text matches');
    } finally {
      await server.close();
    }
  });

  it('httpChannel custom path is respected', async (t) => {
    const a = agent({ model: scriptModel([endTurn('ok')]) });
    const driver = agentDriver({ agent: a });
    const channel = httpChannel(driver, { path: '/api/chat' });
    const server = channel.listen({ port: 0 });
    await server.ready;

    try {
      const res = await fetch(`http://localhost:${server.port}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      t.equal(res.status, 200, 'correct path returns 200');
    } finally {
      await server.close();
    }
  });

  it('httpChannel with store: suspend → resumeToken → resume completes', async (t) => {
    const store = new MemStore();
    let suspendCalled = false;

    const suspendOnce = tool({
      name: 'wait',
      description: 'Waits for human',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        if (!suspendCalled) {
          suspendCalled = true;
          throw new SuspendSignal('waiting for human');
        }
        return 'approved';
      },
    });

    const a = agent({
      model: scriptModel([
        toolCallTurn('s1', 'wait', '{}'),
        endTurn('done after approval'),
      ]),
      tools: [suspendOnce],
    });

    const driver = agentDriver({ agent: a, store });
    const channel = httpChannel(driver);
    const server = channel.listen({ port: 0 });
    await server.ready;

    try {
      const r1 = await fetch(`http://localhost:${server.port}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'please approve' }),
      });
      const b1 = await r1.json() as { text: string; status: string; resumeToken: string };
      t.equal(b1.status, 'suspended', 'first reply is suspended');
      t.ok(b1.resumeToken, 'resumeToken is present');

      const r2 = await fetch(`http://localhost:${server.port}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'approved', resumeToken: b1.resumeToken }),
      });
      const b2 = await r2.json() as { text: string; status: string };
      t.equal(b2.status, 'done', 'resumed run is done');
      t.equal(b2.text, 'done after approval', 'text from resumed run');
    } finally {
      await server.close();
    }
  });

  it('agentDriver.resume() reloads suspended sessions from the checkpoint store', async (t) => {
    const store = new MemStore();
    let suspendCalled = false;

    const suspendOnce = tool({
      name: 'wait',
      description: 'Waits for human',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        if (!suspendCalled) {
          suspendCalled = true;
          throw new SuspendSignal('waiting for human');
        }
        return 'approved';
      },
    });

    const firstAgent = agent({
      model: scriptModel([
        toolCallTurn('s1', 'wait', '{}'),
        endTurn('unused'),
      ]),
      tools: [suspendOnce],
    });

    const firstDriver = agentDriver({ agent: firstAgent, store, threadId: 'durable-channel' });
    const suspended = await firstDriver.handle({ text: 'please approve' });
    t.equal(suspended.status, 'suspended', 'first run suspended');
    t.ok(suspended.runId, 'runId is returned');
    t.ok(suspended.resumeToken, 'resumeToken is returned');

    const resumedAgent = agent({
      model: scriptModel([endTurn('resumed after restart')]),
      tools: [suspendOnce],
    });
    const freshDriver = agentDriver({ agent: resumedAgent, store, threadId: 'durable-channel' });
    const resumed = await freshDriver.resume({
      runId: suspended.runId!,
      resumeToken: suspended.resumeToken!,
      value: 'approved',
    });

    t.equal(resumed.status, 'done', 'fresh driver resumed persisted session');
    t.equal(resumed.text, 'resumed after restart', 'resumed run used new driver agent');
  });

  it('webhookChannel returns 401 when verify fails', async (t) => {
    const a = agent({ model: scriptModel([endTurn('ok')]) });
    const driver = agentDriver({ agent: a });
    const channel = webhookChannel(driver, {
      path: '/webhook',
      verify: (_req) => false,
    });
    const server = channel.listen({ port: 0 });
    await server.ready;

    try {
      const res = await fetch(`http://localhost:${server.port}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'event' }),
      });
      t.equal(res.status, 401, 'unauthorized when verify returns false');
    } finally {
      await server.close();
    }
  });

  it('webhookChannel returns 202 and processes fire-and-forget when verify passes', async (t) => {
    const handled: string[] = [];
    const a = agent({ model: scriptModel([endTurn('handled')]) });
    const driver = agentDriver({ agent: a });

    const originalHandle = driver.handle.bind(driver);
    driver.handle = async (msg) => {
      const r = await originalHandle(msg);
      handled.push(msg.text);
      return r;
    };

    const channel = webhookChannel(driver, {
      path: '/webhook',
      verify: (_req) => true,
    });
    const server = channel.listen({ port: 0 });
    await server.ready;

    try {
      const res = await fetch(`http://localhost:${server.port}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'event-data' }),
      });
      t.equal(res.status, 202, 'accepted immediately');

      await new Promise<void>((resolve) => {
        const check = () => {
          if (handled.length > 0) { resolve(); return; }
          setTimeout(check, 5);
        };
        check();
      });
      t.ok(handled.includes('event-data'), 'handler was called asynchronously');
    } finally {
      await server.close();
    }
  });

  it('websocketChannel streams chunks to client and sends EOT marker', async (t) => {
    const a = agent({ model: scriptModel([endTurn('streamed reply')]) });
    const driver = agentDriver({ agent: a });
    const channel = websocketChannel(driver, { path: '/ws' });
    const server = channel.listen({ port: 0 });
    await server.ready;

    try {
      const received: string[] = [];
      let done = false;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
        ws.addEventListener('open', () => ws.send('hello'));
        ws.addEventListener('message', (event) => {
          const data = (event as MessageEvent<string>).data;
          if (data === '\x00') {
            done = true;
            ws.close();
          } else if (!data.startsWith('\x01')) {
            received.push(data);
          }
        });
        ws.addEventListener('close', () => resolve());
        ws.addEventListener('error', (e) => reject(new Error(`WebSocket error: ${(e as ErrorEvent).message ?? 'unknown'}`)));
      });

      t.ok(done, 'EOT marker received');
      t.equal(received.join(''), 'streamed reply', 'chunks compose to full reply');
    } finally {
      await server.close();
    }
  });
});
