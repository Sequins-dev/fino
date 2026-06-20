/**
 * Benchmarks for fino:net/quic.
 *
 * Run with: cargo run -- bench benchmarks/net/quic.bench.mts
 */

import {
  QuicEndpoint,
  __inspectQuicRuntimeTuning,
  quicAvailable,
  quicVersion,
} from 'fino:net/quic';
import { bench } from 'fino:bench';

bench('net/quic public surface', (b) => {
  b.measure('availability metadata', () => {
    void quicAvailable;
    void quicVersion;
  });

  b.measure('runtime tuning snapshot', () => __inspectQuicRuntimeTuning());

  b.measure('endpoint construct/close', () => {
    const endpoint = new QuicEndpoint({
      alpnProtocols: ['fino-hq'],
      connection: {
        maxIdleTimeoutMs: 2500,
        initialMaxData: 1024 * 1024,
        initialMaxStreamDataBidiLocal: 128 * 1024,
        initialMaxStreamDataBidiRemote: 128 * 1024,
        activeConnectionIdLimit: 4,
        cidLength: 12,
      },
      datagrams: { enabled: true, maxFrameSize: 1200, maxPending: 16 },
      transport: { ecn: true },
    });
    void endpoint.resolvedOptions;
    void endpoint.stats;
    endpoint.close();
  });

  b.measure('listen without cert rejects', async () => {
    const endpoint = new QuicEndpoint({ alpnProtocols: ['fino-bench'] });
    try {
      await endpoint.listen({ address: { family: 'ipv4', ip: '127.0.0.1', port: 0 } });
      throw new Error('QUIC listen without cert unexpectedly succeeded');
    } catch (err) {
      if (String((err as Error).message ?? err).includes('unexpectedly succeeded')) throw err;
    } finally {
      await endpoint.close();
    }
  });
});
