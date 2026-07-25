/**
* Realm entry for the reactor integration test. Every realm uses the
* reactor-backed `internal:runtime/loop`, so each timer and socket operation
* below runs on the native reactor. It performs a
* self-contained TCP echo plus a timer and then returns; if the reactor works,
* the realm goes idle and self-exits (its `run()` resolves in the parent).
*
* Uses only public APIs — a realm entry cannot import `internal:*` modules.
*/
import { Socket } from 'fino:net/socket';
import { DiskFileSystem } from 'fino:file';

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

// Timer through the runtime loop (setTimeout → loop.timeout → reactor).
await new Promise<void>((resolve) => setTimeout(resolve, 10));

// File read through the runtime loop (fino:file readiness rides the reactor).
const fs = new DiskFileSystem();
const selfBytes = await fs.readFile(new URL(import.meta.url).pathname);
if (selfBytes.byteLength === 0) throw new Error('reactor realm: file read returned no bytes');

const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
const address = server.address as Extract<typeof server.address, { family: 'ipv4' }>;
const client = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: address.port });
const serverConn = await server.accept();
if (serverConn === null) throw new Error('reactor realm: accept returned null');

const [serverReader, serverWriter] = serverConn.split();
const [clientReader, clientWriter] = client.split();

await clientWriter.write(enc('ping'));
clientWriter.close();
const received = await readAll(serverReader);
if (dec(received) !== 'ping') throw new Error(`reactor realm: expected 'ping', got '${dec(received)}'`);
serverReader.close();

await serverWriter.write(enc('pong'));
serverWriter.close();
const echoed = await readAll(clientReader);
if (dec(echoed) !== 'pong') throw new Error(`reactor realm: expected 'pong', got '${dec(echoed)}'`);
clientReader.close();

server.close();
