/**
 * Client-side cask transfer: upload chunking, fetch reassembly, and the
 * local re-verification that makes the transport untrusted for content.
 */
import { describe, it } from 'fino:test/test';
import { ClusterClient } from 'internal:cluster/client';
import { packCask, caskSha256Hex } from 'internal:cluster/cask';
import type { ClusterMessage } from 'internal:cluster/protocol';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();

/** Poll until `check` passes; uploads send after an async file read. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}
const scratch = `/tmp/fino-cask-xfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function fakeSeedTransport() {
  const sent: Array<{ to: string; msg: ClusterMessage }> = [];
  let handler: ((from: string, msg: ClusterMessage) => void) | null = null;
  return {
    sent,
    nodeId: 'worker-1',
    send(to: string, msg: ClusterMessage) {
      sent.push({ to, msg });
    },
    broadcast() {},
    on(h: (from: string, msg: ClusterMessage) => void) {
      handler = h;
    },
    close() {},
    inject(msg: ClusterMessage) {
      handler?.('__seed__', msg);
    },
  };
}

async function makeCask(): Promise<{ path: string; hash: string; bytes: Uint8Array }> {
  await fs.mkdir(scratch).catch(() => {});
  const app = `${scratch}/app`;
  await fs.mkdir(app).catch(() => {});
  await fs.writeFile(`${app}/main.ts`, new TextEncoder().encode(`console.log('deployed');\n`));
  const packed = await packCask(app, `${scratch}/app.cask`, {
    name: 'xfer',
    version: '1',
    entry: 'main.ts',
  });
  return { path: packed.path, hash: packed.hash, bytes: await fs.readFile(packed.path) };
}

describe('client cask transfer', () => {
  it('uploads in ordered chunks and resolves on the verification ack', async (t) => {
    const transport = fakeSeedTransport();
    const client = new ClusterClient(transport as never, 'worker-1');
    client.start();
    try {
      const cask = await makeCask();
      const uploading = client.uploadCask(cask.path);
      await waitFor(
        () => transport.sent.some((s) => s.msg.t === 'CASK_PUT' && (s.msg as { last: boolean }).last),
        'upload chunks',
      );
      const puts = transport.sent.filter((s) => s.msg.t === 'CASK_PUT');
      const seqs = puts.map((p) => (p.msg as { seq: number }).seq);
      t.deepEqual(seqs, seqs.map((_, i) => i), 'chunks are ordered from zero');
      t.equal((puts[puts.length - 1]!.msg as { last: boolean }).last, true, 'last is flagged');

      transport.inject({ t: 'CASK_ACK', hash: cask.hash, ok: true });
      t.equal(await uploading, cask.hash, 'resolves with the content identity');
    } finally {
      client.stop();
    }
  });

  it('rejects an upload the seed refuses', async (t) => {
    const transport = fakeSeedTransport();
    const client = new ClusterClient(transport as never, 'worker-1');
    client.start();
    try {
      const cask = await makeCask();
      const uploading = client.uploadCask(cask.path);
      await waitFor(
        () => transport.sent.some((s) => s.msg.t === 'CASK_PUT' && (s.msg as { last: boolean }).last),
        'upload chunks',
      );
      transport.inject({ t: 'CASK_ACK', hash: cask.hash, ok: false, error: 'store offline' });
      await t.rejects(() => uploading, /store offline/, 'the refusal reason surfaces');
    } finally {
      client.stop();
    }
  });

  it('fetches, re-verifies locally, and unpacks into the cache', async (t) => {
    const transport = fakeSeedTransport();
    const client = new ClusterClient(transport as never, 'worker-1');
    client.start();
    try {
      const cask = await makeCask();
      const cache = `${scratch}/cache`;
      const fetching = client.fetchCask(cask.hash, cache);
      await waitFor(() => transport.sent.some((s) => s.msg.t === 'CASK_GET'), 'fetch request');
      const gets = transport.sent.filter((s) => s.msg.t === 'CASK_GET');
      t.equal(gets.length, 1, 'one fetch request');

      const mid = Math.floor(cask.bytes.length / 2);
      transport.inject({ t: 'CASK_DATA', hash: cask.hash, seq: 0, chunk: cask.bytes.subarray(0, mid), last: false });
      transport.inject({ t: 'CASK_DATA', hash: cask.hash, seq: 1, chunk: cask.bytes.subarray(mid), last: true });

      const slot = await fetching;
      t.equal(slot.hash, cask.hash, 'identity preserved');
      t.equal(slot.dir, `${cache}/sha256-${cask.hash}`, 'content-addressed slot');
      const entry = new TextDecoder().decode(await fs.readFile(slot.entryPath));
      t.ok(entry.includes('deployed'), 'entry module intact after reassembly');
    } finally {
      client.stop();
    }
  });

  it('refuses corrupted fetch bytes before they reach the cache', async (t) => {
    const transport = fakeSeedTransport();
    const client = new ClusterClient(transport as never, 'worker-1');
    client.start();
    try {
      const cask = await makeCask();
      const corrupted = cask.bytes.slice();
      corrupted[10] ^= 0xff;
      t.ok((await caskSha256Hex(corrupted)) !== cask.hash, 'corruption changes the hash');
      const cache = `${scratch}/cache-bad`;
      const fetching = client.fetchCask(cask.hash, cache);
      await waitFor(() => transport.sent.some((s) => s.msg.t === 'CASK_GET'), 'fetch request');
      transport.inject({ t: 'CASK_DATA', hash: cask.hash, seq: 0, chunk: corrupted, last: true });
      await t.rejects(() => fetching, /hash mismatch/, 'delivery is trusted, content is not');
      const slotMissing = await fs
        .stat(`${cache}/sha256-${cask.hash}`)
        .then(() => false, () => true);
      t.ok(slotMissing, 'nothing entered the cache');
    } finally {
      client.stop();
    }
  });
});
