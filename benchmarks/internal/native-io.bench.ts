/**
 * Reactor-local socket transfer latency through the direct I/O provider.
 *
 * One loopback connection is reused per measurement. Each iteration consumes a
 * borrowed write allocation, receives every byte, and checks the byte count. Run an
 * optimized binary on an otherwise idle host; these are not comparative claims.
 */
import { bench } from 'fino:bench';
import { Socket } from 'fino:net/socket';

bench('reactor-local transfer', (b) => {
  for (const size of [64, 4096, 65536]) {
    b.measure(`${size} bytes`, {
      setup() {
        const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
        const sockets = Socket.connect(listener.address).then(async (client) => {
          const peer = await listener.accept();
          if (peer === null) throw new Error('missing accepted connection');
          const [, writer] = client.split();
          const [reader] = peer.split();
          return { client, peer, reader, writer };
        });
        return { listener, sockets };
      },
      async fn({ sockets }) {
        const { reader, writer } = await sockets;
        const written = writer.write(new Uint8Array(size)).then(() => writer.flush());
        const buffer = new Uint8Array(size);
        let remaining = size;
        while (remaining > 0) {
          const result = await reader.readInto(buffer.subarray(size - remaining));
          if (result.done || result.value === 0) throw new Error('unexpected EOF');
          remaining -= result.value;
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
