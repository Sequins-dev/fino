/** Seed membership tests using an in-memory transport. */
import { afterEach, describe, it } from 'fino:test/test';
import { SeedServer } from 'internal:cluster/seed';
import type { ClusterMessage } from 'internal:cluster/protocol';

class TestSeedTransport {
  readonly nodeId = 'seed';
  handlers: Array<(from: string, message: ClusterMessage) => void> = [];
  sent: Array<{ to: string; message: ClusterMessage }> = [];
  listened = false;
  closed = false;

  inject(from: string, message: ClusterMessage): void {
    for (const handler of this.handlers) handler(from, message);
  }
  send(to: string, message: ClusterMessage): void {
    this.sent.push({ to, message });
  }
  broadcast(_message: ClusterMessage): void {}
  broadcastExcept(except: string, message: ClusterMessage): void {
    this.sent.push({ to: `except:${except}`, message });
  }
  on(handler: (from: string, message: ClusterMessage) => void): void {
    this.handlers.push(handler);
  }
  async listen(): Promise<void> {
    this.listened = true;
  }
  close(): void {
    this.closed = true;
  }
}

let active: SeedServer | null = null;

describe('cluster seed membership', () => {
  afterEach(() => {
    active?.stop();
    active = null;
  });
  it('welcomes nodes and announces membership', async (t) => {
    const transport = new TestSeedTransport();
    active = new SeedServer(transport as any);
    await active.start();
    transport.inject('node-1', {
      t: 'HELLO',
      nodeId: 'node-1',
      load: { cpu: .2, memory: 10 }
    });
    transport.inject('node-2', {
      t: 'HELLO',
      nodeId: 'node-2',
      load: { cpu: .1, memory: 20 }
    });
    t.ok(transport.listened);
    t.equal(transport.sent.filter(({ message }) => message.t === 'WELCOME').length, 2);
    t.ok(transport.sent.some(({ message }) => message.t === 'PEER_UP'));
  });

  it('announces disconnected peers once', async (t) => {
    const transport = new TestSeedTransport();
    active = new SeedServer(transport as any);
    await active.start();
    transport.inject('node-1', {
      t: 'HELLO',
      nodeId: 'node-1',
      load: { cpu: 0, memory: 0 }
    });
    transport.sent = [];
    transport.inject('node-1', { t: 'PEER_DOWN', nodeId: 'node-1' });
    transport.inject('node-1', { t: 'PEER_DOWN', nodeId: 'node-1' });
    t.equal(transport.sent.filter(({ message }) => message.t === 'PEER_DOWN').length, 1);
  });
});
