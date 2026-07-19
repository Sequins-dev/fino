/** Tests for fino:realm — one-to-many RealmDeployment execution. */
import { describe, it } from 'fino:test/test';
import { Realm, RealmDeployment } from 'fino:realm';
import type scalingFn from './fixtures/scaling-fn.ts';
import type deploymentPeer from './fixtures/deployment-peer.ts';

const entry = new URL('./fixtures/scaling-fn.ts', import.meta.url).pathname;

describe('RealmDeployment', () => {
  it('keeps Realm one-to-one while a deployment owns replicas', async (t) => {
    using realm = new Realm<typeof scalingFn>({ entry });
    using deployment = new RealmDeployment<typeof scalingFn>({
      entry,
      scaling: { min: 2, max: 2 }
    });

    const realmIds = await Promise.all([realm.call(20), realm.call(0)]);
    const deploymentIds = await Promise.all([deployment.call(20), deployment.call(0)]);

    t.equal(realmIds[0], realmIds[1], 'one Realm keeps one isolate');
    t.notEqual(deploymentIds[0], deploymentIds[1], 'the deployment routes over independent replicas');
  });

  it('rejects process-isolated deployments', (t) => {
    t.throws(
      () => new RealmDeployment({ entry, process: true } as any),
      /process isolation is only supported by Realm/i
    );
  });

  it('is referenced by default and supports ref controls', (t) => {
    using deployment = new RealmDeployment<typeof scalingFn>({ entry });
    t.equal(deployment.hasRef(), true);
    t.equal(deployment.unref(), deployment);
    t.equal(deployment.hasRef(), false);
    t.equal(deployment.ref(), deployment);
    t.equal(deployment.hasRef(), true);
  });

  it('broadcasts an independent message to every ready replica', async (t) => {
    using deployment = new RealmDeployment<typeof deploymentPeer>({
      entry: new URL('./fixtures/deployment-peer.ts', import.meta.url).pathname,
      scaling: { min: 2, max: 2 }
    });
    await deployment.ready;
    await deployment.broadcast({ event: 'refresh' });
    using first = await deployment.connect();
    using second = await deployment.connect();
    const snapshots = await Promise.all([first.call(), second.call()]);
    t.notEqual(snapshots[0].id, snapshots[1].id);
    t.deepEqual(snapshots[0].messages, [{ event: 'refresh' }]);
    t.deepEqual(snapshots[1].messages, [{ event: 'refresh' }]);
  });

  it('keeps a connection affine to one replica', async (t) => {
    using deployment = new RealmDeployment<typeof deploymentPeer>({
      entry: new URL('./fixtures/deployment-peer.ts', import.meta.url).pathname
    });
    using session = await deployment.connect();
    const first = await session.call();
    const second = await session.call();
    t.equal(second.id, first.id);
    session.close();
    await t.rejects(() => session.call(), /closed/i);
  });
});

describe('Realm ownership', () => {
  it('is referenced by default', (t) => {
    using realm = new Realm<typeof scalingFn>({ entry });
    t.equal(realm.hasRef(), true);
  });

  it('rejects deployment scaling options', (t) => {
    t.throws(
      () => new Realm({ entry, scaling: { min: 2 } } as any),
      /scaling belongs to RealmDeployment/i
    );
  });
});
