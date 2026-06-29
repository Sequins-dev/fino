import { QuicEndpoint } from 'fino:net/quic';
const enc = new TextEncoder();
const dec = new TextDecoder();
const endpoint = new QuicEndpoint({ alpnProtocols: ['hq-interop'] });
const conn = await endpoint.connect({
  address: {
    family: 'ipv4',
    ip: '127.0.0.1',
    port: 4444
  },
  alpnProtocols: ['hq-interop']
});
const stream = await conn.openBidirectionalStream();
await stream.writer.write(enc.encode('GET /echo\r\n'));
await stream.writer.close();
const chunks: Uint8Array[] = [];
for (;;) {
  const chunk = await stream.reader.read();
  if (chunk === null) break;
  chunks.push(chunk);
}
const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
const response = new Uint8Array(total);
let offset = 0;
for (const chunk of chunks) {
  response.set(chunk, offset);
  offset += chunk.byteLength;
}
console.log(dec.decode(response).trim());
await endpoint.close();
