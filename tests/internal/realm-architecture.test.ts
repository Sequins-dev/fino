/**
* Regression checks for the reactor-only Realm architecture.
*/
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { cwd } from 'fino:process';

const fs = new DiskFileSystem();
const decoder = new TextDecoder();
async function readTextFile(path: string): Promise<string> {
  return decoder.decode(await fs.readFile(path));
}

describe('reactor-only Realm architecture', () => {
  it('does not retain legacy realm kinds or child stepping', async (t) => {
    const root = cwd();
    const realm = await readTextFile(`${root}/js/realm/index.ts`);
    const bootstrap = await readTextFile(`${root}/js/internal/bootstrap.ts`);
    const bridge = await readTextFile(`${root}/src/realm/bridge.rs`);
    const native = await readTextFile(`${root}/src/realm/native.rs`);
    t.ok(!realm.includes('RealmKind'));
    t.ok(!realm.includes('_stepChildren'));
    t.ok(!bootstrap.includes('child-steppers'));
    t.ok(!bootstrap.includes('getPort,'), 'bootstrap has no same-isolate port fallback');
    t.ok(!bridge.includes('"getPort"'), 'the realm bridge only exposes transit-backed ports');
    t.ok(!native.includes('createThreadContext'));
    t.ok(!native.includes('stepContext'));
    t.ok(!native.includes('process_port_send'), 'process messaging reuses the transit transport');
    t.ok(!native.includes('process_port_recv'), 'process receive draining reuses ThreadPort');
    t.ok(realm.includes('class ProcessPort extends ThreadPort'), 'process status layers over the shared transit port');
    t.ok(!realm.includes('localMobility'), 'placement mobility is derived from native resources');
  });

  it('does not retain the legacy remote-realm protocol', async (t) => {
    const root = cwd();
    const client = await readTextFile(`${root}/js/internal/cluster/client.ts`);
    const protocol = await readTextFile(`${root}/js/internal/cluster/protocol.ts`);
    const cluster = await readTextFile(`${root}/js/cluster.ts`);
    t.ok(!client.includes('createThreadContext'));
    t.ok(!client.includes('ClusterPort'));
    t.ok(!protocol.includes("t: 'SPAWN'"));
    t.ok(!protocol.includes("t: 'PORT_MSG'"));
    t.ok(!cluster.includes('spawnRealm'));
    t.ok(!cluster.includes('remote: true'));
  });

  it('keeps scheduling inside reactors and placement inside orchestration', async (t) => {
    const root = cwd();
    const orchestrator = await readTextFile(`${root}/js/internal/orchestrator/index.ts`);
    const nodeOrchestrator = await readTextFile(`${root}/js/internal/orchestrator/node-orchestrator.ts`);
    const engine = await readTextFile(`${root}/src/reactor/engine.rs`);
    const bootstrap = await readTextFile(`${root}/js/internal/bootstrap.ts`);
    const realm = await readTextFile(`${root}/js/realm/index.ts`);
    t.ok(!orchestrator.includes('SchedulerNode'), 'node orchestration is not named as a scheduler');
    t.ok(nodeOrchestrator.includes('export class NodeOrchestrator'), 'node placement is explicitly orchestration');
    t.ok(!orchestrator.includes('deployNode'), 'the obsolete tenant deployment entrypoint is gone');
    t.ok(!bootstrap.includes('__tenant_dispatch'), 'realms have no tenant activation mode');
    t.ok(realm.includes('class RealmDeployment'), 'replication is represented by a distinct deployment');
    t.ok(!nodeOrchestrator.includes("type: 'started'"), 'startup telemetry is not orchestration wire surface');
    t.ok(!nodeOrchestrator.includes('debtBand'), 'load wire shape contains only consumed metrics');
    t.ok(!engine.includes('Report::Detached'), 'source drain remains internal to migration');
  });
});
