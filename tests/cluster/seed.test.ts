/**
 * Tests for internal:cluster/seed — routing logic using an in-memory transport.
 *
 * SeedServer is tested against a TestSeedTransport that captures all sent
 * messages so we can assert routing decisions without network I/O.
 */
import { describe, it, afterEach } from 'fino:test/test';
import { SeedServer } from 'internal:cluster/seed';
import { WorkloadLedger } from 'internal:cluster/ledger';
import { RealmRegistry } from 'internal:cluster/registry';
import type { ClusterMessage } from 'internal:cluster/protocol';
// ---------------------------------------------------------------------------
// TestSeedTransport — in-memory mock
// ---------------------------------------------------------------------------
type SentMessage = {
  to: string | '__broadcast__';
  msg: ClusterMessage;
};
class TestSeedTransport {
  readonly nodeId: string;
  #handlers: ((from: string, msg: ClusterMessage) => void)[] = [];
  sent: SentMessage[] = [];
  listenCalled = false;
  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }
  /** Inject a message as if it arrived from `from`. */
  inject(from: string, msg: ClusterMessage): void {
    for (const h of this.#handlers) h(from, msg);
  }
  /** Filter sent messages by type. */
  sentOfType<T extends ClusterMessage['t']>(
    t: T,
  ): Extract<
    ClusterMessage,
    {
      t: T;
    }
  >[] {
    return this.sent
      .filter((s) => s.msg.t === t)
      .map(
        (s) =>
          s.msg as Extract<
            ClusterMessage,
            {
              t: T;
            }
          >,
      );
  }
  // ClusterTransport + SeedTransport interface
  send(to: string, msg: ClusterMessage): void {
    this.sent.push({
      to,
      msg,
    });
  }
  broadcast(msg: ClusterMessage): void {
    this.sent.push({
      to: '__broadcast__',
      msg,
    });
  }
  broadcastExcept(except: string, msg: ClusterMessage): void {
    this.sent.push({
      to: `except:${except}`,
      msg,
    });
  }
  on(handler: (from: string, msg: ClusterMessage) => void): void {
    this.#handlers.push(handler);
  }
  async listen(): Promise<void> {
    this.listenCalled = true;
  }
  close(): void {
    this.#handlers = [];
  }
}
let _activeSeed: SeedServer | null = null;
async function makeSeed(
  nodeId = 'seed-node',
  options: { joinToken?: string; clusterId?: string; ledger?: WorkloadLedger; leaseMs?: number } = {},
): Promise<{
  seed: SeedServer;
  transport: TestSeedTransport;
}> {
  const transport = new TestSeedTransport(nodeId);
  const seed = new SeedServer(transport as any, options);
  await seed.start();
  _activeSeed = seed;
  return {
    seed,
    transport,
  };
}
function stopActiveSeed(): void {
  _activeSeed?.stop();
  _activeSeed = null;
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SeedServer — HELLO / WELCOME', () => {
  afterEach(stopActiveSeed);
  it('start() calls listen() on the transport', async (t) => {
    const { transport } = await makeSeed();
    t.ok(transport.listenCalled, 'listen() was called on start');
  });
  it('HELLO from a new node triggers WELCOME sent back to that node', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: .1,
        memory: 100,
      },
    });
    const welcomes = transport.sentOfType('WELCOME');
    t.equal(welcomes.length, 1, 'one WELCOME sent');
    const w = welcomes[0]!;
    t.equal(
      transport.sent.find((s) => s.msg.t === 'WELCOME')!.to,
      'worker-1',
      'WELCOME sent to worker-1',
    );
    t.ok(Array.isArray(w.peers), 'peers is array');
  });
  it('second node gets PEER_UP for existing nodes in broadcast', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.sent = [];
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    const peerUps = transport.sentOfType('PEER_UP');
    t.ok(peerUps.length > 0, 'PEER_UP broadcast sent for new node');
  });
});
describe('SeedServer — SPAWN routing', () => {
  afterEach(stopActiveSeed);
  it('SPAWN with no eligible peer → SPAWN_ACK { ok: false }', async (t) => {
    const { transport } = await makeSeed();
    // Only one node — no other peers
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.sent = [];
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'req-1',
      parentPortId: 'worker-1/p-0',
      config: {
        entry: './fn.ts',
        root: '/app',
        rules: [],
      },
    });
    const acks = transport.sentOfType('SPAWN_ACK');
    t.equal(acks.length, 1, 'one SPAWN_ACK sent');
    t.ok(!acks[0]!.ok, 'SPAWN_ACK ok=false when no eligible worker');
    t.ok(typeof acks[0]!.error === 'string', 'SPAWN_ACK error message set');
  });
  it('SPAWN with two peers → forwarded to peer, SPAWN_ACK routed back to requester', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: .8,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: .1,
        memory: 0,
      },
    });
    transport.sent = [];
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'req-2',
      parentPortId: 'worker-1/p-0',
      config: {
        entry: './fn.ts',
        root: '/app',
        rules: [],
      },
    });
    // Seed should forward SPAWN to the lower-load worker (worker-2)
    const spawns = transport.sent.filter((s) => s.msg.t === 'SPAWN');
    t.equal(spawns.length, 1, 'SPAWN forwarded once');
    t.equal(spawns[0]!.to, 'worker-2', 'SPAWN forwarded to worker-2 (lower load)');
    // Simulate SPAWN_ACK from worker-2
    transport.sent = [];
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'req-2',
      childPortId: 'worker-2/0',
      ok: true,
    });
    const acks = transport.sent.filter((s) => s.msg.t === 'SPAWN_ACK');
    t.equal(acks.length, 1, 'SPAWN_ACK forwarded');
    t.equal(acks[0]!.to, 'worker-1', 'SPAWN_ACK routed back to original requester');
    t.ok((acks[0]!.msg as any).ok, 'ok=true preserved');
  });
  it('reroutes later SPAWN requests after a lower-load peer goes down', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: .9,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: .1,
        memory: 0,
      },
    });
    transport.inject('worker-3', {
      t: 'HELLO',
      nodeId: 'worker-3',
      load: {
        cpu: .2,
        memory: 0,
      },
    });
    transport.sent = [];
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'req-failover-1',
      parentPortId: 'worker-1/p-failover-1',
      config: {
        entry: './fn.ts',
        root: '/app',
        rules: [],
      },
    });
    t.equal(
      transport.sent.find((s) => s.msg.t === 'SPAWN')?.to,
      'worker-2',
      'first spawn chooses lowest-load worker',
    );
    transport.sent = [];
    transport.inject('worker-2', {
      t: 'PEER_DOWN',
      nodeId: 'worker-2',
    });
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'req-failover-2',
      parentPortId: 'worker-1/p-failover-2',
      config: {
        entry: './fn.ts',
        root: '/app',
        rules: [],
      },
    });
    t.equal(
      transport.sent.find((s) => s.msg.t === 'SPAWN')?.to,
      'worker-3',
      'next spawn skips down peer',
    );
  });
  it('rejects a pending SPAWN if the selected target goes down before SPAWN_ACK', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: .9,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: .1,
        memory: 0,
      },
    });
    transport.sent = [];
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'req-target-down',
      parentPortId: 'worker-1/p-target-down',
      config: {
        entry: './fn.ts',
        root: '/app',
        rules: [],
      },
    });
    transport.sent = [];
    transport.inject('worker-2', {
      t: 'PEER_DOWN',
      nodeId: 'worker-2',
    });
    const acks = transport.sent.filter((s) => s.to === 'worker-1' && s.msg.t === 'SPAWN_ACK');
    t.equal(acks.length, 1, 'requester gets one failure ack when target disappears');
    const ack = acks[0]!.msg as Extract<
      ClusterMessage,
      {
        t: 'SPAWN_ACK';
      }
    >;
    t.equal(ack.spawnReqId, 'req-target-down', 'failure ack uses pending spawn id');
    t.equal(ack.ok, false, 'pending spawn is rejected');
    t.ok(ack.error?.includes('worker-2'), 'failure mentions the down target');
  });
});
describe('SeedServer — PORT_MSG routing', () => {
  afterEach(stopActiveSeed);
  it('PORT_MSG is forwarded to the node hosting toPort', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: .5,
        memory: 0,
      },
    });
    // Register ports via a spawn cycle
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'req-3',
      parentPortId: 'worker-1/p-1',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'req-3',
      childPortId: 'worker-2/1',
      ok: true,
    });
    transport.sent = [];
    // worker-2 sends PORT_MSG to worker-1's parent port
    transport.inject('worker-2', {
      t: 'PORT_MSG',
      fromPort: 'worker-2/1',
      toPort: 'worker-1/p-1',
      payload: [new TextEncoder().encode('hello')],
      seq: 1,
    });
    const portMsgs = transport.sent.filter((s) => s.msg.t === 'PORT_MSG');
    t.equal(portMsgs.length, 1, 'PORT_MSG forwarded');
    t.equal(portMsgs[0]!.to, 'worker-1', 'PORT_MSG routed to worker-1');
  });
  it('PORT_MSG to unknown port is silently dropped', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.sent = [];
    transport.inject('worker-1', {
      t: 'PORT_MSG',
      fromPort: 'worker-1/0',
      toPort: 'worker-99/999',
      payload: [new TextEncoder().encode('hello')],
      seq: 1,
    });
    t.equal(transport.sent.length, 0, 'no messages forwarded for unknown toPort');
  });
});
describe('SeedServer — REALM_EXIT graceful cascade', () => {
  afterEach(stopActiveSeed);
  it('holds REALM_EXIT until its final PORT_MSG has been routed', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0, memory: 0 },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: { cpu: 0, memory: 0 },
    });
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'r-ordered-exit',
      parentPortId: 'worker-1/p-ordered',
      config: { entry: './fn.ts', root: '', rules: [] },
    });
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'r-ordered-exit',
      childPortId: 'worker-2/ordered',
      ok: true,
    });
    transport.sent = [];
    transport.inject('worker-2', {
      t: 'REALM_EXIT',
      realmId: 'worker-2/ordered',
      lastPortSeq: 1,
    } as ClusterMessage);
    t.equal(transport.sent.length, 0, 'exit is held while its final message is missing');
    transport.inject('worker-2', {
      t: 'PORT_MSG',
      fromPort: 'worker-2/ordered',
      toPort: 'worker-1/p-ordered',
      payload: [new TextEncoder().encode('hello')],
      seq: 1,
    } as ClusterMessage);
    t.deepEqual(
      transport.sent.map(({ msg }) => msg.t),
      ['PORT_MSG', 'REALM_EXIT'],
      'seed routes the final message before forwarding exit',
    );
  });
  it('REALM_EXIT sends TERMINATE to nodes hosting direct children', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    // Spawn child from worker-1 (parent) onto worker-2 (child)
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'r1',
      parentPortId: 'worker-1/p-10',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'r1',
      childPortId: 'worker-2/10',
      ok: true,
    });
    transport.sent = [];
    // Child on worker-2 exits gracefully
    transport.inject('worker-2', {
      t: 'REALM_EXIT',
      realmId: 'worker-2/10',
      lastPortSeq: 0,
    });
    // The parent port on worker-1 is the PARENT, not the child — the child was
    // on worker-2 and exited itself, so no TERMINATE needed for worker-2/10.
    const terminates = transport.sentOfType('TERMINATE');
    t.equal(terminates.length, 0, 'no TERMINATE sent — exiting realm had no descendants');
  });
  it('REALM_EXIT is forwarded to the parent host', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'r-parent-exit',
      parentPortId: 'worker-1/p-11',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'r-parent-exit',
      childPortId: 'worker-2/11',
      ok: true,
    });
    transport.sent = [];
    transport.inject('worker-2', {
      t: 'REALM_EXIT',
      realmId: 'worker-2/11',
      lastPortSeq: 0,
    });
    const exits = transport.sent.filter((s) => s.to === 'worker-1' && s.msg.t === 'REALM_EXIT');
    t.equal(exits.length, 1, 'REALM_EXIT forwarded to parent host');
    t.equal(
      (
        exits[0]!.msg as {
          realmId: string;
        }
      ).realmId,
      'worker-2/11',
      'child realmId preserved',
    );
  });
  it('REALM_EXIT sends TERMINATE to nodes hosting grandchildren', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-3', {
      t: 'HELLO',
      nodeId: 'worker-3',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    // worker-1 spawns child onto worker-2
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'r2',
      parentPortId: 'worker-1/p-20',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'r2',
      childPortId: 'worker-2/20',
      ok: true,
    });
    // worker-2's realm spawns grandchild onto worker-3
    transport.inject('worker-2', {
      t: 'SPAWN',
      spawnReqId: 'r3',
      parentPortId: 'worker-2/20',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-3', {
      t: 'SPAWN_ACK',
      spawnReqId: 'r3',
      childPortId: 'worker-3/20',
      ok: true,
    });
    transport.sent = [];
    // Child on worker-2 exits gracefully — grandchild on worker-3 must be terminated
    transport.inject('worker-2', {
      t: 'REALM_EXIT',
      realmId: 'worker-2/20',
      lastPortSeq: 0,
    });
    const terminates = transport.sentOfType('TERMINATE');
    t.ok(terminates.length >= 1, 'at least one TERMINATE sent for grandchild');
    const toWorker3 = transport.sent.filter((s) => s.to === 'worker-3' && s.msg.t === 'TERMINATE');
    t.ok(toWorker3.length >= 1, 'TERMINATE sent to worker-3 (grandchild host)');
    const terminateIds = terminates.map((m) => m.realmId);
    t.ok(terminateIds.includes('worker-3/20'), 'grandchild portId in TERMINATE');
  });
  it('exiting realm itself does NOT receive a redundant TERMINATE', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'r4',
      parentPortId: 'worker-1/p-30',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'r4',
      childPortId: 'worker-2/30',
      ok: true,
    });
    transport.sent = [];
    // worker-2's realm exits
    transport.inject('worker-2', {
      t: 'REALM_EXIT',
      realmId: 'worker-2/30',
      lastPortSeq: 0,
    });
    // No TERMINATE should go back to worker-2 for the realm that just exited
    const toWorker2 = transport.sent.filter(
      (s) =>
        s.to === 'worker-2' &&
        s.msg.t === 'TERMINATE' &&
        (
          s.msg as {
            realmId?: string;
          }
        ).realmId === 'worker-2/30',
    );
    t.equal(toWorker2.length, 0, 'exiting realm does not receive TERMINATE for itself');
  });
  it('multi-level exit: all descendants across 3 nodes get TERMINATE', async (t) => {
    const { transport } = await makeSeed();
    for (const w of ['worker-1', 'worker-2', 'worker-3', 'worker-4']) {
      transport.inject(w, {
        t: 'HELLO',
        nodeId: w,
        load: {
          cpu: 0,
          memory: 0,
        },
      });
    }
    // worker-1 spawns onto worker-2 (child)
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'rA',
      parentPortId: 'worker-1/p-40',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'rA',
      childPortId: 'worker-2/40',
      ok: true,
    });
    // worker-2 spawns onto worker-3 (grandchild)
    transport.inject('worker-2', {
      t: 'SPAWN',
      spawnReqId: 'rB',
      parentPortId: 'worker-2/40',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-3', {
      t: 'SPAWN_ACK',
      spawnReqId: 'rB',
      childPortId: 'worker-3/40',
      ok: true,
    });
    // worker-3 spawns onto worker-4 (great-grandchild)
    transport.inject('worker-3', {
      t: 'SPAWN',
      spawnReqId: 'rC',
      parentPortId: 'worker-3/40',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-4', {
      t: 'SPAWN_ACK',
      spawnReqId: 'rC',
      childPortId: 'worker-4/40',
      ok: true,
    });
    transport.sent = [];
    // worker-2 exits gracefully — grandchild and great-grandchild must be terminated
    transport.inject('worker-2', {
      t: 'REALM_EXIT',
      realmId: 'worker-2/40',
      lastPortSeq: 0,
    });
    const terminates = transport.sentOfType('TERMINATE');
    const terminateIds = new Set(terminates.map((m) => m.realmId));
    t.ok(terminateIds.has('worker-3/40'), 'grandchild TERMINATE sent');
    t.ok(terminateIds.has('worker-4/40'), 'great-grandchild TERMINATE sent');
    t.ok(!terminateIds.has('worker-2/40'), 'exiting realm not in TERMINATE list');
  });
});
describe('SeedServer — nodeDown cascade', () => {
  afterEach(stopActiveSeed);
  it('PEER_DOWN sends TERMINATE for orphaned child ports to surviving parents', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    // Spawn child from worker-1 onto worker-2
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'req-4',
      parentPortId: 'worker-1/p-2',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'req-4',
      childPortId: 'worker-2/2',
      ok: true,
    });
    transport.sent = [];
    // worker-2 goes down — seed should TERMINATE the child on worker-1's parent port
    transport.inject('worker-2', {
      t: 'PEER_DOWN',
      nodeId: 'worker-2',
    });
    const terminates = transport.sentOfType('TERMINATE');
    t.ok(terminates.length > 0, 'TERMINATE sent after nodeDown');
    const sentToWorker1 = transport.sent.filter(
      (s) => s.to === 'worker-1' && s.msg.t === 'TERMINATE',
    );
    t.ok(sentToWorker1.length > 0, 'TERMINATE sent to surviving worker-1');
  });
  it('dead node does NOT receive TERMINATE for its own ports', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: {
        cpu: 0,
        memory: 0,
      },
    });
    transport.inject('worker-1', {
      t: 'SPAWN',
      spawnReqId: 'req-5',
      parentPortId: 'worker-1/p-3',
      config: {
        entry: './fn.ts',
        root: '',
        rules: [],
      },
    });
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'req-5',
      childPortId: 'worker-2/3',
      ok: true,
    });
    transport.sent = [];
    // worker-2 (host of child) goes down
    transport.inject('worker-2', {
      t: 'PEER_DOWN',
      nodeId: 'worker-2',
    });
    // TERMINATE should NOT be sent to worker-2 (it's dead)
    const toWorker2 = transport.sent.filter((s) => s.to === 'worker-2' && s.msg.t === 'TERMINATE');
    t.equal(toWorker2.length, 0, 'dead node does not receive TERMINATE');
  });
  it('heartbeat timeout broadcasts PEER_DOWN and terminates dependent child ports', async (t) => {
    const { seed, transport } = await makeSeed();
    const realNow = Date.now;
    let now = 1e3;
    Date.now = () => now;
    try {
      transport.inject('worker-1', {
        t: 'HELLO',
        nodeId: 'worker-1',
        load: {
          cpu: 0,
          memory: 0,
        },
      });
      transport.inject('worker-2', {
        t: 'HELLO',
        nodeId: 'worker-2',
        load: {
          cpu: 0,
          memory: 0,
        },
      });
      transport.inject('worker-1', {
        t: 'SPAWN',
        spawnReqId: 'req-heartbeat',
        parentPortId: 'worker-1/p-heartbeat',
        config: {
          entry: './fn.ts',
          root: '',
          rules: [],
        },
      });
      transport.inject('worker-2', {
        t: 'SPAWN_ACK',
        spawnReqId: 'req-heartbeat',
        childPortId: 'worker-2/heartbeat',
        ok: true,
      });
      transport.sent = [];
      now += 4e3;
      transport.inject('worker-1', {
        t: 'HEARTBEAT',
        ts: now,
      });
      now += 4e3;
      seed._checkHeartbeatsForTest();
    } finally {
      Date.now = realNow;
    }
    const peerDowns = transport.sentOfType('PEER_DOWN');
    t.ok(
      peerDowns.some((msg) => msg.nodeId === 'worker-2'),
      'timeout announces worker-2 down',
    );
    const terminates = transport.sent.filter((s) => s.to === 'worker-1' && s.msg.t === 'TERMINATE');
    t.equal(terminates.length, 1, 'timeout terminates parent-side child port');
    t.equal(
      (
        terminates[0]!.msg as Extract<
          ClusterMessage,
          {
            t: 'TERMINATE';
          }
        >
      ).realmId,
      'worker-2/heartbeat',
    );
  });
  it('stale worker heartbeat timestamp does not evict a peer just received by the seed', async (t) => {
    const { seed, transport } = await makeSeed();
    const realNow = Date.now;
    let now = 1e3;
    Date.now = () => now;
    try {
      transport.inject('worker-1', {
        t: 'HELLO',
        nodeId: 'worker-1',
        load: {
          cpu: 0,
          memory: 0,
        },
      });
      now = 9e3;
      transport.sent = [];
      transport.inject('worker-1', {
        t: 'HEARTBEAT',
        ts: 1e3,
      });
      seed._checkHeartbeatsForTest();
    } finally {
      Date.now = realNow;
    }
    const peerDowns = transport.sentOfType('PEER_DOWN');
    t.equal(peerDowns.length, 0, 'stale worker timestamp is ignored for liveness');
  });
  it('future worker heartbeat timestamp does not keep an overdue peer alive', async (t) => {
    const { seed, transport } = await makeSeed();
    const realNow = Date.now;
    let now = 1e3;
    Date.now = () => now;
    try {
      transport.inject('worker-1', {
        t: 'HELLO',
        nodeId: 'worker-1',
        load: {
          cpu: 0,
          memory: 0,
        },
      });
      transport.inject('worker-1', {
        t: 'HEARTBEAT',
        ts: 1e6,
      });
      transport.sent = [];
      now = 9e3;
      seed._checkHeartbeatsForTest();
    } finally {
      Date.now = realNow;
    }
    const peerDowns = transport.sentOfType('PEER_DOWN');
    t.ok(
      peerDowns.some((msg) => msg.nodeId === 'worker-1'),
      'future worker timestamp does not suppress timeout',
    );
  });
});

describe('SeedServer — join authentication and observers', () => {
  afterEach(stopActiveSeed);
  it('denies HELLO with a missing or wrong token when a joinToken is set', async (t) => {
    const { transport } = await makeSeed('seed-node', { joinToken: 'secret', clusterId: 'c-test' });
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0, memory: 0 },
    });
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: { cpu: 0, memory: 0 },
      token: 'wrong',
    });
    const denials = transport.sentOfType('JOIN_DENIED');
    t.equal(denials.length, 2, 'both HELLOs were denied');
    t.equal(transport.sentOfType('WELCOME').length, 0, 'no WELCOME was sent');
    t.equal(transport.sentOfType('PEER_UP').length, 0, 'no membership broadcast happened');
  });
  it('admits HELLO with the right token and advertises the cluster id', async (t) => {
    const { transport } = await makeSeed('seed-node', { joinToken: 'secret', clusterId: 'c-test' });
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0, memory: 0 },
      token: 'secret',
    });
    const welcomes = transport.sentOfType('WELCOME');
    t.equal(welcomes.length, 1, 'the tokened HELLO was welcomed');
    t.equal(welcomes[0]!.clusterId, 'c-test', 'WELCOME carries the cluster identity');
  });
  it('observer HELLO receives WELCOME but never joins membership', async (t) => {
    const { transport } = await makeSeed('seed-node', { joinToken: 'secret', clusterId: 'c-test' });
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0.5, memory: 1 },
      token: 'secret',
    });
    transport.sent.length = 0;
    transport.inject('watcher', {
      t: 'HELLO',
      nodeId: 'watcher',
      load: { cpu: 0, memory: 0 },
      token: 'secret',
      observer: true,
    });
    const welcomes = transport.sentOfType('WELCOME');
    t.equal(welcomes.length, 1, 'observer got a WELCOME');
    t.equal(welcomes[0]!.peers.length, 1, 'observer sees the existing member');
    t.equal(welcomes[0]!.peers[0]!.nodeId, 'worker-1', 'membership snapshot is correct');
    t.equal(transport.sentOfType('PEER_UP').length, 0, 'observer was not broadcast as a member');
    transport.sent.length = 0;
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: { cpu: 0, memory: 0 },
      token: 'secret',
    });
    const next = transport.sentOfType('WELCOME');
    t.equal(next.length, 1, 'later member still welcomed');
    t.equal(
      next[0]!.peers.some((p) => p.nodeId === 'watcher'),
      false,
      'observer never appears in the peer list',
    );
  });
});

describe('SeedServer — incarnation fencing', () => {
  afterEach(stopActiveSeed);
  it('denies a HELLO with an older incarnation and admits a newer one', async (t) => {
    const { transport } = await makeSeed('seed-node', { clusterId: 'c-fence' });
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0, memory: 0 },
      incarnation: 5,
    });
    t.equal(transport.sentOfType('WELCOME').length, 1, 'first incarnation admitted');
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0, memory: 0 },
      incarnation: 4,
    });
    t.equal(transport.sentOfType('JOIN_DENIED').length, 1, 'older incarnation denied');
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0, memory: 0 },
      incarnation: 6,
    });
    t.equal(transport.sentOfType('WELCOME').length, 2, 'newer incarnation replaces the member');
  });
  it('ignores heartbeats from a replaced incarnation', async (t) => {
    const { transport } = await makeSeed('seed-node', { clusterId: 'c-fence' });
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0.1, memory: 1 },
      incarnation: 2,
    });
    transport.inject('worker-1', {
      t: 'HEARTBEAT',
      ts: Date.now(),
      load: { cpu: 0.9, memory: 9 },
      incarnation: 1,
    });
    transport.sent.length = 0;
    transport.inject('watcher', {
      t: 'HELLO',
      nodeId: 'watcher',
      load: { cpu: 0, memory: 0 },
      observer: true,
    });
    const snapshot = transport.sentOfType('WELCOME')[0]!;
    const member = snapshot.peers.find((p) => p.nodeId === 'worker-1')!;
    t.equal(member.load.cpu, 0.1, 'a stale-incarnation heartbeat cannot update the load view');
    t.equal(member.incarnation, 2, 'the membership record keeps the live incarnation');
  });
  it('advertises peer endpoints and certificate hashes for introductions', async (t) => {
    const hash = 'ab'.repeat(32);
    const { transport } = await makeSeed('seed-node', { clusterId: 'c-intro' });
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0, memory: 0 },
      endpoint: 'https://10.0.0.7:4433/__fino_cluster',
      certHash: hash,
    });
    transport.sent.length = 0;
    transport.inject('worker-2', {
      t: 'HELLO',
      nodeId: 'worker-2',
      load: { cpu: 0, memory: 0 },
    });
    const welcome = transport.sentOfType('WELCOME')[0]!;
    const introduced = welcome.peers.find((p) => p.nodeId === 'worker-1')!;
    t.equal(introduced.endpoint, 'https://10.0.0.7:4433/__fino_cluster', 'endpoint introduced');
    t.equal(introduced.certHash, hash, 'certificate hash introduced');
  });
});

describe('SeedServer — pressure placement and admission retry', () => {
  afterEach(stopActiveSeed);
  const load = (cpu: number, pendingSpecs?: number) => ({
    cpu,
    memory: 1,
    ...(pendingSpecs === undefined ? {} : { pendingSpecs }),
  });
  const spawn = (spawnReqId: string) => ({
    t: 'SPAWN' as const,
    spawnReqId,
    parentPortId: 'requester/p-1',
    config: { entry: '/app/main.ts', root: '/app', rules: [] },
  });

  it('places by queue pressure, not CPU alone', async (t) => {
    const { transport } = await makeSeed();
    // busy-cpu has higher CPU but an empty queue; deep-queue looks idle but
    // has specs waiting — pending work is the stronger signal.
    transport.inject('busy-cpu', { t: 'HELLO', nodeId: 'busy-cpu', load: load(0.6, 0) });
    transport.inject('deep-queue', { t: 'HELLO', nodeId: 'deep-queue', load: load(0.05, 5) });
    transport.sent.length = 0;
    transport.inject('requester', { t: 'HELLO', nodeId: 'requester', load: load(0, 0) });
    transport.sent.length = 0;
    transport.inject('requester', spawn('requester/s-1'));
    const routed = transport.sent.filter((s) => s.msg.t === 'SPAWN');
    t.equal(routed.length, 1, 'the spawn was routed');
    t.equal(routed[0]!.to, 'busy-cpu', 'the empty queue wins over lower CPU');
  });

  it('reroutes a retryable refusal to the next node and never reuses one', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', { t: 'HELLO', nodeId: 'worker-1', load: load(0.1, 0) });
    transport.inject('worker-2', { t: 'HELLO', nodeId: 'worker-2', load: load(0.2, 0) });
    transport.inject('requester', { t: 'HELLO', nodeId: 'requester', load: load(0.9, 9) });
    transport.sent.length = 0;
    transport.inject('requester', spawn('requester/s-2'));
    const first = transport.sent.filter((s) => s.msg.t === 'SPAWN')[0]!;
    t.equal(first.to, 'worker-1', 'lowest pressure chosen first');

    transport.sent.length = 0;
    transport.inject(first.to as string, {
      t: 'SPAWN_ACK',
      spawnReqId: 'requester/s-2',
      childPortId: '',
      ok: false,
      error: 'overloaded',
      retryable: true,
    });
    const second = transport.sent.filter((s) => s.msg.t === 'SPAWN');
    t.equal(second.length, 1, 'the refusal was retried elsewhere');
    t.equal(second[0]!.to, 'worker-2', 'the retry avoids the node that refused');
    t.equal(
      transport.sentOfType('SPAWN_ACK').length,
      0,
      'no failure was reported to the requester while a retry remained',
    );

    transport.sent.length = 0;
    transport.inject('worker-2', {
      t: 'SPAWN_ACK',
      spawnReqId: 'requester/s-2',
      childPortId: '',
      ok: false,
      error: 'overloaded',
      retryable: true,
    });
    const acks = transport.sentOfType('SPAWN_ACK');
    t.equal(acks.length, 1, 'with no nodes left the failure reaches the requester');
    t.equal(acks[0]!.ok, false, 'reported as a failure');
  });

  it('does not retry a non-retryable failure', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', { t: 'HELLO', nodeId: 'worker-1', load: load(0.1, 0) });
    transport.inject('worker-2', { t: 'HELLO', nodeId: 'worker-2', load: load(0.2, 0) });
    transport.inject('requester', { t: 'HELLO', nodeId: 'requester', load: load(0.9, 9) });
    transport.sent.length = 0;
    transport.inject('requester', spawn('requester/s-3'));
    transport.sent.length = 0;
    transport.inject('worker-1', {
      t: 'SPAWN_ACK',
      spawnReqId: 'requester/s-3',
      childPortId: '',
      ok: false,
      error: 'entry module threw',
    });
    t.equal(transport.sent.filter((s) => s.msg.t === 'SPAWN').length, 0, 'no retry attempted');
    t.equal(transport.sentOfType('SPAWN_ACK').length, 1, 'the error reached the requester');
  });

  it('reroutes when the chosen node dies mid-spawn', async (t) => {
    const { transport } = await makeSeed();
    transport.inject('worker-1', { t: 'HELLO', nodeId: 'worker-1', load: load(0.1, 0) });
    transport.inject('worker-2', { t: 'HELLO', nodeId: 'worker-2', load: load(0.2, 0) });
    transport.inject('requester', { t: 'HELLO', nodeId: 'requester', load: load(0.9, 9) });
    transport.sent.length = 0;
    transport.inject('requester', spawn('requester/s-4'));
    transport.sent.length = 0;
    transport.inject('worker-1', { t: 'PEER_DOWN', nodeId: 'worker-1' });
    const rerouted = transport.sent.filter((s) => s.msg.t === 'SPAWN');
    t.equal(rerouted.length, 1, 'the durable spawn was rerouted rather than failed');
    t.equal(rerouted[0]!.to, 'worker-2', 'rerouted to the surviving node');
  });
});

describe('SeedServer — ledger lease sweep', () => {
  afterEach(stopActiveSeed);

  it('reroutes an in-flight spawn whose target went silent', async (t) => {
    const ledger = await WorkloadLedger.open(
      `/tmp/fino-ledger-sweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    const { seed, transport } = await makeSeed('seed-node', { ledger, leaseMs: 40 });
    const load = (cpu: number) => ({ cpu, memory: 1, pendingSpecs: 0 });
    transport.inject('worker-1', { t: 'HELLO', nodeId: 'worker-1', load: load(0.1) });
    transport.inject('worker-2', { t: 'HELLO', nodeId: 'worker-2', load: load(0.2) });
    transport.inject('requester', { t: 'HELLO', nodeId: 'requester', load: load(0.9) });
    transport.sent.length = 0;
    transport.inject('requester', {
      t: 'SPAWN',
      spawnReqId: 'requester/s-sweep',
      parentPortId: 'requester/p-1',
      config: { entry: '/app/main.ts', root: '/app', rules: [] },
    });
    await seed._ledgerSettled();
    const first = transport.sent.filter((s) => s.msg.t === 'SPAWN')[0]!;
    t.equal(first.to, 'worker-1', 'routed to the lightest node first');
    const before = await ledger.get('requester/s-sweep');
    t.equal(before?.owner, 'worker-1', 'the lease belongs to the silent node');

    // worker-1 neither acks nor disconnects. Its lease simply lapses.
    await new Promise((resolve) => setTimeout(resolve, 60));
    transport.sent.length = 0;
    await seed._sweepLedgerForTest();

    const rerouted = transport.sent.filter((s) => s.msg.t === 'SPAWN');
    t.equal(rerouted.length, 1, 'the sweep rerouted the spawn');
    t.equal(rerouted[0]!.to, 'worker-2', 'to the remaining node');
    const after = await ledger.get('requester/s-sweep');
    t.equal(after?.owner, 'worker-2', 'the ledger lease moved with it');
    t.equal(after?.state, 'claimed', 'the record is claimed by the new target');
    await ledger.close();
  });

  it('leaves reclaimed records without a pending spawn for reconciliation', async (t) => {
    const ledger = await WorkloadLedger.open(
      `/tmp/fino-ledger-sweep2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    await ledger.commit('ghost/w-1', '{}');
    await ledger.claim('ghost/w-1', 'dead-node', 1, 10);
    const { seed, transport } = await makeSeed('seed-node', { ledger, leaseMs: 10 });
    transport.inject('worker-1', {
      t: 'HELLO',
      nodeId: 'worker-1',
      load: { cpu: 0.1, memory: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    transport.sent.length = 0;
    await seed._sweepLedgerForTest();
    t.equal(
      transport.sent.filter((s) => s.msg.t === 'SPAWN').length,
      0,
      'no blind re-execution of a workload nobody is waiting on',
    );
    const record = await ledger.get('ghost/w-1');
    t.equal(record?.state, 'unclaimed', 'but the lease was reclaimed');
    t.equal(record?.owner, null, 'and the dead owner cleared');
    await ledger.close();
  });
});
