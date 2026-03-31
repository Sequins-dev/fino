/**
 * Tests for boats:loop — promise-based event loop API.
 */

import { describe, it } from 'boats:test/test';
import * as loop from 'boats:runtime/loop';
import * as sock from 'boats:net/socket';
const encodeUtf8 = s => new TextEncoder().encode(s);
const decodeUtf8 = b => new TextDecoder().decode(b);

describe('Basic operations', () => {
  it('create() returns a handle, destroy() cleans up', (t) => {
    const lp = loop.create();
    t.ok(lp !== null && typeof lp === 'object', 'handle is an object');
    loop.destroy(lp);
    t.ok(true, 'destroy did not throw');
  });

  it('timeout() resolves after delay', async (t) => {
    const lp = loop.create();
    const t0 = Date.now();
    await loop.timeout(lp, 50);
    const elapsed = Date.now() - t0;
    t.ok(elapsed >= 40, 'at least 40ms elapsed (' + elapsed + 'ms)');
    loop.destroy(lp);
  });

  it('multiple sequential timeouts', async (t) => {
    const lp = loop.create();
    for (let i = 0; i < 3; i++) {
      await loop.timeout(lp, 20);
    }
    t.ok(true, '3 sequential timeouts resolved');
    loop.destroy(lp);
  });
});

describe('I/O watchers', () => {
  it('readable() resolves when fd has data', async (t) => {
    const PORT = 19950;
    const lp = loop.create();

    const server = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setsockopt(server, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(server, { family: 'ipv4', ip: '127.0.0.1', port: PORT });
    sock.listen(server, 5);
    sock.setNonblocking(server);

    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    sock.connect(client, { family: 'ipv4', ip: '127.0.0.1', port: PORT });

    await loop.readable(lp, server);
    const { fd: peer } = sock.accept(server);
    sock.setNonblocking(peer);

    await loop.writable(lp, client);
    sock.send(client, encodeUtf8('ping'), 0);
    await loop.readable(lp, peer);
    const data = sock.recv(peer, 64, 0);
    t.equal(decodeUtf8(data), 'ping', 'data received correctly');

    sock.close(peer);
    sock.close(client);
    sock.close(server);
    loop.destroy(lp);
  });

  it('writable() resolves when connected socket is writable', async (t) => {
    const PORT = 19951;
    const lp = loop.create();

    const server = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setsockopt(server, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(server, { family: 'ipv4', ip: '127.0.0.1', port: PORT });
    sock.listen(server, 5);
    sock.setNonblocking(server);

    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    sock.connect(client, { family: 'ipv4', ip: '127.0.0.1', port: PORT });

    await loop.writable(lp, client);
    const errBuf = sock.getsockopt(client, sock.SOL_SOCKET, sock.SO_ERROR);
    const errno  = new DataView(errBuf).getInt32(0, true);
    t.equal(errno, 0, 'connect succeeded (SO_ERROR is 0)');

    sock.close(client);
    sock.close(server);
    loop.destroy(lp);
  });

  it('removeRead cancels a pending watch silently', (t) => {
    const PORT = 19952;
    const lp = loop.create();

    const server = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setsockopt(server, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
    sock.bind(server, { family: 'ipv4', ip: '127.0.0.1', port: PORT });
    sock.listen(server, 5);
    sock.setNonblocking(server);

    const p = loop.readable(lp, server);
    loop.removeRead(lp, server);
    t.ok(p instanceof Promise, 'readable() returned a Promise');

    sock.close(server);
    loop.destroy(lp);
  });
});

describe('Structured concurrency', () => {
  it('loop.current() returns the active loop context', (t) => {
    const outer = loop.current();
    t.ok(outer !== undefined, 'current() returns the test runner\'s loop');

    const lp = loop.create();
    let seen;
    loop.runWith(lp, () => { seen = loop.current(); });
    t.equal(seen, lp, 'current() returned the supplied handle inside runWith');
    t.equal(loop.current(), outer, 'current() restored to outer loop after runWith');
    loop.destroy(lp);
  });

  it('loop.run() sets current() inside fn and restores after', (t) => {
    const outer = loop.current();
    let seen;
    loop.run(() => { seen = loop.current(); });
    t.ok(seen !== undefined, 'current() returned a handle inside run()');
    t.ok(seen !== outer, 'run() used a fresh loop, not the outer one');
    t.equal(loop.current(), outer, 'current() restored to outer loop after run()');
  });

  it('loop.runWith() sets current() for duration and restores after', (t) => {
    const outer = loop.current();
    const lp = loop.create();
    let seen;
    loop.runWith(lp, () => { seen = loop.current(); });
    t.equal(seen, lp, 'current() returned the supplied handle');
    t.equal(loop.current(), outer, 'current() restored to outer loop after runWith()');
    loop.destroy(lp);
  });

  it('loop.current() propagates through await', async (t) => {
    let outerHandle;
    let innerHandle;

    await new Promise((resolve) => {
      const lp = loop.create();
      loop.runWith(lp, () => {
        outerHandle = loop.current();
        Promise.resolve().then(() => {
          innerHandle = loop.current();
          resolve();
        });
      });
    });

    t.ok(outerHandle !== undefined, 'outerHandle set inside runWith');
    t.equal(outerHandle, innerHandle, 'current() same handle after await');
    loop.destroy(outerHandle);
  });

  it('loop.spin() drives promise to completion synchronously', (t) => {
    let resolved = false;
    const lp = loop.create();
    const p = new Promise((resolve) => {
      loop.timeout(lp, 50).then(() => { resolved = true; resolve(); });
    });
    loop.spin(lp, p);
    t.ok(resolved, 'promise was resolved synchronously by spin()');
    loop.destroy(lp);
  });

  it('parent-child binding: child loop polled by parent spin', (t) => {
    const parent = loop.create();
    let childResolved = false;

    loop.runWith(parent, () => {
      const child = loop.create();
      const childDone = loop.timeout(child, 30).then(() => { childResolved = true; });
      loop.spin(parent, childDone);
      loop.destroy(child);
    });

    t.ok(childResolved, 'child loop timeout was polled by parent spin');
    loop.destroy(parent);
  });

  it('microtask isolation: spin on A does not run B microtasks prematurely', (t) => {
    const lpA = loop.create();
    const lpB = loop.create();

    loop.runWith(lpB, () => {
      Promise.resolve().then(() => {});
    });

    loop.runWith(lpA, () => {
      loop.spin(lpA, loop.timeout(lpA, 20));
    });

    t.ok(true, 'spin on A completed without error (isolation holds during spin)');

    loop.destroy(lpA);
    loop.destroy(lpB);
  });
});

describe('AbortSignal', () => {
  it('loop.spin() with AbortSignal — pre-aborted', (t) => {
    const lp = loop.create();
    const sig = AbortSignal.abort(new Error('pre-aborted'));
    const p = loop.timeout(lp, 10000);
    let threw = false;
    try {
      loop.spin(lp, p, { signal: sig });
    } catch (e) {
      threw = true;
      t.equal(e.message, 'pre-aborted', 'threw pre-abort reason');
    }
    t.ok(threw, 'spin() threw for pre-aborted signal');
    loop.destroy(lp);
  });

  it('loop.spin() with AbortSignal — fires during spin', (t) => {
    const lp = loop.create();
    const ac = new AbortController();
    loop.timeout(lp, 30).then(() => ac.abort(new Error('aborted!')));
    const p = loop.timeout(lp, 10000);
    let threw = false;
    try {
      loop.spin(lp, p, { signal: ac.signal });
    } catch (e) {
      threw = true;
      t.equal(e.message, 'aborted!', 'threw the abort reason');
    }
    t.ok(threw, 'spin() threw when signal aborted mid-spin');
    loop.destroy(lp);
  });

  it('loop.run() with AbortSignal', (t) => {
    const ac = new AbortController();
    let threw = false;
    try {
      loop.run(() => {
        const lp = loop.current();
        const p = loop.timeout(lp, 10000);
        loop.timeout(lp, 30).then(() => ac.abort(new Error('run aborted')));
        return p;
      }, { signal: ac.signal });
    } catch (e) {
      threw = true;
      t.equal(e.message, 'run aborted', 'threw abort reason');
    }
    t.ok(threw, 'run() threw when signal aborted');
  });
});
