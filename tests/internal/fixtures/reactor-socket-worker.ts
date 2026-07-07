/**
* Direct-socket-I/O tenant for the native reactor engine: within one isolate it
* listens, connects, accepts, and echoes over TCP — all readiness (connect
* writable, accept readable) and fused reads/writes route through the reactor
* engine. Terminating cleanly proves the full socket path works on the engine.
*/
import { Socket } from 'fino:net/socket';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: ArrayBuffer | ArrayBufferView) => new TextDecoder().decode(b);

async function readAll(reader: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of reader) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

export default async function socketWorker(): Promise<{ result: string; costMicros: number }> {
  const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
  const address = server.address as Extract<typeof server.address, { family: 'ipv4' }>;
  const client = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: address.port });
  const conn = await server.accept();
  if (conn === null) throw new Error('accept returned null');

  const [serverReader, serverWriter] = conn.split();
  const [clientReader, clientWriter] = client.split();

  await clientWriter.write(enc('ping'));
  clientWriter.close();
  const received = await readAll(serverReader);
  if (dec(received) !== 'ping') throw new Error(`expected 'ping', got '${dec(received)}'`);
  serverReader.close();

  await serverWriter.write(enc('pong'));
  serverWriter.close();
  const echoed = await readAll(clientReader);
  if (dec(echoed) !== 'pong') throw new Error(`expected 'pong', got '${dec(echoed)}'`);
  clientReader.close();

  server.close();
  return { result: 'terminated', costMicros: 1 };
}
