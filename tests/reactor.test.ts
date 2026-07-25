/**
* Native reactor (`internal:runtime/loop` over `internal:reactor-native`).
*
* Part A drives the reactor directly in the main realm via `rloop.run`/`spin`
* (which pumps the reactor's own kqueue), exercising the native readiness,
* fused transfer, and timer paths with raw sockets.
*
* Part B proves a reactor realm runs a self-contained socket echo and timer,
* then self-exits so `realm.run()` resolves.
*/
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import * as rloop from 'internal:runtime/loop';
import * as sock from 'fino:net/socket';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: ArrayBuffer | ArrayBufferView) => new TextDecoder().decode(b);

function listenLoopback(): { fd: number; port: number } {
  const fd = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
  sock.setsockopt(fd, sock.SOL_SOCKET, sock.SO_REUSEADDR, true);
  sock.bind(fd, { family: 'ipv4', ip: '127.0.0.1', port: 0 });
  sock.listen(fd, 16);
  sock.setNonblocking(fd);
  const addr = sock.getsockname(fd);
  if (addr.family !== 'ipv4') throw new Error('expected ipv4 socket address');
  return { fd, port: addr.port };
}

describe('native reactor — direct drive', () => {
  it('resolves a timer', (t) => {
    let fired = false;
    rloop.run(async () => {
      await rloop.timeout(10);
      fired = true;
    });
    t.equal(fired, true, 'reactor timer resolved under spin');
  });

  it('echoes over TCP via readable/writable', (t) => {
    rloop.run(async () => {
      const server = listenLoopback();
      const clientFd = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
      sock.setNonblocking(clientFd);
      sock.connect(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: server.port });

      await rloop.readable(server.fd);
      const accepted = sock.accept(server.fd);
      if (accepted === null) throw new Error('accept returned null');
      const acceptedFd = accepted.fd;
      sock.setNonblocking(acceptedFd);

      await rloop.writable(clientFd);
      const errBuf = sock.getsockopt(clientFd, sock.SOL_SOCKET, sock.SO_ERROR);
      t.equal(new DataView(errBuf).getInt32(0, true), 0, 'connect succeeded');

      sock.send(clientFd, enc('hello, reactor!'), 0);
      await rloop.readable(acceptedFd);
      const got = sock.recv(acceptedFd, 256, 0);
      if (!(got instanceof Uint8Array)) throw new Error('recv did not return bytes');
      t.equal(dec(got), 'hello, reactor!', 'reactor delivered the message');

      sock.close(acceptedFd);
      sock.close(clientFd);
      sock.close(server.fd);
    });
  });

  it('echoes over TCP via fused readAsync/writeAsync', (t) => {
    rloop.run(async () => {
      const server = listenLoopback();
      const clientFd = sock.socket(sock.AF_INET, sock.SOCK_STREAM, 0);
      sock.setNonblocking(clientFd);
      sock.connect(clientFd, { family: 'ipv4', ip: '127.0.0.1', port: server.port });

      await rloop.readable(server.fd);
      const accepted = sock.accept(server.fd);
      if (accepted === null) throw new Error('accept returned null');
      const acceptedFd = accepted.fd;
      sock.setNonblocking(acceptedFd);
      await rloop.writable(clientFd);

      const payload = enc('fused transfer path');
      const wrote = await rloop.writeAsync(clientFd, payload, 0, payload.byteLength);
      t.equal(wrote, payload.byteLength, 'writeAsync drained the whole buffer');

      const buf = new Uint8Array(256);
      const n = await rloop.readAsync(acceptedFd, buf, 0, buf.byteLength);
      t.ok(n > 0, 'readAsync returned bytes');
      t.equal(dec(buf.subarray(0, n)), 'fused transfer path', 'fused round trip matched');

      sock.close(acceptedFd);
      sock.close(clientFd);
      sock.close(server.fd);
    });
  });
});

describe('native reactor — realm integration', () => {
  it('a realm runs on the reactor and self-exits', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/reactor-worker.ts', import.meta.url).pathname
    });
    await realm.run();
    t.ok(true, 'realm completed its socket echo + timer and exited');
  });
});
