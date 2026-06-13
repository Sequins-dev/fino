/**
 * Bounded QUIC loopback bulk-transfer benchmark.
 * Evidence marker: QUIC loopback transfer benchmark.
 *
 * Run with:
 *   ./target/release/fino benchmarks/net/quic-loopback-transfer.bench.mts
 *
 * Optional:
 *   QUIC_BENCH_BYTES=8388608 ./target/release/fino benchmarks/net/quic-loopback-transfer.bench.mts
 *
 * Compare two binaries:
 *   QUIC_BENCH_BASELINE_BIN=./target/release/fino \
 *   QUIC_BENCH_CANDIDATE_BIN=./target/release/fino \
 *   ./target/release/fino benchmarks/net/quic-loopback-transfer.bench.mts
 */

import { env, Process } from 'fino:process';
import { QuicEndpoint, quicAvailable } from 'fino:net/quic';

const totalBytes = Math.max(1, Number(env.QUIC_BENCH_BYTES ?? 8 * 1024 * 1024));
const chunkBytes = 64 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function readAll(stream: Awaited<ReturnType<import('fino:net/quic').QuicConnection['acceptStream']>>): Promise<number> {
  let received = 0;
  for (;;) {
    const chunk = await stream.reader.read();
    if (chunk === null) return received;
    received += chunk.byteLength;
  }
}

async function collect(reader: AsyncIterable<Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of reader) out += dec.decode(chunk);
  return out;
}

async function runChild(label: string, binary: string): Promise<Record<string, unknown>> {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>;
  delete childEnv.QUIC_BENCH_BASELINE_BIN;
  delete childEnv.QUIC_BENCH_CANDIDATE_BIN;
  const proc = new Process(binary, ['benchmarks/net/quic-loopback-transfer.bench.mts'], { env: childEnv });
  proc.stdin.close();
  const stdout = collect(proc.stdout);
  const stderr = collect(proc.stderr);
  const status = await proc.wait();
  const out = (await stdout).trim();
  const err = (await stderr).trim();
  if (status.code !== 0) throw new Error(`${label} benchmark failed with exit ${status.code}${err.length > 0 ? `: ${err}` : ''}`);
  const line = out.split(/\r?\n/).filter((entry) => entry.trim().length > 0).at(-1);
  if (line === undefined) throw new Error(`${label} benchmark produced no JSON output`);
  return JSON.parse(line);
}

const baselineBin = env.QUIC_BENCH_BASELINE_BIN;
const candidateBin = env.QUIC_BENCH_CANDIDATE_BIN;

if (baselineBin !== undefined && baselineBin.length > 0 && candidateBin !== undefined && candidateBin.length > 0) {
  const [baseline, candidate] = await Promise.all([
    runChild('baseline', baselineBin),
    runChild('candidate', candidateBin),
  ]);
  const baselineRate = Number(baseline.mibPerSecond ?? 0);
  const candidateRate = Number(candidate.mibPerSecond ?? 0);
  console.log(JSON.stringify({
    skipped: false,
    comparison: true,
    baseline,
    candidate,
    ratio: baselineRate > 0 ? candidateRate / baselineRate : null,
  }));
} else if (!quicAvailable) {
  console.log(JSON.stringify({ skipped: true, reason: 'QUIC native libraries are unavailable' }));
} else {
  const server = new QuicEndpoint({
    alpnProtocols: ['fino-bench'],
    connection: {
      initialMaxData: totalBytes * 2,
      initialMaxStreamDataBidiLocal: totalBytes * 2,
      initialMaxStreamDataBidiRemote: totalBytes * 2,
    },
  });
  const client = new QuicEndpoint({
    alpnProtocols: ['fino-bench'],
    verifyPeer: false,
    connection: {
      initialMaxData: totalBytes * 2,
      initialMaxStreamDataBidiLocal: totalBytes * 2,
      initialMaxStreamDataBidiRemote: totalBytes * 2,
    },
  });

  try {
    const listener = await server.listen({
      address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
      certificateFile: 'tests/net/fixtures/test.crt',
      privateKeyFile: 'tests/net/fixtures/test.key',
    });
    const accepted = server.accept();
    const connected = client.connect({ address: listener.address, serverName: 'localhost' });
    const [clientConnection, serverConnection] = await Promise.all([connected, accepted]);
    const clientStream = await clientConnection.openBidirectionalStream();
    const serverStreamPromise = serverConnection.acceptStream();
    const payload = new Uint8Array(chunkBytes);
    for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff;

    const startedAt = Date.now();
    const writer = (async () => {
      let sent = 0;
      while (sent < totalBytes) {
        const n = Math.min(chunkBytes, totalBytes - sent);
        await clientStream.writer.write(n === payload.byteLength ? payload : payload.subarray(0, n));
        sent += n;
      }
      await clientStream.writer.close();
    })();
    const serverStream = await serverStreamPromise;
    const [received] = await Promise.all([readAll(serverStream), writer]);
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    if (received !== totalBytes) throw new Error(`QUIC benchmark received ${received} of ${totalBytes} bytes`);

    const mebibytes = received / (1024 * 1024);
    console.log(JSON.stringify({
      skipped: false,
      bytes: received,
      elapsedMs,
      mibPerSecond: mebibytes / (elapsedMs / 1000),
      chunkBytes,
      alpn: clientConnection.alpnProtocol,
      note: enc.encode('loopback client-to-server stream bulk transfer').byteLength,
    }));
    await clientConnection.close();
    await serverConnection.close();
  } finally {
    await client.close();
    await server.close();
  }
}
