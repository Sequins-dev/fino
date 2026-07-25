/** Public cluster membership integration coverage. */
import { describe, it } from 'fino:test/test';
import { startCluster, joinCluster, leaveCluster } from 'fino:cluster';
import { quicAvailable } from 'fino:net/quic';
import { h3Available } from 'internal:net/http/h3/bindings';

const tls = {
  cert: `${import.meta.dirname}/../net/fixtures/test.crt`,
  key: `${import.meta.dirname}/../net/fixtures/test.key`
};
const randomPort = (): number => 3e4 + Math.floor(Math.random() * 1e4);

describe('fino:cluster membership', () => {
  it('rejects non-HTTPS seed URLs', async (t) => {
    await t.rejects(() => joinCluster({ seed: 'ws://127.0.0.1:1' }), /must use https:/);
  });

  it('starts, leaves, and can start again', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = randomPort();
    await startCluster({ port, nodeId: 'seed-1', tls });
    leaveCluster();
    leaveCluster();
    await startCluster({ port: port + 1, nodeId: 'seed-2', tls });
    leaveCluster();
    t.ok(true);
  });

  it('allows only one active cluster connection', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = randomPort();
    await startCluster({ port, nodeId: 'seed-1', tls });
    try {
      await t.rejects(() => startCluster({ port: port + 1, nodeId: 'seed-2', tls }), /already connected/);
    } finally {
      leaveCluster();
    }
  });
});
