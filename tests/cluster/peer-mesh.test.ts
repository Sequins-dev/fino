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

  it('keeps delivering past the QUIC concurrent-stream limit', async (t) => {
    if (!quicAvailable || !h3Available) return;
    // A transport that opens a stream per message runs out of stream credit —
    // QUIC's initial_max_streams_bidi is 100 — and then blocks forever on
    // createBidirectionalStream(). That looked like a mysterious stall in a
    // running cluster rather than a limit, because the sends simply stopped
    // completing. 250 is comfortably past the cliff.
    const MESSAGES = 250;
    const hash = await certHash();
    const port = randomPort();
    const acceptor = new PeerMesh({
      nodeId: 'node-b',
      clusterId: 'c-volume',
      token: 'peer-secret',
      incarnation: 1,
      listen: { port, hostname: '127.0.0.1', tls },
    });
    const dialer = new PeerMesh({
      nodeId: 'node-a',
      clusterId: 'c-volume',
      token: 'peer-secret',
      incarnation: 1,
    });
    // A ping-pong, not a one-way burst: the stall only appears when both ends
    // are opening streams, which is what any realm conversation does.
    const replies: number[] = [];
    acceptor.on((from, msg) => {
      if (from !== 'node-a' || msg.t !== 'PORT_MSG') return;
      acceptor.send('node-a', {
        t: 'PORT_MSG',
        fromPort: 'node-b/p-2',
        toPort: 'node-a/p-1',
        payload: msg.payload,
        seq: msg.seq,
      });
    });
    dialer.on((from, msg) => {
      if (from === 'node-b' && msg.t === 'PORT_MSG') replies.push(msg.seq);
    });
    try {
      await acceptor.listen();
      const dialed = await dialer.dial({
        nodeId: 'node-b',
        endpoint: `https://127.0.0.1:${port}/__fino_cluster`,
        certHash: hash,
      });
      t.equal(dialed, true, 'session established');

      for (let seq = 1; seq <= MESSAGES; seq++) {
        dialer.send('node-b', {
          t: 'PORT_MSG',
          fromPort: 'node-a/p-1',
          toPort: 'node-b/p-2',
          payload: [new Uint8Array([seq & 0xff])],
          seq,
        });
      }
      const deadline = Date.now() + 20_000;
      while (replies.length < MESSAGES && Date.now() < deadline) {
        await loop.timeout(50);
      }
      t.equal(replies.length, MESSAGES, `all ${MESSAGES} frames were echoed back`);
      // One lane per direction means the receiver sees them in send order, so
      // the sequence numbers should need no reordering at all.
      t.deepEqual(
        replies.slice(0, 5),
        [1, 2, 3, 4, 5],
        'frames arrive in the order they were sent',
      );
      // The invariant, not the symptom. Delivery alone passes on a transport
      // that opens a stream per message — right up until it exhausts stream
      // credit and wedges, which is how this shipped. Stream count must not
      // scale with traffic: one control lane and one port lane per direction.
      t.ok(
        acceptor.inboundStreams <= 4,
        `${MESSAGES} messages rode ${acceptor.inboundStreams} stream(s), not one each`,
      );
    } finally {
      dialer.close();
      acceptor.close();
      await loop.timeout(200);
    }
  });

  it('refuses two dialers without leaking a loop handle', async (t) => {
    if (!quicAvailable || !h3Available) return;
    // FIN-155: with two refusals the acceptor used to leave a read handle
    // registered after full teardown, so the process never exited. One
    // refusal drained cleanly, which is why the suite could only cover one.
    // The assertion is on the loop, not on the refusal — a leak here means a
    // hung process, and a hung process is how it was noticed.
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
    const wrongCluster = new PeerMesh({
      nodeId: 'node-b',
      clusterId: 'c-other',
      token: 'right-token',
      incarnation: 1,
    });
    const endpoint = `https://127.0.0.1:${port}/__fino_cluster`;
    try {
      await acceptor.listen();
      await wrongToken.dial({ nodeId: 'node-z', endpoint, certHash: hash });
      await wrongCluster.dial({ nodeId: 'node-z', endpoint, certHash: hash });
      await loop.timeout(300);
      t.equal(seen.length, 0, 'neither unauthenticated dialer delivered anything');
    } finally {
      wrongToken.close();
      wrongCluster.close();
      acceptor.close();
      await loop.timeout(700);
    }
    const handles = loop._activeHandleCounts();
    t.equal(handles.reads, 0, `reads drained after two refusals (${JSON.stringify(handles)})`);
    t.equal(handles.writes, 0, 'writes drained after two refusals');
  });
});
