import { QuicEndpoint } from 'fino:net/quic';

const enc = new TextEncoder();
const dec = new TextDecoder();

const endpoint = new QuicEndpoint({ alpnProtocols: ['hq-interop'] });
await endpoint.listen({
  address: { family: 'ipv4', ip: '127.0.0.1', port: 4445 },
  alpnProtocols: ['hq-interop'],
  certificateFile: 'tests/net/fixtures/test.crt',
  privateKeyFile: 'tests/net/fixtures/test.key',
});

console.log('ready');
const conn = await endpoint.accept();
const stream = await conn.acceptStream();
const chunks: Uint8Array[] = [];
for (;;) {
  const chunk = await stream.reader.read();
  if (chunk === null) break;
  chunks.push(chunk);
}

const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
const request = new Uint8Array(total);
let offset = 0;
for (const chunk of chunks) {
  request.set(chunk, offset);
  offset += chunk.byteLength;
}

console.log(dec.decode(request).trim());
await stream.writer.write(enc.encode('fino-hq-ok\n'));
await stream.writer.close();
await endpoint.close();
console.log('done');
