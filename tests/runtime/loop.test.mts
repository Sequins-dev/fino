/**
 * Tests for fino:loop — promise-based event loop API.
 */

import { describe, it } from 'fino:test/test';
import * as loop from 'fino:runtime/loop';
import * as sock from 'fino:net/socket';
const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);

function requireRecv(value: number | Uint8Array | null): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('Expected recv() to return bytes');
  return value;
}

describe('Basic operations', () => {
  it('timeout() resolves after delay', async (t) => {
    const t0 = Date.now();
    await loop.timeout(50);
    const elapsed = Date.now() - t0;
    t.ok(elapsed >= 40, 'at least 40ms elapsed (' + elapsed + 'ms)');
  });

  it('multiple sequential timeouts', async (t) => {
    for (let i = 0; i < 3; i++) {
      await loop.timeout(20);
    }
    t.ok(true, '3 sequential timeouts resolved');
  });
});

describe('I/O watchers', () => {
  it('readable() resolves when fd has data', async (t) => {
    const PORT = 19950;

    const server = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setsockopt(server, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(server, { family: 'ipv4', ip: '127.0.0.1', port: PORT });
    sock.listen(server, 5);
    sock.setNonblocking(server);

    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    sock.connect(client, { family: 'ipv4', ip: '127.0.0.1', port: PORT });

    await loop.readable(server);
    const accepted = sock.accept(server);
    if (!accepted) throw new Error('accept() returned null');
    const { fd: peer } = accepted;
    sock.setNonblocking(peer);

    await loop.writable(client);
    sock.send(client, encodeUtf8('ping'), 0);
    await loop.readable(peer);
    const data = requireRecv(sock.recv(peer, 64, 0));
    t.equal(decodeUtf8(data), 'ping', 'data received correctly');

    sock.close(peer);
    sock.close(client);
    sock.close(server);
  });

  it('writable() resolves when connected socket is writable', async (t) => {
    const PORT = 19951;

    const server = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setsockopt(server, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(server, { family: 'ipv4', ip: '127.0.0.1', port: PORT });
    sock.listen(server, 5);
    sock.setNonblocking(server);

    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    sock.connect(client, { family: 'ipv4', ip: '127.0.0.1', port: PORT });

    await loop.writable(client);
    const errBuf = sock.getsockopt(client, sock.SOL_SOCKET, sock.SO_ERROR);
    const errno  = new DataView(errBuf).getInt32(0, true);
    t.equal(errno, 0, 'connect succeeded (SO_ERROR is 0)');

    sock.close(client);
    sock.close(server);
  });

  it('readable() can be awaited repeatedly on the same fd', async (t) => {
    const PORT = 19953;

    const server = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setsockopt(server, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(server, { family: 'ipv4', ip: '127.0.0.1', port: PORT });
    sock.listen(server, 5);
    sock.setNonblocking(server);

    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    sock.connect(client, { family: 'ipv4', ip: '127.0.0.1', port: PORT });

    await loop.readable(server);
    const accepted = sock.accept(server);
    if (!accepted) throw new Error('accept() returned null');
    const { fd: peer } = accepted;
    sock.setNonblocking(peer);

    await loop.writable(client);
    sock.send(client, encodeUtf8('one'), 0);
    await loop.readable(peer);
    t.equal(decodeUtf8(requireRecv(sock.recv(peer, 64, 0))), 'one', 'first payload received');

    sock.send(client, encodeUtf8('two'), 0);
    await loop.readable(peer);
    t.equal(decodeUtf8(requireRecv(sock.recv(peer, 64, 0))), 'two', 'second payload received');

    sock.close(peer);
    sock.close(client);
    sock.close(server);
  });

  it('removeRead cancels a pending watch silently', (t) => {
    const PORT = 19952;

    const server = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setsockopt(server, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(server, { family: 'ipv4', ip: '127.0.0.1', port: PORT });
    sock.listen(server, 5);
    sock.setNonblocking(server);

    const p = loop.readable(server);
    loop.removeRead(server);
    t.ok(p instanceof Promise, 'readable() returned a Promise');

    sock.close(server);
  });
});

describe('spin / run', () => {
  it('loop.spin() drives promise to completion synchronously', (t) => {
    let resolved = false;
    const p = new Promise<void>((resolve) => {
      loop.timeout(50).then(() => { resolved = true; resolve(); });
    });
    loop.spin(p);
    t.ok(resolved, 'promise was resolved synchronously by spin()');
  });

  it('loop.run() spins until fn promise resolves', (t) => {
    let resolved = false;
    loop.run(() => {
      return loop.timeout(30).then(() => { resolved = true; });
    });
    t.ok(resolved, 'run() drove timeout to completion');
  });
});

describe('AbortSignal', () => {
  it('loop.spin() with AbortSignal — pre-aborted', (t) => {
    const sig = AbortSignal.abort(new Error('pre-aborted'));
    const p = new Promise(() => {}); // never resolves — no loop entry
    let threw = false;
    try {
      loop.spin(p, { signal: sig });
    } catch (e: unknown) {
      threw = true;
      t.equal(e instanceof Error ? e.message : String(e), 'pre-aborted', 'threw pre-abort reason');
    }
    t.ok(threw, 'spin() threw for pre-aborted signal');
  });

  it('loop.spin() with AbortSignal — fires during spin', (t) => {
    const ac = new AbortController();
    loop.timeout(30).then(() => ac.abort(new Error('aborted!')));
    const p = new Promise(() => {}); // never resolves — no loop entry
    let threw = false;
    try {
      loop.spin(p, { signal: ac.signal });
    } catch (e: unknown) {
      threw = true;
      t.equal(e instanceof Error ? e.message : String(e), 'aborted!', 'threw the abort reason');
    }
    t.ok(threw, 'spin() threw when signal aborted mid-spin');
  });

  it('loop.run() with AbortSignal', (t) => {
    const ac = new AbortController();
    let threw = false;
    try {
      loop.run(() => {
        const p = new Promise(() => {}); // never resolves — no loop entry
        loop.timeout(30).then(() => ac.abort(new Error('run aborted')));
        return p;
      }, { signal: ac.signal });
    } catch (e: unknown) {
      threw = true;
      t.equal(e instanceof Error ? e.message : String(e), 'run aborted', 'threw abort reason');
    }
    t.ok(threw, 'run() threw when signal aborted');
  });
});
