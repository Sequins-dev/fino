/**
 * Direct peer sessions: two nodes with listeners exchange PORT_MSG straight
 * between themselves, with the seed carrying only the introduction.
 */
import { describe, it } from 'fino:test/test';
import { cwd } from 'fino:process';
import { PeerMesh } from 'internal:cluster/webtransport-transport';
import { quicAvailable } from 'fino:net/quic';
import { h3Available } from 'internal:net/http/h3/bindings';
import { DiskFileSystem } from 'fino:file';
import * as loop from 'internal:runtime/loop';
import type { ClusterMessage } from 'internal:cluster/protocol';

const tls = {
  cert: `${cwd()}/tests/net/fixtures/test.crt`,
  key: `${cwd()}/tests/net/fixtures/test.key`,
};

function randomPort(): number {
  return 3e4 + Math.floor(Math.random() * 1e4);
}

let cachedHash: Promise<string> | null = null;
function certHash(): Promise<string> {
  cachedHash ??= computeCertHash();
  return cachedHash;
}

async function computeCertHash(): Promise<string> {
  const pem = new TextDecoder().decode(await new DiskFileSystem().readFile(tls.cert));
  const base64 = pem.match(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/)![1]!.replace(
    /\s+/g,
    '',
  );
  const binary = atob(base64);
  const der = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('direct peer mesh', () => {
  it('delivers PORT_MSG peer-to-peer and refuses bad credentials', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const hash = await certHash();
    const port = randomPort();
    // 'node-a' < 'node-b', so node-a dials and node-b accepts.
    const acceptor = new PeerMesh({
      nodeId: 'node-b',
      clusterId: 'c-mesh',
      token: 'peer-secret',
      incarnation: 1,
      listen: { port, hostname: '127.0.0.1', tls },
    });
    const dialer = new PeerMesh({
      nodeId: 'node-a',
      clusterId: 'c-mesh',
      token: 'peer-secret',
      incarnation: 1,
    });
    const received: ClusterMessage[] = [];
    acceptor.on((from, msg) => {
      if (from === 'node-a') received.push(msg);
    });
    try {
      await acceptor.listen();
      const endpoint = `https://127.0.0.1:${port}/__fino_cluster`;
      const dialed = await dialer.dial({ nodeId: 'node-b', endpoint, certHash: hash });
      t.equal(dialed, true, 'dialer established a direct session');
      t.deepEqual(dialer.connected, ['node-b'], 'session is tracked by node id');

      const sent = dialer.send('node-b', {
        t: 'PORT_MSG',
        fromPort: 'node-a/p-1',
        toPort: 'node-b/p-2',
        payload: [new Uint8Array([7, 8, 9])],
        seq: 1,
      });
      t.equal(sent, true, 'send reports direct delivery');
      const deadline = Date.now() + 5000;
      while (received.length === 0 && Date.now() < deadline) {
        await loop.timeout(20);
      }
      t.equal(received.length, 1, 'the peer received the frame directly');
      const frame = received[0]!;
      t.equal(frame.t, 'PORT_MSG', 'frame type survives the direct path');
      if (frame.t === 'PORT_MSG') {
        t.equal(frame.toPort, 'node-b/p-2', 'destination port preserved');
        t.deepEqual(Array.from(frame.payload[0]!), [7, 8, 9], 'payload bytes preserved');
      }

      t.equal(
        dialer.send('node-c', { t: 'HEARTBEAT', ts: 1 }),
        false,
        'send without a session reports false so callers fall back to the seed',
      );
    } finally {
      dialer.close();
      acceptor.close();
      await loop.timeout(200);
    }
  });

  it('refuses a dialer presenting the wrong token', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const hash = await certHash();
    const port = randomPort();
    const acceptor = new PeerMesh({
      nodeId: 'node-z',
      clusterId: 'c-real',
      token: 'right-token',
      incarnation: 1,
      listen: { port, hostname: '127.0.0.1', tls },
    });
    const seen: string[] = [];
    acceptor.on((from) => seen.push(from));
    const wrongToken = new PeerMesh({
      nodeId: 'node-a',
      clusterId: 'c-real',
      token: 'wrong-token',
      incarnation: 1,
    });
    try {
      await acceptor.listen();
      await wrongToken.dial({
        nodeId: 'node-z',
        endpoint: `https://127.0.0.1:${port}/__fino_cluster`,
        certHash: hash,
      });
      wrongToken.send('node-z', { t: 'HEARTBEAT', ts: 1 });
      await loop.timeout(300);
      t.equal(seen.length, 0, 'an unauthenticated dialer delivers nothing');
    } finally {
      wrongToken.close();
      acceptor.close();
      await loop.timeout(200);
    }
  });
});
