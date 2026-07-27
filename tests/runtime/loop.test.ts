/**
 * Tests for fino:loop — promise-based event loop API.
 */
import { describe, it } from 'fino:test/test';
import * as loop from 'internal:runtime/loop';
import * as backend from 'internal:runtime/loop-backend';
import * as fileBindings from 'internal:file/bindings';
import * as sock from 'fino:net/socket';
const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
const NOTE_WRITE = 2;
const NOTE_EXTEND = 4;
function requireRecv(value: number | Uint8Array | null): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('Expected recv() to return bytes');
  return value;
}
function wait<T>(promise: Promise<T>): T {
  return loop.spin(promise);
}
function listenOnEphemeralPort(): {
  fd: number;
  port: number;
} {
  const fd = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
  sock.setsockopt(fd, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
  sock.bind(fd, {
    family: 'ipv4',
    ip: '127.0.0.1',
    port: 0,
  });
  sock.listen(fd, 5);
  sock.setNonblocking(fd);
  const address = sock.getsockname(fd);
  if (address.family !== 'ipv4') throw new Error('expected IPv4 socket address');
  return {
    fd,
    port: address.port,
  };
}
function connectedPair(): {
  server: number;
  client: number;
  peer: number;
} {
  const { fd: server, port } = listenOnEphemeralPort();
  const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
  sock.setNonblocking(client);
  sock.connect(client, {
    family: 'ipv4',
    ip: '127.0.0.1',
    port,
  });
  wait(loop.readable(server));
  const accepted = sock.accept(server);
  if (!accepted) throw new Error('accept() returned null');
  sock.setNonblocking(accepted.fd);
  wait(loop.writable(client));
  return {
    server,
    client,
    peer: accepted.fd,
  };
}
function closeAll(...fds: number[]): void {
  for (const fd of fds) {
    try {
      sock.close(fd);
    } catch {}
  }
}
describe('Backend contract', () => {
  it('exposes the common readiness, timer, and wait surface', (t) => {
    for (const name of [
      'create',
      'addRead',
      'addWrite',
      'removeRead',
      'removeWrite',
      'addTimer',
      'removeTimer',
      'wait',
      'destroy',
    ]) {
      t.equal(typeof (backend as Record<string, unknown>)[name], 'function', `${name} is exported`);
    }
    t.equal(typeof backend.EVFILT_READ, 'number', 'read filter is exported');
    t.equal(typeof backend.EVFILT_WRITE, 'number', 'write filter is exported');
    t.equal(typeof backend.EVFILT_TIMER, 'number', 'timer filter is exported');
    if (fileBindings.isDarwin) {
      t.equal(typeof backend.EVFILT_PROC, 'number', 'macOS backend exports proc events');
      t.equal(typeof backend.EVFILT_VNODE, 'number', 'macOS backend exports vnode events');
      t.equal(
        backend.EVFILT_COMPLETION,
        undefined,
        'macOS backend does not expose completion events',
      );
    } else {
      t.equal(backend.EVFILT_PROC, undefined, 'Linux backend does not expose proc events');
      t.equal(backend.EVFILT_VNODE, undefined, 'Linux backend does not expose vnode events');
      t.equal(
        typeof backend.EVFILT_COMPLETION,
        'number',
        'Linux backend exposes completion events',
      );
    }
  });
  it('creates a platform backend handle with explicit Linux fallback kind', (t) => {
    const raw = backend.create() as {
      kind?: unknown;
    };
    try {
      if (fileBindings.isDarwin) {
        t.equal(typeof raw.fd, 'number', 'macOS backend handle owns a kqueue fd');
      } else {
        t.ok(
          raw.kind === 'io_uring' || raw.kind === 'poll',
          'Linux backend selects io_uring or poll',
        );
      }
    } finally {
      backend.destroy(raw as never);
    }
  });
  it('removes absent readiness watches from a fresh backend', (t) => {
    const raw = backend.create();
    try {
      backend.removeRead(raw, -1);
      backend.removeWrite(raw, -1);
      t.ok(true, 'read and write cleanup are idempotent before registration');
    } finally {
      backend.destroy(raw);
    }
  });
});
describe('Basic operations', () => {
  it('timeout() resolves after delay', (t) => {
    const t0 = Date.now();
    wait(loop.timeout(50));
    const elapsed = Date.now() - t0;
    t.ok(elapsed >= 40, 'at least 40ms elapsed (' + elapsed + 'ms)');
  });
  it('multiple sequential timeouts', (t) => {
    for (let i = 0; i < 3; i++) {
      wait(loop.timeout(20));
    }
    t.ok(true, '3 sequential timeouts resolved');
  });
  it('cancelled timer churn does not delay later timers', (t) => {
    for (let i = 0; i < 1024; i++) {
      const timer = loop.timeout(1e4);
      timer.cancel();
    }
    const t0 = Date.now();
    wait(loop.timeout(20));
    const elapsed = Date.now() - t0;
    t.ok(elapsed < 500, 'short timeout was not delayed by cancelled timers (' + elapsed + 'ms)');
  });
  it('cancelled timers stop keeping the loop alive without settling', (t) => {
    const baselineAlive = loop.alive();
    let resolved = false;
    const timer = loop.timeout(1e4);
    timer.then(() => {
      resolved = true;
    });
    t.equal(loop.alive(), true, 'pending timer keeps the loop alive');
    timer.cancel();
    wait(Promise.resolve());
    t.equal(resolved, false, 'cancelled timer promise stays unsettled');
    t.equal(
      loop.alive(),
      baselineAlive,
      'cancelled timer restores the previous loop liveness state',
    );
  });
});
describe('I/O watchers', () => {
  it('readable() resolves when fd has data', (t) => {
    const { fd: server, port } = listenOnEphemeralPort();
    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    sock.connect(client, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port,
    });
    wait(loop.readable(server));
    const accepted = sock.accept(server);
    if (!accepted) throw new Error('accept() returned null');
    const { fd: peer } = accepted;
    sock.setNonblocking(peer);
    wait(loop.writable(client));
    sock.send(client, encodeUtf8('ping'), 0);
    wait(loop.readable(peer));
    const data = requireRecv(sock.recv(peer, 64, 0));
    t.equal(decodeUtf8(data), 'ping', 'data received correctly');
    sock.close(peer);
    sock.close(client);
    sock.close(server);
  });
  it('writable() resolves when connected socket is writable', (t) => {
    const { fd: server, port } = listenOnEphemeralPort();
    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    sock.connect(client, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port,
    });
    wait(loop.writable(client));
    const errBuf = sock.getsockopt(client, sock.SOL_SOCKET, sock.SO_ERROR);
    const errno = new DataView(errBuf).getInt32(0, true);
    t.equal(errno, 0, 'connect succeeded (SO_ERROR is 0)');
    sock.close(client);
    sock.close(server);
  });
  it('readable() can be awaited repeatedly on the same fd', (t) => {
    const { fd: server, port } = listenOnEphemeralPort();
    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    sock.connect(client, {
      family: 'ipv4',
      ip: '127.0.0.1',
      port,
    });
    wait(loop.readable(server));
    const accepted = sock.accept(server);
    if (!accepted) throw new Error('accept() returned null');
    const { fd: peer } = accepted;
    sock.setNonblocking(peer);
    wait(loop.writable(client));
    sock.send(client, encodeUtf8('one'), 0);
    wait(loop.readable(peer));
    t.equal(decodeUtf8(requireRecv(sock.recv(peer, 64, 0))), 'one', 'first payload received');
    sock.send(client, encodeUtf8('two'), 0);
    wait(loop.readable(peer));
    t.equal(decodeUtf8(requireRecv(sock.recv(peer, 64, 0))), 'two', 'second payload received');
    sock.close(peer);
    sock.close(client);
    sock.close(server);
  });
  it('removeRead cancels a pending watch silently', (t) => {
    const { fd: server } = listenOnEphemeralPort();
    const p = loop.readable(server);
    loop.removeRead(server);
    t.ok(p instanceof Promise, 'readable() returned a Promise');
    sock.close(server);
  });
  it('closing a watched fd cannot wake a recycled fd', (t) => {
    const { fd: stale } = listenOnEphemeralPort();
    let staleResolved = false;
    loop.readable(stale).then(() => {
      staleResolved = true;
    });
    sock.close(stale);
    const { fd: server, port } = listenOnEphemeralPort();
    try {
      if (server !== stale) {
        t.ok(true, 'platform did not immediately recycle the watched fd');
        return;
      }
      let currentResolved = false;
      const current = loop.readable(server).then(() => {
        currentResolved = true;
      });
      loop.tick(20);
      t.equal(currentResolved, false, 'stale close completion did not wake the recycled fd');
      const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
      sock.setNonblocking(client);
      try {
        sock.connect(client, {
          family: 'ipv4',
          ip: '127.0.0.1',
          port,
        });
        wait(current);
        t.equal(currentResolved, true, 'new readiness still wakes the recycled fd');
      } finally {
        sock.close(client);
      }
    } finally {
      sock.close(server);
    }
    wait(Promise.resolve());
    t.equal(staleResolved, false, 'closed fd watch stayed unsettled');
  });
  it('readable() replacement resolves only the newest pending watch', (t) => {
    const { server, client, peer } = connectedPair();
    try {
      let firstResolved = false;
      let secondResolved = false;
      const first = loop.readable(peer).then(() => {
        firstResolved = true;
      });
      const second = loop.readable(peer).then(() => {
        secondResolved = true;
      });
      sock.send(client, encodeUtf8('replace-read'), 0);
      wait(second);
      wait(Promise.resolve());
      t.equal(secondResolved, true, 'newest readable watch resolved');
      t.equal(firstResolved, false, 'replaced readable watch stayed unsettled');
      t.ok(first instanceof Promise, 'replaced readable watch is still a promise');
      t.equal(
        decodeUtf8(requireRecv(sock.recv(peer, 64, 0))),
        'replace-read',
        'payload remains readable',
      );
    } finally {
      closeAll(peer, client, server);
    }
  });
  it('writable() replacement resolves only the newest pending watch', (t) => {
    const { fd: server, port } = listenOnEphemeralPort();
    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    try {
      sock.connect(client, {
        family: 'ipv4',
        ip: '127.0.0.1',
        port,
      });
      let firstResolved = false;
      let secondResolved = false;
      const first = loop.writable(client).then(() => {
        firstResolved = true;
      });
      const second = loop.writable(client).then(() => {
        secondResolved = true;
      });
      wait(second);
      wait(Promise.resolve());
      t.equal(secondResolved, true, 'newest writable watch resolved');
      t.equal(firstResolved, false, 'replaced writable watch stayed unsettled');
      t.ok(first instanceof Promise, 'replaced writable watch is still a promise');
    } finally {
      closeAll(client, server);
    }
  });
  it('removeWrite is idempotent for pending and absent watches', (t) => {
    const { fd: server, port } = listenOnEphemeralPort();
    const client = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
    sock.setNonblocking(client);
    try {
      sock.connect(client, {
        family: 'ipv4',
        ip: '127.0.0.1',
        port,
      });
      const pending = loop.writable(client);
      loop.removeWrite(client);
      loop.removeWrite(client);
      t.ok(pending instanceof Promise, 'writable() returned a Promise before cancellation');
    } finally {
      closeAll(client, server);
    }
  });
});
describe('Backend-specific loop hooks', () => {
  it('registerWakeSource is omitted from reactor-pooled workload loops', async (t) => {
    const { server, client, peer } = connectedPair();
    const baselineAlive = loop.alive();
    let wakes = 0;
    try {
      loop.registerWakeSource(peer, () => {
        wakes++;
      });
      t.equal(
        loop.alive(),
        baselineAlive,
        'wake source does not change the workload loop liveness state',
      );
      sock.send(client, encodeUtf8('wake'), 0);
      const dispatched = loop.tick(0);
      t.equal(dispatched, 0, 'workload does not create a private readiness backend');
      t.equal(wakes, 0, 'workload leaves wake dispatch to the process reactor');
      await loop.readable(peer);
      t.equal(
        decodeUtf8(requireRecv(sock.recv(peer, 64, 0))),
        'wake',
        'wake bytes remain consumable',
      );
    } finally {
      loop.unregisterWakeSource(peer);
      closeAll(peer, client, server);
    }
  });
  it('vnode reports file writes on macOS and throws explicitly elsewhere', async (t) => {
    const path = `/tmp/fino-loop-vnode-${Math.floor(Math.random() * 1e6)}.txt`;
    const fd = fileBindings.lib.symbols.open(
      fileBindings.cstr(path),
      fileBindings.O_CREAT | fileBindings.O_RDWR | fileBindings.O_TRUNC,
      384,
    );
    if (fd < 0) throw new Error('open vnode fixture failed');
    try {
      if (!fileBindings.isDarwin) {
        t.throws(
          () => loop.vnode(fd, NOTE_WRITE, () => {}),
          /not supported/,
          'vnode throws when unsupported',
        );
        return;
      }
      let fflags = 0;
      let resolveVnode!: () => void;
      const vnodeReady = new Promise<void>((resolve) => {
        resolveVnode = resolve;
      });
      loop.vnode(fd, NOTE_WRITE | NOTE_EXTEND, (event) => {
        fflags |= event.fflags;
        resolveVnode();
      });
      const bytes = encodeUtf8('vnode');
      const written = fileBindings.lib.symbols.write(fd, bytes, bytes.byteLength);
      t.equal(Number(written), bytes.byteLength, 'fixture write succeeded');
      const timeout = loop.timeout(1e3);
      await Promise.race([
        vnodeReady,
        timeout.then(() => {
          throw new Error('vnode event timed out');
        }),
      ]);
      timeout.cancel();
      loop.removeVnode(fd);
      t.ok((fflags & (NOTE_WRITE | NOTE_EXTEND)) !== 0, 'vnode callback saw write or extend flag');
    } finally {
      loop.removeVnode(fd);
      fileBindings.lib.symbols.close(fd);
      fileBindings.lib.symbols.unlink(fileBindings.cstr(path));
    }
  });
  it('submit() has explicit platform behavior', async (t) => {
    if (backend.EVFILT_COMPLETION === undefined) {
      t.throws(
        () => loop.submit(() => {}),
        /not supported|unavailable/,
        'submit throws when completion backend is unavailable',
      );
      return;
    }
    t.ok(
      typeof loop.submit === 'function',
      'submit is exposed when completion backend is available',
    );
  });
});
describe('spin / run', () => {
  it('loop.spin() drives promise to completion synchronously', (t) => {
    let resolved = false;
    const p = new Promise<void>((resolve) => {
      loop.timeout(50).then(() => {
        resolved = true;
        resolve();
      });
    });
    loop.spin(p);
    t.ok(resolved, 'promise was resolved synchronously by spin()');
  });
  it('loop.run() spins until fn promise resolves', (t) => {
    let resolved = false;
    loop.run(() => {
      return loop.timeout(30).then(() => {
        resolved = true;
      });
    });
    t.ok(resolved, 'run() drove timeout to completion');
  });
});
describe('AbortSignal', () => {
  it('loop.spin() with AbortSignal — pre-aborted', (t) => {
    const sig = AbortSignal.abort(new Error('pre-aborted'));
    const p = new Promise(() => {});
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
    const p = new Promise(() => {});
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
      loop.run(
        () => {
          const p = new Promise(() => {});
          loop.timeout(30).then(() => ac.abort(new Error('run aborted')));
          return p;
        },
        { signal: ac.signal },
      );
    } catch (e: unknown) {
      threw = true;
      t.equal(e instanceof Error ? e.message : String(e), 'run aborted', 'threw abort reason');
    }
    t.ok(threw, 'run() threw when signal aborted');
  });
});
