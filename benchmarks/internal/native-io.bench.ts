/**
 * Native owned-buffer socket transfer latency, including allocation and admission.
 *
 * One loopback connection is reused per measurement. Each iteration consumes a
 * new write allocation, receives every byte, and checks the byte count. Run an
 * optimized binary on an otherwise idle host; these are not comparative claims.
 */
import { bench } from 'fino:bench';
import { Socket } from 'fino:net/socket';
import { readOwned, writeOwned } from 'internal:runtime/loop';

bench('native owned-buffer transfer', (b) => {
  for (const size of [64, 4096, 65536]) {
    b.measure(`${size} bytes`, {
      setup() {
        const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
        const sockets = Socket.connect(listener.address).then(async (client) => {
          const peer = await listener.accept();
          if (peer === null) throw new Error('missing accepted connection');
          return { client, peer };
        });
        return { listener, sockets };
      },
      async fn({ sockets }) {
        const { client, peer } = await sockets;
        const written = writeOwned(client.fd, new Uint8Array(size));
        let remaining = size;
        while (remaining > 0) {
          const bytes = await readOwned(peer.fd, remaining);
          if (bytes.byteLength === 0) throw new Error('unexpected EOF');
          remaining -= bytes.byteLength;
        }
        await written;
      },
      teardown({ listener, sockets }) {
        void sockets.then(({ client, peer }) => {
          client.close();
          peer.close();
        });
        listener.close();
      },
    });
  }
});
