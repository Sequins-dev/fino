import { QuicEndpoint } from 'fino:net/quic';
import { argv } from 'fino:process';

const enc = new TextEncoder();
const dec = new TextDecoder();
const scenario = argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length) ?? 'h3';
const endpoint = new QuicEndpoint({ alpnProtocols: ['h3'] });

function requestLabel(data: Uint8Array | null): string {
  if (scenario === 'large') return `${data?.byteLength ?? 0}:${1024 * 1024}`;
  if (scenario === 'h3') return dec.decode(data!);
  return scenario;
}

const listener = await endpoint.listen({
  address: { family: 'ipv4', ip: '127.0.0.1', port: 0 },
  alpnProtocols: ['h3'],
  certificateFile: 'tests/net/fixtures/test.crt',
  privateKeyFile: 'tests/net/fixtures/test.key',
});

console.log(`ready ${JSON.stringify(listener.address)}`);

try {
  const connection = await endpoint.accept();
  if (scenario === 'keyupdate') connection.initiateKeyUpdate();
  const stream = await connection.acceptStream();
  const data = await stream.reader.read();
  const body = `fino:${connection.alpnProtocol}:${requestLabel(data)}`;
  await stream.writer.write(enc.encode(body));
  await stream.writer.close();
  await connection.close();
} finally {
  await endpoint.close();
}
