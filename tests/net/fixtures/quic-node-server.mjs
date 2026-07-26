import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { listen } from 'node:quic';
import { bytes } from 'stream/iter';
const enc = new TextEncoder();
const dec = new TextDecoder();
const key = createPrivateKey(readFileSync('tests/net/fixtures/test.key'));
const cert = readFileSync('tests/net/fixtures/test.crt');
const scenario =
  process.argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length) ?? 'h3';
const largePayload = 'x'.repeat(1024 * 1024);
function requestLabel(data) {
  if (scenario === 'large') return `${data.length}:${largePayload.length}`;
  if (scenario === 'h3') return dec.decode(data);
  return scenario;
}
const endpoint = await listen(
  async (session) => {
    const info = await session.opened;
    session.onstream = async (stream) => {
      const data = await bytes(stream);
      const body = `node:${info.protocol}:${requestLabel(data)}`;
      stream.writer.writeSync(enc.encode(body));
      stream.writer.endSync();
      await stream.closed;
      session.close();
      await endpoint.close();
    };
  },
  {
    address: '127.0.0.1',
    port: 0,
    alpn: ['h3', 'fino-hq'],
    sni: {
      '*': {
        keys: [key],
        certs: [cert],
      },
    },
  },
);
const address = endpoint.address;
console.log(
  `ready ${JSON.stringify({
    address: address.address ?? '127.0.0.1',
    port: address.port,
  })}`,
);
