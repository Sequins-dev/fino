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
    const native = await readTextFile(`${root}/src/realm/native.rs`);
    t.ok(!realm.includes('RealmKind'));
    t.ok(!realm.includes('_stepChildren'));
    t.ok(!bootstrap.includes('child-steppers'));
    t.ok(!native.includes('createThreadContext'));
    t.ok(!native.includes('stepContext'));
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
});
