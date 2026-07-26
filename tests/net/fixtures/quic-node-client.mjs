import { connect } from 'node:quic';
import { bytes } from 'stream/iter';
const enc = new TextEncoder();
const dec = new TextDecoder();
const port = Number(process.argv[2]);
const scenario =
  process.argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length) ?? 'h3';
if (!Number.isFinite(port) || port <= 0) throw new Error('missing Fino server port');
const alpn = scenario === 'alpn-mismatch' ? 'node-no-match' : 'h3';
try {
  const session = await connect(`127.0.0.1:${port}`, {
    alpn,
    servername: 'localhost',
    verifyPeer: 'manual',
  });
  const info = await session.opened;
  const stream = await session.createBidirectionalStream({
    body:
      scenario === 'large'
        ? new Uint8Array(1024 * 1024)
        : enc.encode(scenario === 'h3' ? 'from-node' : scenario),
  });
  const data = await bytes(stream);
  console.log(`client ${info.protocol} ${dec.decode(data)}`);
  await stream.closed;
  await session.close();
} catch (error) {
  if (scenario !== 'alpn-mismatch') throw error;
  console.log('client alpn-mismatch failed');
}
