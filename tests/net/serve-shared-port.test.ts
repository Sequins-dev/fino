import { describe, it } from 'fino:test/test';
import { cwd } from 'fino:process';
import { serveHttp } from 'fino:net/http/server';
import {
  Socket,
  socket,
  bind,
  close,
  AF_INET,
  SOCK_DGRAM,
  IPPROTO_UDP,
  EADDRINUSE,
} from 'fino:net/socket';
import { quicAvailable } from 'fino:net/quic';
import { h3Available } from 'internal:net/http/h3/bindings';

// A port may already be occupied by an unrelated UDP listener. That still
// supplies the intended collision; only other bind errors invalidate the fixture.
function occupy(fd: number, address: Parameters<typeof bind>[1]): void {
  try {
    bind(fd, address);
  } catch (error) {
    if (!(error instanceof Error) || !('errno' in error) || error.errno !== -EADDRINUSE)
      throw error;
  }
}

const tls = {
  cert: `${cwd()}/tests/net/fixtures/test.crt`,
  key: `${cwd()}/tests/net/fixtures/test.key`,
};

describe('HTTP TCP and UDP shared port selection', { exclusive: true }, () => {
  it('retries an ephemeral TCP port that is already occupied by UDP', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const listen = Socket.listen;
    const occupied = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    let attempts = 0;
    let occupiedPort = 0;
    let server: ReturnType<typeof serveHttp> | undefined;
    Socket.listen = (...args: Parameters<typeof Socket.listen>) => {
      const listener = listen(...args);
      if (++attempts === 1) {
        const address = listener.address;
        if (address.family !== 'ipv4') throw new Error('expected IPv4 listener');
        occupiedPort = address.port;
        occupy(occupied, address);
      }
      return listener;
    };
    try {
      server = serveHttp(
        { hostname: '127.0.0.1', port: 0, tls, h3: true },
        () => new Response('ok'),
      );
      await server.ready;
      t.ok(attempts >= 2 && attempts <= 16, 'reselects a port after the forced UDP collision');
      t.ok(server.port !== occupiedPort, 'reports the successfully shared port');
      t.equal(server.address.port, server.port, 'address agrees with the final port');
    } finally {
      Socket.listen = listen;
      await server?.close();
      close(occupied);
    }
  });
  it('preserves an explicitly requested port when UDP is occupied', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const candidate = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    const address = candidate.address;
    if (address.family !== 'ipv4') throw new Error('expected IPv4 listener');
    const occupied = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    occupy(occupied, address);
    candidate.close();
    const server = serveHttp(
      { hostname: address.ip, port: address.port, tls, h3: true },
      () => new Response('ok'),
    );
    try {
      await t.rejects(() => server.ready, /address already in use/);
      t.equal(server.port, address.port, 'does not silently change a requested port');
    } finally {
      await server.close();
      close(occupied);
    }
    const replacement = Socket.listen(address);
    replacement.close();
  });

  it('does not restart listeners after close during an ephemeral collision', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const listen = Socket.listen;
    const occupied = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    let attempts = 0;
    Socket.listen = (...args: Parameters<typeof Socket.listen>) => {
      const listener = listen(...args);
      attempts++;
      occupy(occupied, listener.address);
      return listener;
    };
    try {
      const server = serveHttp(
        { hostname: '127.0.0.1', port: 0, tls, h3: true },
        () => new Response('ok'),
      );
      await server.close();
      await t.rejects(() => server.ready, /address already in use/);
      t.equal(attempts, 1, 'close prevents rebinding');
    } finally {
      Socket.listen = listen;
      close(occupied);
    }
  });
  it('bounds retries and releases every failed TCP candidate', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const listen = Socket.listen;
    const occupied = new Map<number, number>();
    let attempts = 0;
    let server: ReturnType<typeof serveHttp> | undefined;
    Socket.listen = (...args: Parameters<typeof Socket.listen>) => {
      const listener = listen(...args);
      attempts++;
      const address = listener.address;
      if (address.family !== 'ipv4') throw new Error('expected IPv4 listener');
      if (!occupied.has(address.port)) {
        const fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        occupied.set(address.port, fd);
        occupy(fd, address);
      }
      return listener;
    };
    try {
      server = serveHttp(
        { hostname: '127.0.0.1', port: 0, tls, h3: true },
        () => new Response('ok'),
      );
      await t.rejects(() => server!.ready, /address already in use/);
      t.equal(attempts, 16, 'stops after the documented candidate limit');
      Socket.listen = listen;
      await server.close();
      for (const port of occupied.keys()) {
        const replacement = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port });
        replacement.close();
      }
    } finally {
      Socket.listen = listen;
      await server?.close();
      for (const fd of occupied.values()) close(fd);
    }
  });
});
