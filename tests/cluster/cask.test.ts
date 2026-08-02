/**
 * The cask deployment artifact: identity by content hash, refusal of
 * corrupted bytes, idempotent crash-safe unpacking, and cache GC.
 */
import { describe, it } from 'fino:test/test';
import { packCask, inspectCask, unpackCask, gcCasks } from 'internal:cluster/cask';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const scratch = `/tmp/fino-cask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeApp(name: string): Promise<string> {
  const dir = `${scratch}/${name}`;
  await fs.mkdir(scratch).catch(() => {});
  await fs.mkdir(dir);
  await fs.mkdir(`${dir}/lib`);
  const enc = new TextEncoder();
  await fs.writeFile(`${dir}/main.ts`, enc.encode(`import './lib/util.ts';\nconsole.log('hi');\n`));
  await fs.writeFile(`${dir}/lib/util.ts`, enc.encode(`export const x = 1;\n`));
  return dir;
}

describe('cask format', () => {
  it('packs, inspects, and unpacks by content hash', async (t) => {
    const app = await makeApp('app-a');
    const caskPath = `${scratch}/app-a.cask`;
    const packed = await packCask(app, caskPath, { name: 'app-a', version: '1.0.0', entry: 'main.ts' });
    t.equal(packed.hash.length, 64, 'identity is a sha-256');
    t.equal(packed.manifest.entry, 'main.ts', 'manifest records the entry');

    const inspected = await inspectCask(caskPath);
    t.equal(inspected.hash, packed.hash, 'inspection sees the same identity');
    t.equal(inspected.manifest.name, 'app-a', 'manifest travels in the archive');

    const cache = `${scratch}/cache-a`;
    const slot = await unpackCask(caskPath, cache, { expectedHash: packed.hash });
    t.equal(slot.dir, `${cache}/sha256-${packed.hash}`, 'the slot is content-addressed');
    const entrySrc = new TextDecoder().decode(await fs.readFile(slot.entryPath));
    t.ok(entrySrc.includes("console.log('hi')"), 'the entry module unpacked intact');
    const util = await fs.readFile(`${slot.dir}/lib/util.ts`);
    t.ok(util.length > 0, 'nested files unpacked');

    const again = await unpackCask(caskPath, cache);
    t.equal(again.dir, slot.dir, 're-unpacking the same hash reuses the slot');
  });

  it('refuses bytes that do not match the expected hash', async (t) => {
    const app = await makeApp('app-b');
    const caskPath = `${scratch}/app-b.cask`;
    await packCask(app, caskPath, { name: 'app-b', version: '1.0.0', entry: 'main.ts' });
    await t.rejects(
      () => unpackCask(caskPath, `${scratch}/cache-b`, { expectedHash: 'f'.repeat(64) }),
      /hash mismatch/,
      'a substituted artifact never reaches the cache',
    );
  });

  it('refuses to pack a cask whose entry does not exist', async (t) => {
    const app = await makeApp('app-c');
    await t.rejects(
      () => packCask(app, `${scratch}/app-c.cask`, { name: 'c', version: '1', entry: 'missing.ts' }),
      /does not exist/,
      'an unspawnable cask fails at pack time',
    );
    await t.rejects(
      () => packCask(app, `${scratch}/app-c.cask`, { name: 'c', version: '1', entry: '../evil.ts' }),
      /relative path/,
      'entry cannot escape the cask root',
    );
  });

  it('collects unreferenced casks and staging debris, keeping live ones', async (t) => {
    const app = await makeApp('app-d');
    const cache = `${scratch}/cache-d`;
    const caskPath = `${scratch}/app-d.cask`;
    const packed = await packCask(app, caskPath, { name: 'd', version: '1', entry: 'main.ts' });
    await unpackCask(caskPath, cache);
    await fs.mkdir(`${cache}/sha256-${'0'.repeat(64)}`);
    await fs.mkdir(`${cache}/.staging-dead-xyz`);

    const removed = await gcCasks(cache, new Set([packed.hash]));
    t.deepEqual(removed, ['0'.repeat(64)], 'the unreferenced cask was removed');
    const kept = await fs.stat(`${cache}/sha256-${packed.hash}`).then(() => true, () => false);
    t.ok(kept, 'the live cask survives GC');
    const debris = await fs.stat(`${cache}/.staging-dead-xyz`).then(() => true, () => false);
    t.ok(!debris, 'crashed-unpack staging debris is swept');
  });
});

describe('cask store GC', () => {
  it('keeps referenced and fresh artifacts, removes stale unreferenced ones', async (t) => {
    const { gcCaskStore } = await import('internal:cluster/cask');
    const store = `${scratch}/store-gc`;
    await fs.mkdir(store);
    const keepHash = '1'.repeat(64);
    const staleHash = '2'.repeat(64);
    const freshHash = '3'.repeat(64);
    for (const hash of [keepHash, staleHash, freshHash]) {
      await fs.writeFile(`${store}/${hash}.cask`, new Uint8Array([1]));
    }
    await fs.writeFile(`${store}/not-a-cask.txt`, new Uint8Array([2]));
    // Age two of them past the grace window.
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${store}/${keepHash}.cask`, old, old);
    await fs.utimes(`${store}/${staleHash}.cask`, old, old);

    const removed = await gcCaskStore(store, new Set([keepHash]), 30_000);
    t.deepEqual(removed, [staleHash], 'only the stale unreferenced artifact was removed');
    const kept = await fs.stat(`${store}/${keepHash}.cask`).then(() => true, () => false);
    t.ok(kept, 'referenced artifacts survive regardless of age');
    const fresh = await fs.stat(`${store}/${freshHash}.cask`).then(() => true, () => false);
    t.ok(fresh, 'unreferenced-but-fresh artifacts survive the grace window');
    const stranger = await fs.stat(`${store}/not-a-cask.txt`).then(() => true, () => false);
    t.ok(stranger, 'non-cask files are never touched');
  });
});
