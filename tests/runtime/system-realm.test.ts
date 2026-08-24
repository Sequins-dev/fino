/**
 * The per-node system realm: system-class scheduling, upward reports over the
 * realm port, and supervised restart.
 */
import { describe, it } from 'fino:test/test';
import { SystemRealmAgent } from 'internal:cluster/agent';
import { Realm } from 'fino:realm';
import { env } from 'fino:process';

describe('per-node system realm', () => {
  it('spawns, reports node observations, survives loss, and stops', async (t) => {
    env.FINO_SYSTEM_REALM_INTERVAL_MS = '50';
    const agent = new SystemRealmAgent();
    agent.start();
    try {
      const report = await agent.firstReport(15_000);
      t.ok(report.at > 0, 'report carries a timestamp');
      t.ok(report.load.cpu >= 0 && report.load.cpu <= 1, 'node load cpu is a ratio');
      t.ok(report.load.memory > 0, 'node load memory is populated');
      t.ok(report.queue.active >= 1, 'the sampling system realm counts itself as active');

      const first = agent._currentRealm();
      t.ok(first !== null, 'agent exposes the live system realm');
      first!.terminate();
      const deadline = Date.now() + 15_000;
      while (agent._currentRealm() === first || agent._currentRealm() === null) {
        if (Date.now() > deadline) throw new Error('system realm was not respawned');
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      t.ok(true, 'a terminated system realm is respawned by supervision');
      const previous = agent.latest()!.at;
      const reportDeadline = Date.now() + 15_000;
      while ((agent.latest()?.at ?? 0) <= previous) {
        if (Date.now() > reportDeadline) throw new Error('respawned system realm never reported');
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      t.ok(true, 'the respawned system realm resumes reporting');
    } finally {
      await agent.stop();
      delete env.FINO_SYSTEM_REALM_INTERVAL_MS;
    }
    t.equal(agent.latest(), null, 'stop clears the last report');
  });
});

describe('system realm balancer hosting', () => {
  it('accepts a peer view and answers unknown shed results without crashing', async (t) => {
    const realm = new Realm({ entry: 'internal:cluster/system-realm', _system: true });
    const reports: unknown[] = [];
    const offers: unknown[] = [];
    realm.port.onmessage = (event) => {
      const data = (event as MessageEvent).data as Record<string, unknown>;
      if (data.__system_report !== undefined) reports.push(data.__system_report);
      if (data.__shed_offer !== undefined) offers.push(data.__shed_offer);
    };
    realm.port.start();
    const done = realm.run().catch(() => {});
    for (let i = 0; i < 100 && reports.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    t.ok(reports.length > 0, 'the realm reports');

    // A peer view with an idle peer and an empty local queue: the balancer
    // must decide there is nothing to shed and stay quiet.
    realm.port.postMessage({ __peers: [{ nodeId: 'idle-peer', pendingSpecs: 0 }] });
    // A stray shed result for an offer that never existed must be ignored.
    realm.port.postMessage({ __shed_result: { id: 999, accepted: true } });
    const before = reports.length;
    for (let i = 0; i < 100 && reports.length < before + 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    t.ok(reports.length > before, 'reporting continues after peer and result messages');
    t.equal(offers.length, 0, 'a balanced (empty) queue sheds nothing');

    realm.port.postMessage({ __system_stop: true });
    await done;
    t.ok(true, 'the realm still settles cleanly');
  });
});
